// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {RektBullYieldRouter} from "../contracts/RektBullYieldRouter.sol";
import {MockERC20} from "../contracts/test/Mocks.sol";
import {MockVault4626, MockSsrOracle} from "../contracts/test/YieldMocks.sol";

/**
 * Drives the Yield Router with random sequences on two ERC-4626 vaults for the same asset:
 * users setting limits and revoking, deposits, moves and withdrawals by the session key (which acts as
 * the account, as through a delegation), rates changing, interest accruing, and time passing. Records
 * what each successful call did, for the invariants below. (Aave and Compound paths are covered by
 * yieldRouter.test.js on a copy of Base.)
 */
contract YieldHandler is Test {
    RektBullYieldRouter public router;
    MockERC20 public usdc;
    MockVault4626[2] public vaults;
    MockSsrOracle[2] public oracles;
    address public feeWallet;
    address[3] public users = [address(0xA1), address(0xA2), address(0xA3)];

    uint256 public feesPaid; // what the fee wallet received, summed
    uint256 public feeBase; // amounts deposited or moved (received), summed
    uint256 public valueLostBeyondAllowed; // value a user lost beyond the fee and MAX_LOSS_BPS: must stay 0
    uint256 public worseMoves; // moves into a venue paying less than MIN_GAIN_BPS more: must stay 0
    uint256 public intervalBreaks; // fee-bearing calls closer than MIN_INTERVAL: must stay 0
    uint256 public blockedWithdrawals; // withdrawals of a held position that failed: must stay 0
    uint256 public calls;
    mapping(address => uint256) public lastFeeCallAt;

    constructor(RektBullYieldRouter r, MockERC20 u, MockVault4626 v0, MockVault4626 v1, MockSsrOracle o0, MockSsrOracle o1, address fw) {
        router = r; usdc = u; vaults[0] = v0; vaults[1] = v1; oracles[0] = o0; oracles[1] = o1; feeWallet = fw;
        address[] memory assets = new address[](1);
        assets[0] = address(u);
        uint256[] memory limits = new uint256[](1);
        limits[0] = 1e12; // 1,000,000 USDC a move
        for (uint256 i; i < 3; ++i) {
            u.mint(users[i], 1e13);
            vm.startPrank(users[i]);
            u.approve(address(r), type(uint256).max);
            v0.approve(address(r), type(uint256).max);
            v1.approve(address(r), type(uint256).max);
            r.setLimits(assets, limits, uint64(block.timestamp + 365 days));
            vm.stopPrank();
        }
    }

    function _value(address u) public view returns (uint256) {
        return usdc.balanceOf(u) + vaults[0].convertToAssets(vaults[0].balanceOf(u)) + vaults[1].convertToAssets(vaults[1].balanceOf(u));
    }

    function _lossCheck(address u, uint256 before, uint256 fee, uint256 amount) internal {
        uint256 afterValue = _value(u);
        // + the vaults' own rounding: a withdrawal rounds the shares burned up, a deposit the shares minted down,
        // by at most one share unit each (worth a tiny fraction of a cent with 18-decimal shares); that value stays
        // in the vault, it goes to no one.
        uint256 allowed = fee + amount * router.MAX_LOSS_BPS() / 10_000 + 2 * (vaults[0].convertToAssets(1) + vaults[1].convertToAssets(1)) + 4;
        if (before > afterValue && before - afterValue > allowed) valueLostBeyondAllowed++;
    }

    function _interval(address u) internal {
        if (lastFeeCallAt[u] != 0 && block.timestamp < lastFeeCallAt[u] + router.MIN_INTERVAL()) intervalBreaks++;
        lastFeeCallAt[u] = block.timestamp;
    }

    function setLimits(uint256 who, uint256 max, uint256 days_) external {
        address u = users[bound(who, 0, 2)];
        address[] memory assets = new address[](1);
        assets[0] = address(usdc);
        uint256[] memory limits = new uint256[](1);
        limits[0] = bound(max, 0, 1e12);
        vm.prank(u);
        router.setLimits(assets, limits, uint64(block.timestamp + bound(days_, 1, 60) * 1 days));
    }

    function revoke(uint256 who) external {
        vm.prank(users[bound(who, 0, 2)]);
        router.revoke();
    }

    function setRate(uint256 v, uint256 aprBps) external {
        aprBps = bound(aprBps, 0, 2_000); // 0% to 20% a year
        oracles[bound(v, 0, 1)].set(1e27 + aprBps * 1e14 * 1e9 / 31_536_000);
    }

    function accrue(uint256 v, uint256 amount) external {
        MockVault4626 vault = vaults[bound(v, 0, 1)];
        if (vault.totalSupply() == 0) return;
        usdc.mint(address(vault), bound(amount, 1, 1e9)); // interest: the shares become worth more
    }

    function wait(uint256 s) external { vm.warp(block.timestamp + bound(s, 1, 12 hours)); }

    function deposit(uint256 who, uint256 v, uint256 amount) external {
        address u = users[bound(who, 0, 2)];
        amount = bound(amount, 1, 1e12);
        uint256 before = _value(u);
        uint256 feeBefore = usdc.balanceOf(feeWallet);
        vm.prank(u);
        try router.deposit(bound(v, 0, 1), amount) {
            calls++;
            uint256 fee = usdc.balanceOf(feeWallet) - feeBefore;
            feesPaid += fee; feeBase += amount;
            _lossCheck(u, before, fee, amount);
            _interval(u);
        } catch {}
    }

    function move(uint256 who, uint256 fromV, uint256 amount) external {
        address u = users[bound(who, 0, 2)];
        uint256 from = bound(fromV, 0, 1);
        uint256 to = 1 - from;
        amount = bound(amount, 1, type(uint256).max);
        uint256 fromRate = router.rateOf(from);
        uint256 toRate = router.rateOf(to);
        uint256 before = _value(u);
        uint256 held = router.positionOf(from, u);
        uint256 feeBefore = usdc.balanceOf(feeWallet);
        vm.prank(u);
        try router.move(from, to, amount) {
            calls++;
            if (toRate < fromRate + uint256(router.MIN_GAIN_BPS()) * 1e14) worseMoves++;
            uint256 fee = usdc.balanceOf(feeWallet) - feeBefore;
            uint256 moved = amount > held ? held : amount;
            feesPaid += fee; feeBase += moved;
            _lossCheck(u, before, fee, moved);
            _interval(u);
        } catch {}
    }

    /// Withdrawing a held position to the account always works, whatever the limits, expiry or revoke.
    function withdraw(uint256 who, uint256 v, uint256 amount) external {
        address u = users[bound(who, 0, 2)];
        uint256 id = bound(v, 0, 1);
        amount = bound(amount, 1, type(uint256).max);
        uint256 before = _value(u);
        uint256 held = router.positionOf(id, u);
        vm.prank(u);
        try router.withdraw(id, amount) {
            calls++;
            _lossCheck(u, before, 0, amount > held ? held : amount);
        } catch {
            if (held > 0) blockedWithdrawals++;
        }
    }

    function user(uint256 i) external view returns (address) { return users[i]; }
}

contract YieldRouterInvariantTest is Test {
    RektBullYieldRouter router;
    MockERC20 usdc;
    MockVault4626 v0;
    MockVault4626 v1;
    YieldHandler handler;
    address feeWallet = address(0xFEE);
    address bystander = address(0xB1);

    function setUp() public {
        vm.warp(1_800_000_000);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        v0 = new MockVault4626(usdc);
        v1 = new MockVault4626(usdc);
        MockSsrOracle o0 = new MockSsrOracle();
        MockSsrOracle o1 = new MockSsrOracle();
        RektBullYieldRouter.Venue[] memory list = new RektBullYieldRouter.Venue[](2);
        list[0] = RektBullYieldRouter.Venue(RektBullYieldRouter.Kind.SparkL2, address(v0), address(usdc), address(v0), address(o0));
        list[1] = RektBullYieldRouter.Venue(RektBullYieldRouter.Kind.SparkL2, address(v1), address(usdc), address(v1), address(o1));
        router = new RektBullYieldRouter(feeWallet, 10, 100, 1 hours, list);
        handler = new YieldHandler(router, usdc, v0, v1, o0, o1, feeWallet);
        // A bystander with money and positions, who approved the router for everything, and never calls it.
        usdc.mint(bystander, 1e12);
        vm.startPrank(bystander);
        usdc.approve(address(v0), 5e11);
        v0.deposit(5e11, bystander);
        usdc.approve(address(router), type(uint256).max);
        v0.approve(address(router), type(uint256).max);
        v1.approve(address(router), type(uint256).max);
        vm.stopPrank();
        targetContract(address(handler));
    }

    /// The handler's honest path really deposits, moves and withdraws (so the invariants aren't passing on nothing).
    function test_handlerWorks() public {
        handler.setRate(1, 500);
        handler.deposit(0, 0, 1e9);
        handler.wait(2 hours);
        handler.move(0, 0, type(uint256).max); // into the venue paying 5% more
        handler.withdraw(0, 1, type(uint256).max);
        assertEq(handler.calls(), 3);
        assertEq(handler.valueLostBeyondAllowed(), 0);
        handler.deposit(1, 1, 1e9);
        handler.move(1, 1, 1e9); // straight away, and into a venue paying less: refused
        assertEq(handler.calls(), 4);
    }

    function invariant_routerHoldsNothing() public view {
        assertEq(usdc.balanceOf(address(router)), 0);
        assertEq(v0.balanceOf(address(router)), 0);
        assertEq(v1.balanceOf(address(router)), 0);
    }

    /// The fee is at most 0.1% of what was deposited or moved, and paid only to the fee wallet.
    function invariant_feeAtMostTenthPercent() public view {
        assertLe(handler.feesPaid() * 1000, handler.feeBase());
        assertEq(usdc.balanceOf(feeWallet), handler.feesPaid());
    }

    /// No call left a user with less than they had, beyond the fee and MAX_LOSS_BPS of what moved.
    function invariant_noValueLost() public view { assertEq(handler.valueLostBeyondAllowed(), 0); }

    /// Every move went to a venue paying at least MIN_GAIN_BPS more, read onchain.
    function invariant_onlyBetterMoves() public view { assertEq(handler.worseMoves(), 0); }

    /// Fee-bearing calls per account are at least MIN_INTERVAL apart.
    function invariant_minInterval() public view { assertEq(handler.intervalBreaks(), 0); }

    /// Getting out is never blocked: a held position can always be withdrawn to the account.
    function invariant_withdrawAlwaysWorks() public view { assertEq(handler.blockedWithdrawals(), 0); }

    /// Someone who approved the router for everything but never called it loses nothing.
    function invariant_bystanderUntouched() public view {
        assertEq(usdc.balanceOf(bystander), 5e11);
        assertGe(v0.convertToAssets(v0.balanceOf(bystander)), 5e11 - 1); // interest only adds
        assertEq(v1.balanceOf(bystander), 0);
    }
}
