// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {RektBullTradeRouter} from "../contracts/RektBullTradeRouter.sol";
import {MockERC20, MockFeed, MockVenue} from "../contracts/test/Mocks.sol";

/// The second AI audit of the Trade Router (Fable 5.2, November 2026): its proofs, kept as regression tests.
/// M-1, L-2 and I-2 are fixed: those attacks must now fail. L-1 (volume up to twice the limit per period) is
/// disclosed, and its test checks the documented bound.
contract TradeRouterAuditTest is Test {
    RektBullTradeRouter router;
    MockERC20 usdc;
    MockERC20 weth;
    MockFeed usdcFeed;
    MockFeed wethFeed;
    MockVenue venue;
    address feeWallet = address(0xFEE);
    address user = address(0xA11CE);
    address cold = address(0xC01D);

    uint256 constant BUY_RATE = 1e30 / uint256(3000); // USDC(6) -> WETH(18) at $3,000
    uint256 constant SELL_RATE = 3000e6; // WETH(18) -> USDC(6) at $3,000

    function setUp() public {
        vm.warp(1_800_000_000);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        weth = new MockERC20("Wrapped Ether", "WETH", 18);
        usdcFeed = new MockFeed(8, 1e8);
        wethFeed = new MockFeed(8, 3000e8);
        venue = new MockVenue();
        address[] memory venues = new address[](1);
        venues[0] = address(venue);
        address[] memory tokens = new address[](2);
        tokens[0] = address(usdc); tokens[1] = address(weth);
        address[] memory feeds = new address[](2);
        feeds[0] = address(usdcFeed); feeds[1] = address(wethFeed);
        uint256[] memory ages = new uint256[](2);
        ages[0] = 365 days; ages[1] = 365 days;
        router = new RektBullTradeRouter(feeWallet, 100, 200, address(0), address(0), venues, tokens, feeds, ages);
        vm.startPrank(user);
        usdc.approve(address(router), type(uint256).max);
        weth.approve(address(router), type(uint256).max);
        vm.stopPrank();
    }

    function _swap(MockERC20 tin, MockERC20 tout, uint256 amountIn, uint256 rate) internal returns (uint256) {
        uint256 toTrade = amountIn - amountIn / 100;
        RektBullTradeRouter.SwapParams memory p = RektBullTradeRouter.SwapParams({
            tokenIn: address(tin), tokenOut: address(tout), amountIn: amountIn, minAmountOut: 0,
            venue: address(venue), spender: address(venue), deadline: block.timestamp + 60,
            venueCalldata: abi.encodeCall(MockVenue.swap, (address(tin), address(tout), toTrade, rate, address(router)))
        });
        vm.prank(user); // the session key acting through the user's account (delegation / Safe module)
        return router.swap(p);
    }

    /// M-1 (fixed). Credits end with the grant: after revoke() and a new setLimits(), what the router bought under
    /// the old grant no longer covers the user's own tokens.
    function test_M1_staleCreditsEndWithTheGrant() public {
        usdc.mint(user, 30_000e6);
        vm.prank(user);
        router.setLimits(500e8, 1000e8, 1 days, uint64(block.timestamp + 30 days));
        for (uint256 d; d < 10; ++d) {
            _swap(usdc, weth, 500e6, BUY_RATE);
            uint256 bal = weth.balanceOf(user);
            vm.prank(user);
            weth.transfer(cold, bal); // moved out, not through the router
            vm.warp(block.timestamp + 1 days);
        }
        assertGt(router.boughtByRouter(user, address(weth)), 1 ether, "a credit under the current grant");
        vm.prank(user);
        router.revoke();
        assertEq(router.boughtByRouter(user, address(weth)), 0, "revoke ends it");

        wethFeed.set(3000e8, block.timestamp); usdcFeed.set(1e8, block.timestamp);
        weth.mint(user, 10 ether);
        vm.prank(user);
        router.setLimits(10e8, 10e8, 1 days, uint64(block.timestamp + 7 days));
        uint256 amountIn = 1.6 ether;
        RektBullTradeRouter.SwapParams memory p = RektBullTradeRouter.SwapParams({
            tokenIn: address(weth), tokenOut: address(usdc), amountIn: amountIn, minAmountOut: 0,
            venue: address(venue), spender: address(venue), deadline: block.timestamp + 60,
            venueCalldata: abi.encodeCall(MockVenue.swap, (address(weth), address(usdc), amountIn - amountIn / 100, SELL_RATE * 98 / 100, address(router)))
        });
        uint256 usd = router.valueUsd(address(weth), amountIn);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(RektBullTradeRouter.OverTradeLimit.selector, usd, 10e8));
        router.swap(p);
        assertEq(weth.balanceOf(user), 10 ether, "the user's own WETH is untouched");
    }

    /// Re-review N-3: renewing or changing the limits while the grant is still live keeps the credits, so a position the
    /// router opened can still be closed in one sale. setLimits() after the grant ended starts a new grant, and credits end.
    function test_M1_renewalKeepsCreditsANewGrantEndsThem() public {
        usdc.mint(user, 1_000e6);
        vm.prank(user);
        router.setLimits(500e8, 1000e8, 1 days, uint64(block.timestamp + 30 days));
        _swap(usdc, weth, 500e6, BUY_RATE);
        uint256 credit = router.boughtByRouter(user, address(weth));
        assertGt(credit, 0);
        vm.warp(block.timestamp + 10 days);
        vm.prank(user);
        router.setLimits(500e8, 1000e8, 1 days, uint64(block.timestamp + 30 days)); // renewed early
        assertEq(router.boughtByRouter(user, address(weth)), credit, "an early renewal keeps the credit");
        vm.warp(block.timestamp + 30 days + 1); // the renewed grant ends
        vm.prank(user);
        router.setLimits(500e8, 1000e8, 1 days, uint64(block.timestamp + 30 days));
        assertEq(router.boughtByRouter(user, address(weth)), 0, "a grant after the last one ended starts afresh");
    }

    /// Re-review I-2: the spend-permission manager can't be a venue (through it anyone could spend another wallet's permission).
    function test_spendPermissionManagerIsNotAVenue() public {
        address spm = address(0x5BE0);
        address[] memory venues = new address[](1);
        venues[0] = spm;
        address[] memory none = new address[](0);
        uint256[] memory noAges = new uint256[](0);
        vm.expectRevert(RektBullTradeRouter.BadConfig.selector);
        new RektBullTradeRouter(address(0xFEE), 100, 200, address(0), spm, venues, none, none, noAges);
    }

    /// L-1 (disclosed). Within one period, counted buys plus exempt sales of what they bought reach twice the limit,
    /// four times across a window boundary; each round costs at most the 2% bound plus the 1% fee.
    function test_L1_volumeBoundIsAsDisclosed() public {
        usdc.mint(user, 2_000e6);
        vm.prank(user);
        router.setLimits(1000e8, 1000e8, 1 days, uint64(block.timestamp + 30 days));
        uint256 start = usdc.balanceOf(user);
        vm.warp(block.timestamp + 1 days - 1);
        uint256 w = _swap(usdc, weth, 1000e6, BUY_RATE * 981 / 1000);
        _swap(weth, usdc, w, SELL_RATE * 981 / 1000);
        vm.warp(block.timestamp + 1);
        w = _swap(usdc, weth, 1000e6, BUY_RATE * 981 / 1000);
        _swap(weth, usdc, w, SELL_RATE * 981 / 1000);
        uint256 lost = start - usdc.balanceOf(user);
        assertLe(lost, 4 * 1000e6 * 3 / 100, "at most 3% of four times the limit across a boundary");
    }

    /// L-2 (fixed). Dust or zero-size trades are refused: no trade without a price floor.
    function test_L2_dustAndZeroTradesAreRefused() public {
        address anyone = address(0xBAD);
        weth.mint(anyone, 1000);
        vm.startPrank(anyone);
        weth.approve(address(router), type(uint256).max);
        router.setLimits(1, 1, 1, uint64(block.timestamp + 1));
        RektBullTradeRouter.SwapParams memory p = RektBullTradeRouter.SwapParams({
            tokenIn: address(weth), tokenOut: address(usdc), amountIn: 1000, minAmountOut: 0,
            venue: address(venue), spender: address(venue), deadline: block.timestamp + 60,
            venueCalldata: abi.encodeCall(MockVenue.swap, (address(weth), address(usdc), 990, 0, address(0xdead)))
        });
        vm.expectRevert(RektBullTradeRouter.NotAllowed.selector);
        router.swap(p);
        p.amountIn = 0;
        vm.expectRevert(RektBullTradeRouter.NotAllowed.selector);
        router.swap(p);
        vm.stopPrank();
        assertEq(weth.balanceOf(anyone), 1000);
    }

    /// I-2 (fixed). A listed token can't also be a venue, and a token can't be listed twice.
    function test_I2_constructorRefusesTokenVenues() public {
        address[] memory venues = new address[](1);
        venues[0] = address(weth);
        address[] memory tokens = new address[](2);
        tokens[0] = address(usdc); tokens[1] = address(weth);
        address[] memory feeds = new address[](2);
        feeds[0] = address(usdcFeed); feeds[1] = address(wethFeed);
        uint256[] memory ages = new uint256[](2);
        ages[0] = 1 days; ages[1] = 1 days;
        vm.expectRevert(RektBullTradeRouter.BadConfig.selector);
        new RektBullTradeRouter(feeWallet, 100, 200, address(0), address(0), venues, tokens, feeds, ages);
        venues[0] = address(venue);
        tokens[1] = address(usdc);
        vm.expectRevert(RektBullTradeRouter.BadConfig.selector);
        new RektBullTradeRouter(feeWallet, 100, 200, address(0), address(0), venues, tokens, feeds, ages);
    }

    /// I-3 (fixed). A grant can't run past 30 days onchain.
    function test_I3_grantsAreAtMost30Days() public {
        vm.prank(user);
        vm.expectRevert(RektBullTradeRouter.BadConfig.selector);
        router.setLimits(500e8, 1000e8, 1 days, uint64(block.timestamp + 31 days));
    }
}
