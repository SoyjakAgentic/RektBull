// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {RektBullTradeRouter} from "../contracts/RektBullTradeRouter.sol";
import {MockERC20, MockFeed, MockVenue} from "../contracts/test/Mocks.sol";

/**
 * Drives the Trade Router with random sequences: users setting limits and revoking, trades through
 * an exchange paying honestly, badly or to someone else, prices moving and going stale, time passing,
 * and an attacker trading from accounts that aren't theirs.
 */
contract TradeHandler is Test {
    RektBullTradeRouter public router;
    MockERC20 public usdc;
    MockERC20 public weth;
    MockFeed public usdcFeed;
    MockFeed public wethFeed;
    MockVenue public venue;
    address public feeWallet;
    address public attacker = address(0xBAD);
    address[3] public users = [address(0xA1), address(0xA2), address(0xA3)];

    mapping(address => uint256) public floorOwed; // each successful trade's oracle-bound minimum, summed
    mapping(address => uint256) public received;
    uint256 public feesIn; // fee units, summed (USDC + WETH, each against its own input)
    uint256 public grossIn; // input units of the same trades
    uint256 public unauthorizedSuccesses;
    uint256 public trades;

    constructor(RektBullTradeRouter r, MockERC20 u, MockERC20 w, MockFeed uf, MockFeed wf, MockVenue v, address fw) {
        router = r; usdc = u; weth = w; usdcFeed = uf; wethFeed = wf; venue = v; feeWallet = fw;
        for (uint256 i; i < 3; ++i) {
            u.mint(users[i], 1e15); // 1,000,000,000 USDC
            w.mint(users[i], 1e24);
            vm.startPrank(users[i]);
            u.approve(address(r), type(uint256).max);
            w.approve(address(r), type(uint256).max);
            r.setLimits(1e13, 1e14, 1 days, uint64(block.timestamp + 365 days)); // $100,000 a trade, $1,000,000 a day, to start
            vm.stopPrank();
        }
    }

    function setLimits(uint256 who, uint128 perTrade, uint128 perPeriod, uint32 period) external {
        address u = users[bound(who, 0, 2)];
        perTrade = uint128(bound(perTrade, 1e8, 1e14)); // $1 to $1,000,000 (8 decimals)
        perPeriod = uint128(bound(perPeriod, perTrade, uint256(perTrade) * 20));
        period = uint32(bound(period, 1 hours, 7 days));
        vm.prank(u);
        router.setLimits(perTrade, perPeriod, period, uint64(block.timestamp + 30 days));
    }

    function revoke(uint256 who) external {
        vm.prank(users[bound(who, 0, 2)]);
        router.revoke();
    }

    /// The market moves (within a sane band), or a feed goes quiet.
    function movePrice(bool weth_, uint256 price, uint256 age) external {
        MockFeed f = weth_ ? wethFeed : usdcFeed;
        price = weth_ ? bound(price, 500e8, 10_000e8) : bound(price, 0.98e8, 1.02e8);
        f.set(int256(price), block.timestamp - bound(age, 0, 2 hours)); // sometimes past WETH's 1-hour heartbeat
    }

    function wait(uint256 seconds_) external { vm.warp(block.timestamp + bound(seconds_, 1, 6 hours)); }

    /// A trade for a user: USDC to WETH or back, through an exchange paying `skew`% of the oracle price, to the router or elsewhere.
    function swap(uint256 who, bool buyWeth, uint256 amount, uint256 skew, bool payElsewhere) external {
        address u = users[bound(who, 0, 2)];
        (MockERC20 tin, MockERC20 tout) = buyWeth ? (usdc, weth) : (weth, usdc);
        amount = buyWeth ? bound(amount, 1e6, 1e11) : bound(amount, 1e15, 3e19); // $1 to $100,000
        skew = bound(skew, 95, 110); // the bound is 2%: below 98 must be refused
        uint256 toTrade = amount - amount * router.FEE_BPS() / 10_000;
        uint256 fair;
        try this.fairOut(address(tin), address(tout), toTrade) returns (uint256 x) { fair = x; } catch { fair = 0; }
        uint256 rate = fair * 1e18 / toTrade * skew / 100;
        RektBullTradeRouter.SwapParams memory p = RektBullTradeRouter.SwapParams({
            tokenIn: address(tin), tokenOut: address(tout), amountIn: amount, minAmountOut: 0,
            venue: address(venue), spender: address(venue), deadline: block.timestamp + 60,
            venueCalldata: abi.encodeCall(MockVenue.swap, (address(tin), address(tout), toTrade, rate, payElsewhere ? attacker : address(router)))
        });
        uint256 outBefore = tout.balanceOf(u);
        uint256 feeBefore = tin.balanceOf(feeWallet);
        vm.prank(u);
        try router.swap(p) returns (uint256) {
            trades++;
            received[u] += tout.balanceOf(u) - outBefore;
            floorOwed[u] += fair * (10_000 - router.MAX_SLIPPAGE_BPS()) / 10_000;
            feesIn += tin.balanceOf(feeWallet) - feeBefore;
            grossIn += amount;
        } catch {}
    }

    /// The attacker tries to trade a user's tokens: the router only ever pulls from msg.sender.
    function attackerSwap(uint256 amount) external {
        amount = bound(amount, 1e6, 1e12);
        RektBullTradeRouter.SwapParams memory p = RektBullTradeRouter.SwapParams({
            tokenIn: address(usdc), tokenOut: address(weth), amountIn: amount, minAmountOut: 0,
            venue: address(venue), spender: address(venue), deadline: block.timestamp + 60,
            venueCalldata: abi.encodeCall(MockVenue.swap, (address(usdc), address(weth), amount - amount / 100, 1e30, attacker))
        });
        uint256 before = usdc.balanceOf(attacker);
        vm.prank(attacker);
        try router.swap(p) returns (uint256) { if (usdc.balanceOf(attacker) >= before) unauthorizedSuccesses++; } catch {}
    }

    /// The oracle-fair output for toTrade (reverts on a stale or missing price, like the router).
    function fairOut(address tin, address tout, uint256 toTrade) external view returns (uint256) {
        return router.amountForUsd(tout, router.valueUsd(tin, toTrade));
    }

    function user(uint256 i) external view returns (address) { return users[i]; }
}

contract TradeRouterInvariantTest is Test {
    RektBullTradeRouter router;
    MockERC20 usdc;
    MockERC20 weth;
    TradeHandler handler;
    address feeWallet = address(0xFEE);
    address bystander = address(0xB1);

    function setUp() public {
        vm.warp(1_800_000_000);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        weth = new MockERC20("Wrapped Ether", "WETH", 18);
        MockFeed usdcFeed = new MockFeed(8, 1e8);
        MockFeed wethFeed = new MockFeed(8, 3000e8);
        MockVenue venue = new MockVenue();
        address[] memory venues = new address[](1);
        venues[0] = address(venue);
        address[] memory tokens = new address[](2);
        tokens[0] = address(usdc); tokens[1] = address(weth);
        address[] memory feeds = new address[](2);
        feeds[0] = address(usdcFeed); feeds[1] = address(wethFeed);
        uint256[] memory ages = new uint256[](2);
        ages[0] = 1 days; ages[1] = 1 hours;
        router = new RektBullTradeRouter(feeWallet, 100, 200, address(0), address(0), venues, tokens, feeds, ages);
        handler = new TradeHandler(router, usdc, weth, usdcFeed, wethFeed, venue, feeWallet);
        usdc.mint(bystander, 1e12);
        vm.prank(bystander);
        usdc.approve(address(router), type(uint256).max);
        targetContract(address(handler));
    }

    /// The handler's honest path really trades (so the invariants aren't passing on nothing).
    function test_handlerCanTrade() public {
        handler.setLimits(0, 1e12, 1e13, 1 days);
        handler.swap(0, true, 1e9, 100, false);
        handler.swap(0, false, 1e17, 100, false);
        assertEq(handler.trades(), 2);
        assertGt(handler.received(handler.user(0)), 0);
        handler.swap(0, true, 1e9, 95, false); // 5% under the oracle price (the bound is 2%): refused
        handler.swap(0, true, 1e9, 100, true); // paid to someone else: refused
        assertEq(handler.trades(), 2);
    }

    function invariant_routerHoldsNothing() public view {
        assertEq(usdc.balanceOf(address(router)), 0);
        assertEq(weth.balanceOf(address(router)), 0);
    }

    /// Every trade paid the user at least the Chainlink price less the slippage bound.
    function invariant_usersGetTheOraclePrice() public view {
        for (uint256 i; i < 3; ++i) assertGe(handler.received(handler.user(i)), handler.floorOwed(handler.user(i)));
    }

    /// No one spends past their own per-period limit.
    function invariant_withinPeriodLimit() public view {
        for (uint256 i; i < 3; ++i) {
            address u = handler.user(i);
            (, uint128 perPeriod,,) = router.limits(u);
            if (perPeriod > 0) assertLe(router.spentThisPeriodUsd(u), perPeriod);
        }
    }

    /// The fee is at most 1% of what was traded.
    function invariant_feeAtMostOnePercent() public view {
        assertLe(handler.feesIn() * 100, handler.grossIn());
    }

    function invariant_noUnauthorizedTrade() public view {
        assertEq(handler.unauthorizedSuccesses(), 0);
    }

    function invariant_bystanderUntouched() public view {
        assertEq(usdc.balanceOf(bystander), 1e12);
    }
}
