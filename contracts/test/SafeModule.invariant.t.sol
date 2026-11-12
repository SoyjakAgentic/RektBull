// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {RektBullSafeModule} from "../contracts/RektBullSafeModule.sol";
import {RektBullTradeRouter} from "../contracts/RektBullTradeRouter.sol";
import {MockSafe} from "../contracts/test/YieldMocks.sol";

/**
 * Drives the Safe Module with random sequences: Safe owners setting and revoking sessions, enabling and
 * disabling the module, time passing, and calls to swap() from the session key, an attacker and the Safe
 * itself, for its own Safe and for others. The stand-in Safe records every call the module made it make.
 */
contract SafeModuleHandler is Test {
    RektBullSafeModule public module;
    address public router;
    MockSafe[2] public safes;
    address public key = address(0x5E55);
    address public attacker = address(0xBAD);

    uint256 public okCalls;
    uint256 public unauthorizedSuccesses; // a swap by anyone but the Safe's live session key that went through: must stay 0

    constructor(RektBullSafeModule m, address r, MockSafe s0, MockSafe s1) {
        module = m; router = r; safes[0] = s0; safes[1] = s1;
    }

    function setSession(uint256 s, bool otherKey, uint256 days_) external {
        MockSafe safe = safes[bound(s, 0, 1)];
        uint64 until = uint64(block.timestamp + bound(days_, 1, 30) * 1 days);
        try safe.ownerCall(address(module), abi.encodeCall(RektBullSafeModule.setSession, (otherKey ? address(0xC0FFEE) : key, until))) {} catch {}
    }

    function revoke(uint256 s) external { safes[bound(s, 0, 1)].ownerCall(address(module), abi.encodeCall(RektBullSafeModule.revoke, ())); }

    function toggleModule(uint256 s, bool on) external {
        MockSafe safe = safes[bound(s, 0, 1)];
        if (on) safe.enableModule(address(module)); else safe.disableModule(address(module));
    }

    function wait(uint256 secs) external { vm.warp(block.timestamp + bound(secs, 1, 10 days)); }

    function swap(uint256 s, uint256 who, uint256 amount) external {
        MockSafe safe = safes[bound(s, 0, 1)];
        who = bound(who, 0, 2);
        address caller = who == 0 ? key : who == 1 ? attacker : address(safe);
        (address sk, uint64 until) = module.sessions(address(safe));
        bool allowed = caller == sk && sk != address(0) && block.timestamp <= until && safe.moduleEnabled(address(module));
        RektBullTradeRouter.SwapParams memory p;
        p.amountIn = amount;
        vm.prank(caller);
        try module.swap(address(safe), p) returns (uint256) {
            okCalls++;
            if (!allowed) unauthorizedSuccesses++;
        } catch {}
    }
}

contract SafeModuleInvariantTest is Test {
    RektBullSafeModule module;
    SafeModuleHandler handler;
    MockSafe s0;
    MockSafe s1;
    address router = address(0x7EAD);

    function setUp() public {
        vm.warp(1_800_000_000);
        module = new RektBullSafeModule(RektBullTradeRouter(router));
        s0 = new MockSafe();
        s1 = new MockSafe();
        s0.enableModule(address(module));
        s1.enableModule(address(module));
        handler = new SafeModuleHandler(module, router, s0, s1);
        targetContract(address(handler));
    }

    function test_handlerWorks() public {
        handler.setSession(0, false, 7);
        handler.swap(0, 0, 1); // the session key: goes through
        handler.swap(0, 1, 1); // the attacker: refused
        handler.swap(1, 0, 1); // the key, for a Safe that named no session: refused
        assertEq(handler.okCalls(), 1);
        handler.wait(8 days);
        handler.swap(0, 0, 1); // expired: refused
        assertEq(handler.okCalls(), 1);
    }

    /// Only the Safe's own live session key ever got a call through.
    function invariant_onlySessionKey() public view { assertEq(handler.unauthorizedSuccesses(), 0); }

    /// Every call the module made a Safe make was the router's swap: no value, never a delegatecall.
    function invariant_onlyRouterSwap() public view {
        MockSafe[2] memory safes = [s0, s1];
        for (uint256 j; j < 2; ++j) {
            uint256 n = safes[j].callCount();
            for (uint256 i; i < n; ++i) {
                (address to, uint256 value, bytes4 selector, uint8 operation, address m) = safes[j].calls(i);
                assertEq(to, router);
                assertEq(value, 0);
                assertEq(selector, RektBullTradeRouter.swap.selector);
                assertEq(operation, 0);
                assertEq(m, address(module));
            }
        }
    }

    /// No session ever lasts more than 30 days from when it's checked.
    function invariant_sessionAtMost30Days() public view {
        MockSafe[2] memory safes = [s0, s1];
        for (uint256 j; j < 2; ++j) {
            (, uint64 until) = module.sessions(address(safes[j]));
            if (until != 0 && until > block.timestamp) assertLe(until - block.timestamp, 30 days);
        }
    }
}
