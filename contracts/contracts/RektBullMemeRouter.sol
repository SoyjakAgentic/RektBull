// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @dev The wrapped native coin (WETH, WBNB), the part used here.
interface IWrappedNative {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

/**
 * @title RektBull Meme Router
 * @notice Fills orders the user signed, for tokens that have no Chainlink price (meme coins).
 *         The Trade Router bounds each trade by a Chainlink price; here the bound is the
 *         user's own: every order names, and the user signs (EIP-712; a contract wallet
 *         through EIP-1271):
 *           - the account it trades for, and the only executor allowed to fill it
 *             (RektBull's trade key);
 *           - the token to sell and the token to buy;
 *           - how much may be sold in all (filled in one go or in parts), and the least
 *             that much must bring back: a limit price, after RektBull's fee;
 *           - when it may be filled (from, until).
 *         On every fill, onchain:
 *           - the input is pulled only from the order's account, and only up to the order's size;
 *           - the output (and any input the exchange didn't use) goes only to that account;
 *           - the output is at least the user's own limit price, pro rata for a partial fill,
 *             so a bad price, a sandwich or an exchange paying someone else can't move value out;
 *           - the fee is FEE_BPS (at most 1%), paid only to FEE_WALLET, taken on the side of a
 *             base asset (the output when it is one, else the input);
 *           - only exchanges fixed at deployment are called.
 *         A user stops an order with cancel(), or every order at once with cancelAll().
 *
 *         The worst a hacked RektBull can do is fill an order at the price its user signed,
 *         at a time of its choosing within the order's window. A stop-loss is an order to sell
 *         at a floor: it may be filled at that floor while the market is higher.
 *
 *         There is no owner, no admin and no upgrade path: every setting is fixed at deployment.
 *         The router holds nothing between transactions; users approve it for the tokens they
 *         place orders on, and it can only use an approval to fill that account's own orders.
 */
contract RektBullMemeRouter is ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    // ── Fixed at deployment ───────────────────────────────────────────────

    uint16 public constant MAX_FEE_BPS = 100; // 1%: the most this router can ever charge
    /// @notice Stands for the native coin (ETH, BNB) as an order's output.
    address public constant NATIVE = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    address public immutable FEE_WALLET;
    uint16 public immutable FEE_BPS;
    /// @notice The chain's wrapped native coin, or address(0) where no exchange needs native input.
    IWrappedNative public immutable WRAPPED_NATIVE;

    mapping(address => bool) public isVenue; // exchange contracts a fill may call or approve
    mapping(address => bool) public isBase; // assets the fee is taken in when they're the output

    bytes32 public constant ORDER_TYPEHASH = keccak256(
        "Order(address account,address executor,address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,uint64 validAfter,uint64 validUntil,uint64 epoch,uint256 salt)"
    );

    struct Order {
        address account; // whose order: the input comes from it and the output goes to it
        address executor; // the only address that may fill it
        address tokenIn;
        address tokenOut; // NATIVE for the native coin
        uint256 amountIn; // the most that may be sold, over all fills
        uint256 minAmountOut; // the least selling all of amountIn must bring back, after the fee
        uint64 validAfter;
        uint64 validUntil;
        uint64 epoch; // must equal the account's current epoch; cancelAll() moves it on
        uint256 salt;
    }

    struct Fill {
        uint256 amountIn; // this fill's share of the order
        address venue; // the contract called
        address spender; // the contract approved to take the input (often the venue itself)
        bytes venueCalldata;
        bool unwrapIn; // the input is the wrapped native coin, sent to the venue as native
    }

    // ── Set by each user, for themselves only ─────────────────────────────

    mapping(address => uint64) public epochOf;
    mapping(bytes32 => bool) public cancelled;
    mapping(bytes32 => uint256) public filled; // order hash => amountIn sold so far

    event Filled(
        bytes32 indexed orderHash,
        address indexed account,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 fee,
        bool feeOnOutput,
        uint256 amountOut
    );
    event Cancelled(address indexed account, bytes32 indexed orderHash);
    event AllCancelled(address indexed account, uint64 newEpoch);

    error BadConfig();
    error NotExecutor();
    error NotAllowed();
    error NotYetValid();
    error Expired();
    error OrderCancelled();
    error BadSignature();
    error Overfilled(uint256 filled, uint256 amountIn);
    error BelowLimit(uint256 amountOut, uint256 minimum);
    error VenueFailed(bytes reason);
    error NativeTransferFailed();

    constructor(address feeWallet, uint16 feeBps, address wrappedNative, address[] memory venues, address[] memory baseAssets)
        EIP712("RektBull Meme Router", "1")
    {
        if (feeWallet == address(0) || feeBps > MAX_FEE_BPS || venues.length == 0) revert BadConfig();
        FEE_WALLET = feeWallet;
        FEE_BPS = feeBps;
        WRAPPED_NATIVE = IWrappedNative(wrappedNative);
        for (uint256 i; i < venues.length; ++i) {
            if (venues[i] == address(0) || venues[i] == NATIVE) revert BadConfig();
            isVenue[venues[i]] = true;
        }
        for (uint256 i; i < baseAssets.length; ++i) {
            if (baseAssets[i] == address(0)) revert BadConfig();
            isBase[baseAssets[i]] = true;
        }
        isBase[NATIVE] = true;
    }

    /// @dev Native coin arrives from the wrapped native contract (unwrapping) and from venues (a sale for native).
    receive() external payable {}

    // ── The user's own controls ───────────────────────────────────────────

    /// @notice The EIP-712 hash of an order: what its account signs, and what fills and cancels are keyed by.
    function hashOrder(Order calldata o) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    ORDER_TYPEHASH, o.account, o.executor, o.tokenIn, o.tokenOut, o.amountIn, o.minAmountOut,
                    o.validAfter, o.validUntil, o.epoch, o.salt
                )
            )
        );
    }

    /// @notice Cancels one of the caller's own orders.
    function cancel(Order calldata o) external {
        if (msg.sender != o.account) revert NotAllowed();
        bytes32 h = hashOrder(o);
        cancelled[h] = true;
        emit Cancelled(msg.sender, h);
    }

    /// @notice Cancels every order the caller has signed so far.
    function cancelAll() external {
        uint64 next = epochOf[msg.sender] + 1;
        epochOf[msg.sender] = next;
        emit AllCancelled(msg.sender, next);
    }

    // ── Filling an order ──────────────────────────────────────────────────

    /// @notice Fills part or all of an order, through an allowed exchange, for the order's account.
    function fill(Order calldata o, bytes calldata signature, Fill calldata f)
        external
        nonReentrant
        returns (uint256 amountOut)
    {
        bytes32 h = _checkOrder(o, signature, f);
        address account = o.account;

        // The input, from the order's account only.
        uint256 inBefore = IERC20(o.tokenIn).balanceOf(address(this));
        IERC20(o.tokenIn).safeTransferFrom(account, address(this), f.amountIn);
        uint256 received = IERC20(o.tokenIn).balanceOf(address(this)) - inBefore;

        // The fee, on the input unless the output is a base asset.
        bool feeOnOutput = isBase[o.tokenOut];
        uint256 fee = 0;
        if (!feeOnOutput) {
            fee = received * FEE_BPS / 10_000;
            if (fee > 0) IERC20(o.tokenIn).safeTransfer(FEE_WALLET, fee);
        }
        uint256 toTrade = received - fee;

        // The trade, through the allowed venue.
        uint256 nativeBefore = address(this).balance;
        uint256 outBefore = _balance(o.tokenOut);
        _callVenue(o, f, toTrade);
        amountOut = _balance(o.tokenOut) - outBefore;
        if (feeOnOutput) {
            fee = amountOut * FEE_BPS / 10_000;
            if (fee > 0) _send(o.tokenOut, FEE_WALLET, fee);
            amountOut -= fee;
        }

        // At least the user's own limit price, pro rata for a part of the order.
        uint256 minimum = Math.mulDiv(o.minAmountOut, f.amountIn, o.amountIn, Math.Rounding.Ceil);
        if (amountOut < minimum) revert BelowLimit(amountOut, minimum);

        // Everything goes back to the account: the output, and any input the venue didn't use.
        _send(o.tokenOut, account, amountOut);
        if (f.unwrapIn && address(this).balance > nativeBefore) {
            WRAPPED_NATIVE.deposit{value: address(this).balance - nativeBefore}(); // unused native, wrapped back
        }
        uint256 leftover = IERC20(o.tokenIn).balanceOf(address(this)) - inBefore;
        if (leftover > 0) IERC20(o.tokenIn).safeTransfer(account, leftover);

        emit Filled(h, account, o.tokenIn, o.tokenOut, f.amountIn, fee, feeOnOutput, amountOut);
    }

    /// @dev Everything checked before any funds move: the executor, the window, the signature, the size, the venue.
    function _checkOrder(Order calldata o, bytes calldata signature, Fill calldata f) internal returns (bytes32 h) {
        if (msg.sender != o.executor) revert NotExecutor();
        if (block.timestamp < o.validAfter) revert NotYetValid();
        if (block.timestamp > o.validUntil) revert Expired();
        if (o.epoch != epochOf[o.account]) revert OrderCancelled();
        h = hashOrder(o);
        if (cancelled[h]) revert OrderCancelled();
        if (!SignatureChecker.isValidSignatureNow(o.account, h, signature)) revert BadSignature();
        // An order must name a price: with no minimum, it could be filled at any price at all.
        if (o.tokenIn == o.tokenOut || o.tokenIn == NATIVE || o.amountIn == 0 || o.minAmountOut == 0 || f.amountIn == 0) revert NotAllowed();
        if (!isVenue[f.venue] || !isVenue[f.spender]) revert NotAllowed();
        if (f.unwrapIn && (address(WRAPPED_NATIVE) == address(0) || o.tokenIn != address(WRAPPED_NATIVE) || o.tokenOut == NATIVE)) {
            revert NotAllowed();
        }
        uint256 done = filled[h] + f.amountIn;
        if (done > o.amountIn) revert Overfilled(done, o.amountIn);
        filled[h] = done;
    }

    function _callVenue(Order calldata o, Fill calldata f, uint256 toTrade) internal {
        bool ok;
        bytes memory reason;
        if (f.unwrapIn) {
            WRAPPED_NATIVE.withdraw(toTrade);
            (ok, reason) = f.venue.call{value: toTrade}(f.venueCalldata);
        } else {
            IERC20(o.tokenIn).forceApprove(f.spender, toTrade);
            (ok, reason) = f.venue.call(f.venueCalldata);
            IERC20(o.tokenIn).forceApprove(f.spender, 0);
        }
        if (!ok) revert VenueFailed(reason);
    }

    function _balance(address token) internal view returns (uint256) {
        return token == NATIVE ? address(this).balance : IERC20(token).balanceOf(address(this));
    }

    function _send(address token, address to, uint256 amount) internal {
        if (amount == 0) return;
        if (token == NATIVE) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert NativeTransferFailed();
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }
}
