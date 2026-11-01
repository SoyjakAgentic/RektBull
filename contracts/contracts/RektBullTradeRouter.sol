// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @dev Chainlink's aggregator interface, the part used here.
interface IPriceFeed {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/**
 * @title RektBull Trade Router
 * @notice The only contract a RektBull trading permission may call. It makes
 *         one swap for the caller (the user's own account) through an allowed
 *         exchange, and enforces onchain, on every trade:
 *           - the bought tokens go to the caller, and nowhere else;
 *           - the fee is FEE_BPS (at most 1%), paid only to FEE_WALLET;
 *           - the output is no worse than the Chainlink reference price by
 *             more than MAX_SLIPPAGE_BPS, so a bad price can't move value out;
 *           - the trade fits the caller's own limits (per trade, per period,
 *             expiry), which only the caller can set.
 *
 *         There is no owner, no admin and no upgrade path: every setting is
 *         fixed at deployment. Funds are only ever pulled from msg.sender, so
 *         one user's approval can never be used for another user's trade.
 *
 * @dev    Called through a MetaMask delegation, msg.sender is the user's
 *         EIP-7702 account (the delegator), not RektBull's session key.
 */
contract RektBullTradeRouter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Fixed at deployment ───────────────────────────────────────────────

    uint16 public constant MAX_FEE_BPS = 100; // 1%: the most this router can ever charge
    uint16 public constant MAX_SLIPPAGE_CAP_BPS = 500; // the widest price bound it can be deployed with
    uint256 public constant SEQUENCER_GRACE_PERIOD = 3600;
    uint256 private constant USD_DECIMALS = 8; // limits and values are in USD with 8 decimals

    address public immutable FEE_WALLET;
    uint16 public immutable FEE_BPS;
    uint16 public immutable MAX_SLIPPAGE_BPS;
    /// @notice Chainlink L2 sequencer uptime feed, or address(0) on L1.
    IPriceFeed public immutable SEQUENCER_UPTIME_FEED;

    mapping(address => bool) public isVenue; // exchange contracts a swap may call or approve
    mapping(address => IPriceFeed) public priceFeed; // token => Chainlink TOKEN/USD feed
    mapping(address => uint256) public maxPriceAge; // token => seconds before its price is stale

    // ── Set by each user, for themselves only ─────────────────────────────

    struct Limits {
        uint128 perTradeUsd; // 8 decimals
        uint128 perPeriodUsd; // 8 decimals
        uint32 periodSeconds;
        uint64 validUntil; // unix time; 0 means off
    }

    mapping(address => Limits) public limits;
    mapping(address => uint256) public periodStartedAt;
    mapping(address => uint256) public spentThisPeriodUsd;

    struct SwapParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn; // pulled from msg.sender, fee included
        uint256 minAmountOut; // from the quote; the oracle bound applies as well
        address venue; // the contract called
        address spender; // the contract approved to take tokenIn (often the venue itself)
        bytes venueCalldata;
        uint256 deadline;
    }

    event LimitsSet(address indexed account, uint128 perTradeUsd, uint128 perPeriodUsd, uint32 periodSeconds, uint64 validUntil);
    event Revoked(address indexed account);
    event Swapped(
        address indexed account,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 fee,
        uint256 amountOut,
        uint256 valueUsd
    );

    error BadConfig();
    error NotAllowed();
    error LimitsOff();
    error OverTradeLimit(uint256 valueUsd, uint256 limitUsd);
    error OverPeriodLimit(uint256 spentUsd, uint256 limitUsd);
    error NoPrice(address token);
    error StalePrice(address token);
    error SequencerDown();
    error Expired();
    error BelowMinimum(uint256 amountOut, uint256 minimum);
    error VenueFailed(bytes reason);

    constructor(
        address feeWallet,
        uint16 feeBps,
        uint16 maxSlippageBps,
        address sequencerUptimeFeed,
        address[] memory venues,
        address[] memory tokens,
        address[] memory feeds,
        uint256[] memory maxAges
    ) {
        if (feeWallet == address(0) || feeBps > MAX_FEE_BPS) revert BadConfig();
        if (maxSlippageBps == 0 || maxSlippageBps > MAX_SLIPPAGE_CAP_BPS) revert BadConfig();
        if (tokens.length != feeds.length || tokens.length != maxAges.length || venues.length == 0) revert BadConfig();
        FEE_WALLET = feeWallet;
        FEE_BPS = feeBps;
        MAX_SLIPPAGE_BPS = maxSlippageBps;
        SEQUENCER_UPTIME_FEED = IPriceFeed(sequencerUptimeFeed);
        for (uint256 i; i < venues.length; ++i) {
            if (venues[i] == address(0)) revert BadConfig();
            isVenue[venues[i]] = true;
        }
        for (uint256 i; i < tokens.length; ++i) {
            if (tokens[i] == address(0) || feeds[i] == address(0) || maxAges[i] == 0) revert BadConfig();
            priceFeed[tokens[i]] = IPriceFeed(feeds[i]);
            maxPriceAge[tokens[i]] = maxAges[i];
        }
    }

    // ── The user's own limits ─────────────────────────────────────────────

    /// @notice Sets the caller's limits. A RektBull permission must not allow this method.
    function setLimits(uint128 perTradeUsd, uint128 perPeriodUsd, uint32 periodSeconds, uint64 validUntil) external {
        if (perTradeUsd == 0 || perPeriodUsd < perTradeUsd || periodSeconds == 0 || validUntil <= block.timestamp) revert BadConfig();
        limits[msg.sender] = Limits(perTradeUsd, perPeriodUsd, periodSeconds, validUntil);
        periodStartedAt[msg.sender] = block.timestamp;
        spentThisPeriodUsd[msg.sender] = 0;
        emit LimitsSet(msg.sender, perTradeUsd, perPeriodUsd, periodSeconds, validUntil);
    }

    /// @notice Stops all trading for the caller at once.
    function revoke() external {
        delete limits[msg.sender];
        emit Revoked(msg.sender);
    }

    // ── Prices ────────────────────────────────────────────────────────────

    /// @notice The USD value (8 decimals) of amount of token, from its Chainlink feed.
    function valueUsd(address token, uint256 amount) public view returns (uint256) {
        (uint256 price, uint8 feedDecimals) = _price(token);
        uint8 tokenDecimals = IERC20Metadata(token).decimals();
        // amount * price, scaled from (tokenDecimals + feedDecimals) to 8 decimals
        return _scale(amount * price, uint256(tokenDecimals) + feedDecimals, USD_DECIMALS);
    }

    /// @notice How much of token is worth usd (8 decimals), from its Chainlink feed.
    function amountForUsd(address token, uint256 usd) public view returns (uint256) {
        (uint256 price, uint8 feedDecimals) = _price(token);
        uint8 tokenDecimals = IERC20Metadata(token).decimals();
        // tokens = usd / price, with usd at 8 decimals and price at feedDecimals
        return usd * (10 ** (uint256(tokenDecimals) + feedDecimals)) / (price * (10 ** USD_DECIMALS));
    }

    function _price(address token) internal view returns (uint256 price, uint8 feedDecimals) {
        IPriceFeed feed = priceFeed[token];
        if (address(feed) == address(0)) revert NoPrice(token);
        _checkSequencer();
        (, int256 answer,, uint256 updatedAt,) = feed.latestRoundData();
        if (answer <= 0) revert NoPrice(token);
        if (updatedAt == 0 || block.timestamp - updatedAt > maxPriceAge[token]) revert StalePrice(token);
        return (uint256(answer), feed.decimals());
    }

    function _checkSequencer() internal view {
        if (address(SEQUENCER_UPTIME_FEED) == address(0)) return;
        (, int256 answer, uint256 startedAt,,) = SEQUENCER_UPTIME_FEED.latestRoundData();
        // 0 = up, 1 = down; prices right after a restart aren't trusted yet.
        if (answer != 0 || startedAt == 0 || block.timestamp - startedAt <= SEQUENCER_GRACE_PERIOD) revert SequencerDown();
    }

    function _scale(uint256 v, uint256 fromDecimals, uint256 toDecimals) internal pure returns (uint256) {
        if (fromDecimals == toDecimals) return v;
        if (fromDecimals > toDecimals) return v / (10 ** (fromDecimals - toDecimals));
        return v * (10 ** (toDecimals - fromDecimals));
    }

    // ── The swap ──────────────────────────────────────────────────────────

    function swap(SwapParams calldata p) external nonReentrant returns (uint256 amountOut) {
        if (block.timestamp > p.deadline) revert Expired();
        if (!isVenue[p.venue] || !isVenue[p.spender] || p.tokenIn == p.tokenOut) revert NotAllowed();

        // 1. The caller's limits, valued at the reference price.
        uint256 usdIn = valueUsd(p.tokenIn, p.amountIn);
        _spend(msg.sender, usdIn);

        // 2. Take the input from the caller (only ever the caller), and the fee.
        IERC20 tokenIn = IERC20(p.tokenIn);
        IERC20 tokenOut = IERC20(p.tokenOut);
        uint256 inBefore = tokenIn.balanceOf(address(this));
        tokenIn.safeTransferFrom(msg.sender, address(this), p.amountIn);
        uint256 received = tokenIn.balanceOf(address(this)) - inBefore;
        uint256 fee = received * FEE_BPS / 10_000;
        if (fee > 0) tokenIn.safeTransfer(FEE_WALLET, fee);
        uint256 toTrade = received - fee;

        // 3. Trade through the allowed venue, with an approval for exactly this trade.
        uint256 outBefore = tokenOut.balanceOf(address(this));
        tokenIn.forceApprove(p.spender, toTrade);
        (bool ok, bytes memory reason) = p.venue.call(p.venueCalldata);
        if (!ok) revert VenueFailed(reason);
        tokenIn.forceApprove(p.spender, 0);
        amountOut = tokenOut.balanceOf(address(this)) - outBefore;

        // 4. The output must be near the reference price, and at least the quote's minimum.
        uint256 fair = amountForUsd(p.tokenOut, valueUsd(p.tokenIn, toTrade));
        uint256 minimum = fair * (10_000 - MAX_SLIPPAGE_BPS) / 10_000;
        if (p.minAmountOut > minimum) minimum = p.minAmountOut;
        if (amountOut < minimum) revert BelowMinimum(amountOut, minimum);

        // 5. Everything goes back to the caller: the output, and any input the venue didn't use.
        tokenOut.safeTransfer(msg.sender, amountOut);
        uint256 leftover = tokenIn.balanceOf(address(this)) - inBefore;
        if (leftover > 0) tokenIn.safeTransfer(msg.sender, leftover);

        emit Swapped(msg.sender, p.tokenIn, p.tokenOut, p.amountIn, fee, amountOut, usdIn);
    }

    function _spend(address account, uint256 usd) internal {
        Limits memory l = limits[account];
        if (l.validUntil == 0 || block.timestamp > l.validUntil) revert LimitsOff();
        if (usd > l.perTradeUsd) revert OverTradeLimit(usd, l.perTradeUsd);
        if (block.timestamp >= periodStartedAt[account] + l.periodSeconds) {
            periodStartedAt[account] = block.timestamp;
            spentThisPeriodUsd[account] = 0;
        }
        uint256 spent = spentThisPeriodUsd[account] + usd;
        if (spent > l.perPeriodUsd) revert OverPeriodLimit(spent, l.perPeriodUsd);
        spentThisPeriodUsd[account] = spent;
    }
}
