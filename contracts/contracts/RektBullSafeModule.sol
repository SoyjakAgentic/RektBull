// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {RektBullTradeRouter} from "./RektBullTradeRouter.sol";

/// @dev The part of a Safe (v1.3+) this module uses.
interface ISafe {
    function execTransactionFromModuleReturnData(address to, uint256 value, bytes memory data, uint8 operation)
        external
        returns (bool success, bytes memory returnData);
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
 *         The owners stop it at any time with revoke() or by disabling the
 *         module; a session also ends by itself after at most 30 days. There
 *         is no owner or admin, and nothing can be upgraded.
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

    event SessionSet(address indexed safe, address indexed key, uint64 validUntil);
    event SessionRevoked(address indexed safe);

    error BadSession();
    error NotSessionKey();
    error SessionExpired();
    error SafeCallFailed(bytes reason);

    constructor(RektBullTradeRouter router) {
        if (address(router) == address(0)) revert BadSession();
        ROUTER = router;
    }

    /// @notice Called by the Safe itself (a Safe transaction): names the key that may trade for it.
    function setSession(address key, uint64 validUntil) external {
        if (key == address(0) || validUntil <= block.timestamp || validUntil > block.timestamp + MAX_SESSION) revert BadSession();
        sessions[msg.sender] = Session(key, validUntil);
        emit SessionSet(msg.sender, key, validUntil);
    }

    /// @notice Called by the Safe itself: stops trading at once.
    function revoke() external {
        delete sessions[msg.sender];
        emit SessionRevoked(msg.sender);
    }

    /// @notice The session key trades for `safe`: exactly one call, to the router's swap.
    function swap(address safe, RektBullTradeRouter.SwapParams calldata p) external returns (uint256 amountOut) {
        Session memory s = sessions[safe];
        if (s.key == address(0) || msg.sender != s.key) revert NotSessionKey();
        if (block.timestamp > s.validUntil) revert SessionExpired();
        (bool ok, bytes memory ret) = ISafe(safe).execTransactionFromModuleReturnData(
            address(ROUTER), 0, abi.encodeCall(RektBullTradeRouter.swap, (p)), CALL
        );
        if (!ok) revert SafeCallFailed(ret);
        amountOut = abi.decode(ret, (uint256));
    }
}
