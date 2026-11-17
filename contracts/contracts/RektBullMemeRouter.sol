// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
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
        uint256 minAmountOut; // the executor's own minimum for this fill, on top of the user's (sandwich protection)
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
        // A wrapped native is required: without one, stray native coin is sent back as native, and one wei sent to the
        // router could then block fills for a wallet that refuses native coin (re-review, N-2).
        if (feeWallet == address(0) || feeBps > MAX_FEE_BPS || venues.length == 0 || wrappedNative == address(0)) revert BadConfig();
        FEE_WALLET = feeWallet;
        FEE_BPS = feeBps;
        WRAPPED_NATIVE = IWrappedNative(wrappedNative);
        for (uint256 i; i < baseAssets.length; ++i) {
            if (baseAssets[i] == address(0)) revert BadConfig();
            isBase[baseAssets[i]] = true;
        }
        isBase[NATIVE] = true;
        // A venue is called with calldata anyone with an order of their own can choose, so a venue must never be a
        // token users approve to this router (second AI audit, M-1): refusing orders that trade a venue doesn't
        // protect approvals of it, since any order can name it as the venue (re-review, N-1). So a venue that
        // answers like a token (totalSupply or balanceOf) can't be listed at all. A venue that can pull from a
        // `from` it is given (Permit2-style) is just as dangerous and no call can tell it apart: the deployment's
        // venue list must be reviewed for that (docs/MEME_ROUTER.md, "Deploying").
        for (uint256 i; i < venues.length; ++i) {
            address v = venues[i];
            if (v == address(0) || v == NATIVE || v == wrappedNative || isBase[v] || _answersLikeAToken(v)) revert BadConfig();
            isVenue[v] = true;
        }
    }

    /// @dev True when `a` answers totalSupply() or balanceOf(this) with a word, as an ERC-20 does.
    function _answersLikeAToken(address a) private view returns (bool) {
        (bool ok, bytes memory out) = a.staticcall(abi.encodeWithSignature("totalSupply()"));
        if (ok && out.length >= 32) return true;
        (ok, out) = a.staticcall(abi.encodeWithSignature("balanceOf(address)", address(this)));
        return ok && out.length >= 32;
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

        // The fee, on the input unless the output is a base asset. On the input, it is set aside here and charged
        // after the trade on what the venue actually used, so unused input pays no fee.
        bool feeOnOutput = isBase[o.tokenOut];
        uint256 fee = 0;
        uint256 toTrade = feeOnOutput ? received : received - received * FEE_BPS / 10_000;

        // The trade, through the allowed venue.
        uint256 nativeBefore = address(this).balance;
        uint256 outBefore = _balance(o.tokenOut);
        _callVenue(o, f, toTrade);
        if (f.unwrapIn && address(this).balance > nativeBefore) {
            WRAPPED_NATIVE.deposit{value: address(this).balance - nativeBefore}(); // unused native, wrapped back
        }
        if (!feeOnOutput) {
            // fee = FEE_BPS of (used + fee): the same as before when the venue uses everything it was given.
            uint256 unused = IERC20(o.tokenIn).balanceOf(address(this)) - inBefore;
            fee = Math.min((received - unused) * FEE_BPS / (10_000 - FEE_BPS), unused);
            if (fee > 0) IERC20(o.tokenIn).safeTransfer(FEE_WALLET, fee);
        }
        amountOut = _balance(o.tokenOut) - outBefore;
        if (feeOnOutput) {
            fee = amountOut * FEE_BPS / 10_000;
            if (fee > 0) _send(o.tokenOut, FEE_WALLET, fee);
            amountOut -= fee;
        }

        // Everything goes back to the account: the output, and any input the venue didn't use.
        // The user's price is checked on what reaches the account, so a token that taxes transfers
        // can't leave the user below the minimum they signed.
        uint256 accountBefore = _balanceOf(o.tokenOut, account);
        _send(o.tokenOut, account, amountOut);
        amountOut = _balanceOf(o.tokenOut, account) - accountBefore;

        // At least the user's own limit price, pro rata for a part of the order.
        uint256 minimum = Math.mulDiv(o.minAmountOut, f.amountIn, o.amountIn, Math.Rounding.Ceil);
        if (f.minAmountOut > minimum) minimum = f.minAmountOut;
        if (amountOut < minimum) revert BelowLimit(amountOut, minimum);
        uint256 leftover = IERC20(o.tokenIn).balanceOf(address(this)) - inBefore;
        if (leftover > 0) IERC20(o.tokenIn).safeTransfer(account, leftover);
        // Native coin a venue handed back on a fill that doesn't pay out native (a rebate, a mistaken payment) goes
        // to the account too: the router holds nothing (second AI audit, L-2).
        // Wrapped where the chain has a wrapped native, so a stray wei can't block fills for wallets that refuse native coin.
        if (o.tokenOut != NATIVE && address(this).balance > 0) {
            uint256 stray = address(this).balance;
            if (address(WRAPPED_NATIVE) != address(0)) {
                WRAPPED_NATIVE.deposit{value: stray}();
                IERC20(address(WRAPPED_NATIVE)).safeTransfer(account, stray);
            } else {
                _send(NATIVE, account, stray);
            }
        }

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
        // The account's own key first, then EIP-1271: an account that gains code later (an EIP-7702 delegation) keeps
        // the orders its key signed (second AI audit, L-1).
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(h, signature);
        if (!(err == ECDSA.RecoverError.NoError && signer == o.account)
            && !SignatureChecker.isValidERC1271SignatureNow(o.account, h, signature)) revert BadSignature();
        // An order must name a price: with no minimum, it could be filled at any price at all.
        if (o.tokenIn == o.tokenOut || o.tokenIn == NATIVE || o.amountIn == 0 || o.minAmountOut == 0 || f.amountIn == 0) revert NotAllowed();
        if (!isVenue[f.venue] || !isVenue[f.spender] || isVenue[o.tokenIn] || isVenue[o.tokenOut]) revert NotAllowed();
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
        return _balanceOf(token, address(this));
    }

    function _balanceOf(address token, address who) internal view returns (uint256) {
        return token == NATIVE ? who.balance : IERC20(token).balanceOf(who);
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
