// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @dev Aave v3 Pool, the parts used here.
interface IAavePool {
    struct ReserveConfigurationMap { uint256 data; }
    struct ReserveDataLegacy {
        ReserveConfigurationMap configuration;
        uint128 liquidityIndex;
        uint128 currentLiquidityRate;
        uint128 variableBorrowIndex;
        uint128 currentVariableBorrowRate;
        uint128 currentStableBorrowRate;
        uint40 lastUpdateTimestamp;
        uint16 id;
        address aTokenAddress;
        address stableDebtTokenAddress;
        address variableDebtTokenAddress;
        address interestRateStrategyAddress;
        uint128 accruedToTreasury;
        uint128 unbacked;
        uint128 isolationModeTotalDebt;
    }
    function getReserveData(address asset) external view returns (ReserveDataLegacy memory);
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
    function getUserAccountData(address user)
        external
        view
        returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor);
}

/// @dev Compound v3 Comet, the parts used here.
interface IComet {
    function baseToken() external view returns (address);
    function getUtilization() external view returns (uint256);
    function getSupplyRate(uint256 utilization) external view returns (uint64);
    function balanceOf(address account) external view returns (uint256);
    function supplyTo(address dst, address asset, uint256 amount) external;
    function withdrawFrom(address src, address to, address asset, uint256 amount) external;
}

/// @dev An ERC-4626 vault (Spark sUSDC), the parts used here.
interface IVault {
    function asset() external view returns (address);
    function balanceOf(address owner) external view returns (uint256);
    function convertToAssets(uint256 shares) external view returns (uint256);
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256 shares);
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);
    function ssr() external view returns (uint256);
}

/// @dev Sky's Savings Rate oracle on L2s (Spark's rate provider).
interface ISsrOracle {
    function getSSR() external view returns (uint256);
}

/**
 * @title RektBull Yield Router
 * @notice The only contract a RektBull yield permission may call. It moves
 *         the caller's money (the user's own account) between the yield
 *         venues fixed at deployment, and enforces onchain, on every call:
 *           - positions are only ever opened for the caller, and withdrawals
 *             only ever pay the caller: no call can send funds anywhere else;
 *           - a move only goes to a venue for the same asset paying at least
 *             MIN_GAIN_BPS more, read from both venues' own contracts before
 *             and again after the move, and never above MAX_RATE (a venue in
 *             distress shows the highest rate);
 *           - a deposit only goes to a venue paying within MIN_GAIN_BPS of the
 *             best venue for that asset, before and after the deposit;
 *           - the fee is FEE_BPS (at most 0.1%) of what's deposited or moved,
 *             paid only to FEE_WALLET, at most once per account and asset per
 *             FEE_COOLDOWN: rates can be pushed within a transaction (a flash
 *             loan), so this, not the rate rule, is what caps what churning
 *             can cost a user (second AI audit, M-1). Withdrawals to the
 *             caller are free, and putting the same amount back within
 *             REDEPOSIT_WINDOW pays no fee;
 *           - an Aave withdrawal (or move out of Aave) that lowers the health
 *             factor of an account borrowing on Aave can't leave it below
 *             MIN_HEALTH_FACTOR, so a hacked RektBull can't push it toward
 *             liquidation;
 *           - at most one deposit or move per account per MIN_INTERVAL, and
 *             none above the caller's own per-asset limit or after the
 *             caller's expiry, which only the caller can set;
 *           - what the caller's new position is worth must be what went in,
 *             less MAX_LOSS_BPS at most;
 *           - nothing that comes into the router during a call stays there.
 *         Withdrawals to the caller are always allowed: getting out is never
 *         blocked by a limit, an expiry or a revoke.
 *
 *         There is no owner, no admin and no upgrade path.
 *
 *         Approvals the caller gives this router (the asset, the aToken, the
 *         vault's shares, Comet's allow) are only ever used for the caller's
 *         own calls: every pull is from msg.sender.
 */
contract RektBullYieldRouter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 public constant MAX_FEE_BPS = 10; // 0.1%: the most this router can ever charge
    uint16 public constant MAX_LOSS_BPS = 10; // what a deposit may lose to rounding or a vault's conversion
    uint256 private constant SECONDS_PER_YEAR = 31_536_000;
    /// @notice Putting back what was withdrawn through this router, within this long, pays no fee.
    uint256 public constant REDEPOSIT_WINDOW = 7 days;
    /// @notice At most one fee per account and asset per this long, however many deposits and moves.
    uint256 public constant FEE_COOLDOWN = 7 days;
    /// @notice No deposit or move into a venue paying more than this (APR, 18 decimals): 25%.
    uint256 public constant MAX_RATE = 0.25e18;
    /// @notice The lowest Aave health factor (1e18 = 1.0) a router-driven Aave exit may leave a borrowing account at.
    uint256 public constant MIN_HEALTH_FACTOR = 1.5e18;
    uint256 private constant RAY = 1e27;

    enum Kind { None, Aave, Comet, SparkL1, SparkL2 }

    struct Venue {
        Kind kind;
        address target; // the Aave pool, the Comet, or the vault
        address asset; // what it takes
        address position; // the token the position is held in (aToken, Comet, vault shares)
        address rateSource; // Spark on L2s: Sky's SSR oracle; otherwise unused
    }

    address public immutable FEE_WALLET;
    uint16 public immutable FEE_BPS;
    uint16 public immutable MIN_GAIN_BPS; // in basis points of APR: 100 = 1 percentage point
    uint32 public immutable MIN_INTERVAL; // seconds between fee-bearing calls per account

    Venue[] private venues;

    // ── Set by each user, for themselves only ─────────────────────────────

    mapping(address => uint64) public validUntil;
    mapping(address => mapping(address => uint256)) public maxPerMove; // account => asset => units
    mapping(address => uint256) public lastMoveAt;
    /// @notice account => asset => when a fee was last charged.
    mapping(address => mapping(address => uint256)) public lastFeeAt;
    /// @notice account => asset => what was withdrawn through this router and may be put back without a fee, and until when.
    mapping(address => mapping(address => uint256)) public redepositCredit;
    mapping(address => mapping(address => uint256)) public redepositUntil;

    event LimitsSet(address indexed account, address[] assets, uint256[] maxPerMove, uint64 validUntil);
    event Revoked(address indexed account);
    event Deposited(address indexed account, uint256 indexed venue, uint256 amount, uint256 fee);
    event Moved(address indexed account, uint256 indexed fromVenue, uint256 indexed toVenue, uint256 amount, uint256 fee, uint256 fromRate, uint256 toRate);
    event Withdrawn(address indexed account, uint256 indexed venue, uint256 amount);

    error BadConfig();
    error NoSuchVenue();
    error NotAllowed();
    error LimitsOff();
    error OverLimit(uint256 amount, uint256 limit);
    error TooSoon(uint256 nextAt);
    error NotBetter(uint256 fromRate, uint256 toRate);
    error PositionShort(uint256 got, uint256 expected);
    error NotBestVenue(uint256 rate, uint256 best);
    error UnsafeHealthFactor(uint256 healthFactor);
    error RateTooHigh(uint256 rate);

    constructor(address feeWallet, uint16 feeBps, uint16 minGainBps, uint32 minInterval, Venue[] memory list) {
        if (feeWallet == address(0) || feeBps > MAX_FEE_BPS || minGainBps == 0 || minInterval < 1 hours || list.length == 0) revert BadConfig();
        FEE_WALLET = feeWallet;
        FEE_BPS = feeBps;
        MIN_GAIN_BPS = minGainBps;
        MIN_INTERVAL = minInterval;
        for (uint256 i; i < list.length; ++i) {
            Venue memory v = list[i];
            if (v.kind == Kind.None || v.target == address(0) || v.asset == address(0) || v.position == address(0)) revert BadConfig();
            if (v.kind == Kind.SparkL2 && v.rateSource == address(0)) revert BadConfig();
            // Each venue is what it claims to be, read from the venue itself (second AI audit, I-1).
            if (v.kind == Kind.Aave) {
                if (IAavePool(v.target).getReserveData(v.asset).aTokenAddress != v.position) revert BadConfig();
            } else if (v.kind == Kind.Comet) {
                if (IComet(v.target).baseToken() != v.asset || v.position != v.target) revert BadConfig();
            } else if (IVault(v.target).asset() != v.asset || v.position != v.target) {
                revert BadConfig();
            }
            venues.push(v);
        }
    }

    function venueCount() external view returns (uint256) { return venues.length; }
    function venueAt(uint256 id) external view returns (Venue memory) { return _venue(id); }

    // ── The user's own limits ─────────────────────────────────────────────

    /// @notice Sets the caller's per-asset limits and expiry. A RektBull permission must not allow this method.
    function setLimits(address[] calldata assets, uint256[] calldata limits, uint64 until) external {
        if (assets.length != limits.length || assets.length == 0 || until <= block.timestamp) revert BadConfig();
        for (uint256 i; i < assets.length; ++i) maxPerMove[msg.sender][assets[i]] = limits[i];
        validUntil[msg.sender] = until;
        emit LimitsSet(msg.sender, assets, limits, until);
    }

    /// @notice Stops deposits and moves for the caller at once. Withdrawals to the caller still work.
    function revoke() external {
        validUntil[msg.sender] = 0;
        emit Revoked(msg.sender);
    }

    // ── Rates and positions, read from the venues themselves ──────────────

    /// @notice A venue's supply rate now, as an APR with 18 decimals (1e18 = 100% a year).
    function rateOf(uint256 id) public view returns (uint256) {
        Venue memory v = _venue(id);
        if (v.kind == Kind.Aave) return uint256(IAavePool(v.target).getReserveData(v.asset).currentLiquidityRate) / 1e9;
        if (v.kind == Kind.Comet) {
            IComet c = IComet(v.target);
            return uint256(c.getSupplyRate(c.getUtilization())) * SECONDS_PER_YEAR;
        }
        uint256 ssr = v.kind == Kind.SparkL1 ? IVault(v.target).ssr() : ISsrOracle(v.rateSource).getSSR();
        return ssr > RAY ? (ssr - RAY) * SECONDS_PER_YEAR / 1e9 : 0;
    }

    /// @notice What account's position in a venue is worth, in the asset's units.
    function positionOf(uint256 id, address account) public view returns (uint256) {
        Venue memory v = _venue(id);
        if (v.kind == Kind.Aave) return IERC20(v.position).balanceOf(account);
        if (v.kind == Kind.Comet) return IComet(v.target).balanceOf(account);
        return IVault(v.target).convertToAssets(IVault(v.target).balanceOf(account));
    }

    // ── What a permission may call ────────────────────────────────────────

    /// @notice Puts amount of the caller's idle asset into a venue, for the caller.
    function deposit(uint256 id, uint256 amount) external nonReentrant {
        address account = msg.sender;
        Venue memory v = _venue(id);
        uint256 start = IERC20(v.asset).balanceOf(address(this));
        _checkLimits(account, v.asset, amount);
        _checkBest(id, v.asset);
        IERC20(v.asset).safeTransferFrom(account, address(this), amount);
        // What was withdrawn through this router and is put back within the window pays no fee.
        uint256 free = block.timestamp < redepositUntil[account][v.asset] ? redepositCredit[account][v.asset] : 0;
        if (free > amount) free = amount;
        if (free > 0) redepositCredit[account][v.asset] -= free;
        uint256 fee = _takeFee(account, v.asset, amount - free);
        _depositFor(v, id, account, amount - fee);
        _checkBest(id, v.asset); // still the best (within MIN_GAIN_BPS) with this deposit in it
        emit Deposited(account, id, amount, fee);
        _assertUnchanged(v.asset, start);
    }

    /// @notice Moves amount (type(uint256).max: all) of the caller's position to a better-paying venue for the same asset.
    function move(uint256 fromId, uint256 toId, uint256 amount) external nonReentrant {
        address account = msg.sender;
        Venue memory from = _venue(fromId);
        Venue memory to = _venue(toId);
        if (fromId == toId || from.asset != to.asset) revert NotAllowed();
        uint256 fromRate = rateOf(fromId);
        uint256 toRate = rateOf(toId);
        _checkBetter(fromRate, toRate);
        amount = _held(fromId, account, amount);
        _checkLimits(account, from.asset, amount);

        uint256 start = IERC20(from.asset).balanceOf(address(this));
        _withdrawFrom(from, account, address(this), amount);
        uint256 received = IERC20(from.asset).balanceOf(address(this)) - start;
        uint256 fee = _takeFee(account, from.asset, received);
        _depositFor(to, toId, account, received - fee);
        // Still better after the move: a large move lowers the rate it lands in and raises the one it left
        // (second AI audit, L-1).
        _checkBetter(rateOf(fromId), rateOf(toId));
        emit Moved(account, fromId, toId, received, fee, fromRate, toRate);
        _assertUnchanged(from.asset, start);
    }

    /// @notice Withdraws amount (type(uint256).max: all) of the caller's position back to the caller. Free, and always allowed.
    function withdraw(uint256 id, uint256 amount) external nonReentrant {
        address account = msg.sender;
        Venue memory v = _venue(id);
        uint256 start = IERC20(v.asset).balanceOf(address(this));
        amount = _held(id, account, amount);
        uint256 paid = IERC20(v.asset).balanceOf(account);
        _withdrawFrom(v, account, account, amount);
        paid = IERC20(v.asset).balanceOf(account) - paid;
        // That much may be put back without a fee for REDEPOSIT_WINDOW (per asset, never more than came out).
        uint256 credit = block.timestamp < redepositUntil[account][v.asset] ? redepositCredit[account][v.asset] : 0;
        redepositCredit[account][v.asset] = credit + paid;
        redepositUntil[account][v.asset] = block.timestamp + REDEPOSIT_WINDOW;
        emit Withdrawn(account, id, amount);
        _assertUnchanged(v.asset, start);
    }

    // ── Inside ────────────────────────────────────────────────────────────

    function _venue(uint256 id) internal view returns (Venue memory) {
        if (id >= venues.length) revert NoSuchVenue();
        return venues[id];
    }

    /// @dev amount, or all of the position when it asks for more (type(uint256).max: all). Refuses an empty position.
    function _held(uint256 id, address account, uint256 amount) internal view returns (uint256) {
        uint256 held = positionOf(id, account);
        if (held == 0 || amount == 0) revert NotAllowed();
        return amount > held ? held : amount;
    }

    function _checkLimits(address account, address asset, uint256 amount) internal {
        if (validUntil[account] <= block.timestamp) revert LimitsOff();
        uint256 limit = maxPerMove[account][asset];
        if (amount == 0 || amount > limit) revert OverLimit(amount, limit);
        uint256 next = lastMoveAt[account] + MIN_INTERVAL;
        if (lastMoveAt[account] != 0 && block.timestamp < next) revert TooSoon(next);
        lastMoveAt[account] = block.timestamp;
    }

    /// @dev The best rate any venue for this asset pays right now. A venue whose rate can't be read is skipped,
    ///      so one broken rate source can't block deposits everywhere (second AI audit, I-3).
    function _bestRate(address asset) internal view returns (uint256 best) {
        for (uint256 i; i < venues.length; ++i) {
            if (venues[i].asset != asset) continue;
            try this.rateOf(i) returns (uint256 r) {
                if (r > best) best = r;
            } catch {}
        }
    }

    /// @dev A deposit's venue pays within MIN_GAIN_BPS of the best, and no more than MAX_RATE.
    function _checkBest(uint256 id, address asset) internal view {
        uint256 rate = rateOf(id);
        if (rate > MAX_RATE) revert RateTooHigh(rate);
        uint256 best = _bestRate(asset);
        if (rate + uint256(MIN_GAIN_BPS) * 1e14 < best) revert NotBestVenue(rate, best);
    }

    /// @dev A move's destination pays at least MIN_GAIN_BPS more than its source, and no more than MAX_RATE.
    function _checkBetter(uint256 fromRate, uint256 toRate) internal view {
        if (toRate > MAX_RATE) revert RateTooHigh(toRate);
        if (toRate < fromRate + uint256(MIN_GAIN_BPS) * 1e14) revert NotBetter(fromRate, toRate);
    }

    /// @dev FEE_BPS of amount, at most once per account and asset per FEE_COOLDOWN.
    function _takeFee(address account, address asset, uint256 amount) internal returns (uint256 fee) {
        if (amount == 0 || block.timestamp < lastFeeAt[account][asset] + FEE_COOLDOWN) return 0;
        fee = amount * FEE_BPS / 10_000;
        if (fee > 0) {
            lastFeeAt[account][asset] = block.timestamp;
            IERC20(asset).safeTransfer(FEE_WALLET, fee);
        }
    }

    /// @dev Deposits amount from this router into venue v for account, and checks the position grew by it.
    function _depositFor(Venue memory v, uint256 id, address account, uint256 amount) internal {
        uint256 before = positionOf(id, account);
        IERC20(v.asset).forceApprove(v.target, amount);
        if (v.kind == Kind.Aave) IAavePool(v.target).supply(v.asset, amount, account, 0);
        else if (v.kind == Kind.Comet) IComet(v.target).supplyTo(account, v.asset, amount);
        else IVault(v.target).deposit(amount, account);
        IERC20(v.asset).forceApprove(v.target, 0);
        uint256 grew = positionOf(id, account) - before;
        uint256 expected = amount * (10_000 - MAX_LOSS_BPS) / 10_000;
        if (grew < expected) revert PositionShort(grew, expected);
    }

    /// @dev Withdraws amount of account's position in venue v, paying `to` (the account, or this router mid-move).
    function _withdrawFrom(Venue memory v, address account, address to, uint256 amount) internal {
        if (v.kind == Kind.Aave) {
            // The aTokens come here first (the account approved this router for them), then exactly those are redeemed.
            (,,,,, uint256 hfBefore) = IAavePool(v.target).getUserAccountData(account);
            uint256 held = IERC20(v.position).balanceOf(address(this));
            IERC20(v.position).safeTransferFrom(account, address(this), amount);
            IAavePool(v.target).withdraw(v.asset, IERC20(v.position).balanceOf(address(this)) - held, to);
            // An account that borrows on Aave against this position must stay well clear of liquidation: a
            // withdrawal that lowers its health factor may not leave it under the floor. One that doesn't lower it
            // (the position backs nothing) always goes through (second AI audit, L-2).
            (, uint256 debt,,,, uint256 hf) = IAavePool(v.target).getUserAccountData(account);
            if (debt > 0 && hf < MIN_HEALTH_FACTOR && hf < hfBefore) revert UnsafeHealthFactor(hf);
        } else if (v.kind == Kind.Comet) {
            // Never more than the position: withdrawing more from Comet would borrow for the account.
            uint256 held = IComet(v.target).balanceOf(account);
            IComet(v.target).withdrawFrom(account, to, v.asset, amount > held ? held : amount);
        } else {
            IVault vault = IVault(v.target);
            if (amount >= vault.convertToAssets(vault.balanceOf(account))) vault.redeem(vault.balanceOf(account), to, account);
            else vault.withdraw(amount, to, account);
        }
    }

    function _assertUnchanged(address asset, uint256 start) internal view {
        // Nothing stays here: every unit that came in went to a venue, the fee wallet or the account.
        // (Measured against the start, so tokens someone sends this router can't block anyone.)
        if (IERC20(asset).balanceOf(address(this)) != start) revert NotAllowed();
    }
}
