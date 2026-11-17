// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {RektBullTradeRouter} from "./RektBullTradeRouter.sol";

/// @dev The part of a Safe (v1.3+) this module uses.
interface ISafe {
    function execTransactionFromModuleReturnData(address to, uint256 value, bytes memory data, uint8 operation)
        external
        returns (bool success, bytes memory returnData);
    function isOwner(address owner) external view returns (bool);
}

/**
 * @title RektBull Safe Module
 * @notice Lets RektBull's session key trade for a Safe, and do nothing else.
 *
 *         The Safe's owners enable this module and call setSession (both are
 *         ordinary Safe transactions their threshold signs). After that, the
 *         named session key may ask this module to make the Safe call one
 *         function: the Trade Router's swap. Nothing else can be called, no
 *         value can be sent, and the call is never a delegatecall. The router
 *         then applies everything it applies to any caller: the Safe's own
 *         limits, output only back to the Safe, the fee at most 1%, the price
 *         near the reference.
 *
 *         The owners stop it at any time with revoke() (a Safe transaction), or
 *         any single owner with revokeFor(); RektBull's session key can give a
 *         session up with renounce(), or give up every session at once, for
 *         good, with retire() (if the key is ever at risk). A session also ends
 *         by itself after at most 30 days. Disabling the module pauses trading
 *         but does not end the session: re-enabling it before the session
 *         expires brings it back, so revoke() is the stop, not disabling alone.
 *         There is no owner or admin, and nothing can be upgraded.
 */
contract RektBullSafeModule {
    uint256 public constant MAX_SESSION = 30 days;
    uint8 private constant CALL = 0; // never DELEGATECALL (1)

    RektBullTradeRouter public immutable ROUTER;

    struct Session {
        address key;
        uint64 validUntil;
    }

    /// @notice safe => the session key allowed to trade for it, and until when.
    mapping(address => Session) public sessions;
    /// @notice Keys that gave up all their sessions for good (retire()): they can't trade, and can't be named again.
    mapping(address => bool) public retired;

    event SessionSet(address indexed safe, address indexed key, uint64 validUntil);
    event SessionRevoked(address indexed safe);
    event KeyRetired(address indexed key);

    error BadSession();
    error NotSessionKey();
    error SessionExpired();
    error SafeCallFailed(bytes reason);
    error NotAllowed();

    constructor(RektBullTradeRouter router) {
        if (address(router) == address(0)) revert BadSession();
        ROUTER = router;
    }

    /// @notice Called by the Safe itself (a Safe transaction): names the key that may trade for it.
    /// @dev Exact calldata only: a call forwarded by a Safe's fallback handler carries 20 extra bytes (the original
    ///      caller), so a Safe that mistakenly set this module as its fallback handler can't be given a session by
    ///      an outsider (second AI audit, L-2).
    function setSession(address key, uint64 validUntil) external {
        if (msg.data.length != 4 + 32 + 32) revert NotAllowed();
        if (key == address(0) || retired[key] || validUntil <= block.timestamp || validUntil > block.timestamp + MAX_SESSION) revert BadSession();
        sessions[msg.sender] = Session(key, validUntil);
        emit SessionSet(msg.sender, key, validUntil);
    }

    /// @notice Called by the Safe itself: stops trading at once.
    function revoke() external {
        if (msg.data.length != 4) revert NotAllowed();
        _end(msg.sender);
    }

    /// @notice Any single owner of `safe` stops trading at once, without gathering the Safe's threshold.
    /// @dev Exact calldata, as setSession: forwarded through a Safe's fallback handler, a nested Safe that owns `safe`
    ///      would otherwise let an outsider end `safe`'s session (re-review, N-1).
    function revokeFor(address safe) external {
        if (msg.data.length != 4 + 32) revert NotAllowed();
        if (!ISafe(safe).isOwner(msg.sender)) revert NotAllowed();
        _end(safe);
    }

    /// @notice The session key gives up its session for `safe`.
    function renounce(address safe) external {
        if (msg.data.length != 4 + 32) revert NotAllowed();
        if (sessions[safe].key != msg.sender) revert NotSessionKey();
        _end(safe);
    }

    /// @notice The caller, as a session key, gives up every session it has, for good, in one transaction: RektBull's
    ///         kill switch if its key is ever at risk. A retired key can't trade and can't be named again, even by a
    ///         setSession() signed earlier and still pending (re-review, N-2). It only ever removes power.
    function retire() external {
        retired[msg.sender] = true;
        emit KeyRetired(msg.sender);
    }

    /// @dev Ends a session; the event only when there was one (re-review, N-4).
    function _end(address safe) internal {
        if (sessions[safe].key == address(0)) return;
        delete sessions[safe];
        emit SessionRevoked(safe);
    }

    /// @notice The session key trades for `safe`: exactly one call, to the router's swap.
    function swap(address safe, RektBullTradeRouter.SwapParams calldata p) external returns (uint256 amountOut) {
        Session memory s = sessions[safe];
        if (s.key == address(0) || msg.sender != s.key || retired[s.key]) revert NotSessionKey();
        if (block.timestamp > s.validUntil) revert SessionExpired();
        (bool ok, bytes memory ret) = ISafe(safe).execTransactionFromModuleReturnData(
            address(ROUTER), 0, abi.encodeCall(RektBullTradeRouter.swap, (p)), CALL
        );
        if (!ok) revert SafeCallFailed(ret);
        amountOut = abi.decode(ret, (uint256));
    }
}
