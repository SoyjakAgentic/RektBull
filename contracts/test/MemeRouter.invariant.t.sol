// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {RektBullMemeRouter} from "../contracts/RektBullMemeRouter.sol";
import {MockERC20, MockVenue} from "../contracts/test/Mocks.sol";
import {MockWrappedNative} from "../contracts/test/MemeMocks.sol";

/**
 * Drives the Meme Router with random sequences of signed orders, fills (honest, at a bad price,
 * paying someone else), partial fills, cancels, an attacker's fills and forged orders. It records
 * what every successful fill promised and delivered, for the invariants below to check.
 */
contract MemeHandler is Test {
    RektBullMemeRouter public router;
    MockERC20 public usdc;
    MockERC20 public meme;
    MockVenue public venue;
    address public feeWallet;
    address public attacker = address(0xBAD);

    uint256[3] internal keys = [uint256(0xA11CE), uint256(0xB0B), uint256(0xCA401)];
    address[3] public users;

    RektBullMemeRouter.Order[] internal orders;
    mapping(address => uint256) public floorOwed; // sum of each successful fill's pro-rata minimum
    mapping(address => uint256) public received; // what each user actually got from fills
    mapping(address => uint256) public sold; // what each user actually gave
    mapping(address => uint256) public signedSize; // sum of amountIn over each user's orders
    uint256 public feesUsdc; // fees the router took in USDC (on either side)
    uint256 public grossUsdc; // USDC that went through fills, before the fee
    uint256 public unauthorizedSuccesses; // must stay 0
    uint256 public fills;

    constructor(RektBullMemeRouter r, MockERC20 u, MockERC20 m, MockVenue v, address fw) {
        router = r; usdc = u; meme = m; venue = v; feeWallet = fw;
        for (uint256 i; i < 3; ++i) {
            users[i] = vm.addr(keys[i]);
            m.mint(users[i], 1e30);
            u.mint(users[i], 1e18);
            vm.startPrank(users[i]);
            m.approve(address(r), type(uint256).max);
            u.approve(address(r), type(uint256).max);
            vm.stopPrank();
        }
    }

    function _sign(uint256 who, RektBullMemeRouter.Order memory o) internal view returns (bytes memory) {
        (uint8 v, bytes32 rr, bytes32 s) = vm.sign(keys[who], router.hashOrder(o));
        return abi.encodePacked(rr, s, v);
    }

    /// A user signs an order: sell MEME for USDC, or buy MEME with USDC, at a random limit price.
    function place(uint256 who, bool sell, uint256 size, uint256 limit) external {
        who = bound(who, 0, 2);
        RektBullMemeRouter.Order memory o;
        o.account = users[who];
        o.executor = address(this);
        o.validUntil = uint64(block.timestamp + 1 days);
        o.epoch = router.epochOf(users[who]);
        o.salt = orders.length;
        if (sell) {
            o.tokenIn = address(meme); o.tokenOut = address(usdc);
            o.amountIn = bound(size, 1e15, 1e24); // 0.001 to 1,000,000 MEME
            limit = bound(limit, 1, 1e7); // USDC units per 1 MEME
            o.minAmountOut = o.amountIn * limit / 1e18; // may round to 0: the router must refuse such an order
        } else {
            o.tokenIn = address(usdc); o.tokenOut = address(meme);
            o.amountIn = bound(size, 1e3, 1e11); // 0.001 to 100,000 USDC
            limit = bound(limit, 1e9, 1e24); // MEME wei per 1 USDC unit
            o.minAmountOut = o.amountIn * limit;
        }
        orders.push(o);
        signedSize[o.account] += o.amountIn;
    }

    /// The executor fills part of an order, through an exchange paying `skew` percent of the limit price, to the router or elsewhere.
    function fill(uint256 idx, uint256 part, uint256 skew, bool payElsewhere) external {
        if (orders.length == 0) return;
        RektBullMemeRouter.Order memory o = orders[bound(idx, 0, orders.length - 1)];
        bytes32 h = router.hashOrder(o);
        uint256 left = o.amountIn - router.filled(h);
        if (left == 0) return;
        uint256 amountIn = bound(part, 1, left);
        skew = bound(skew, 50, 150);
        bool feeOnOut = o.tokenOut == address(usdc);
        uint256 traded = feeOnOut ? amountIn : amountIn - amountIn / 100;
        // rate (out per 1e18 in) such that the gross output is about skew% of the order's price
        uint256 rate = o.minAmountOut * 1e18 / o.amountIn * skew / 100 + 1;
        RektBullMemeRouter.Fill memory f = RektBullMemeRouter.Fill({
            amountIn: amountIn, venue: address(venue), spender: address(venue), unwrapIn: false,
            venueCalldata: abi.encodeCall(MockVenue.swap, (o.tokenIn, o.tokenOut, traded, rate, payElsewhere ? attacker : address(router)))
        });
        uint256 who = o.account == users[0] ? 0 : o.account == users[1] ? 1 : 2;
        bytes memory sig = _sign(who, o);
        uint256 outBefore = MockERC20(o.tokenOut).balanceOf(o.account);
        uint256 inBefore = MockERC20(o.tokenIn).balanceOf(o.account);
        uint256 feeBefore = usdc.balanceOf(feeWallet);
        try router.fill(o, sig, f) returns (uint256) {
            fills++;
            uint256 got = MockERC20(o.tokenOut).balanceOf(o.account) - outBefore;
            received[o.account] += got;
            sold[o.account] += inBefore - MockERC20(o.tokenIn).balanceOf(o.account);
            floorOwed[o.account] += (o.minAmountOut * amountIn + o.amountIn - 1) / o.amountIn;
            uint256 fee = usdc.balanceOf(feeWallet) - feeBefore;
            feesUsdc += fee;
            grossUsdc += feeOnOut ? got + fee : inBefore - MockERC20(o.tokenIn).balanceOf(o.account) + 0;
        } catch {}
    }

    /// The order's account cancels it, or cancels everything.
    function cancel(uint256 idx, bool all) external {
        if (orders.length == 0) return;
        RektBullMemeRouter.Order memory o = orders[bound(idx, 0, orders.length - 1)];
        vm.prank(o.account);
        if (all) router.cancelAll();
        else router.cancel(o);
    }

    /// Someone other than the named executor tries to fill a real order: must fail.
    function attackerFill(uint256 idx) external {
        if (orders.length == 0) return;
        RektBullMemeRouter.Order memory o = orders[bound(idx, 0, orders.length - 1)];
        uint256 who = o.account == users[0] ? 0 : o.account == users[1] ? 1 : 2;
        bytes memory sig = _sign(who, o);
        RektBullMemeRouter.Fill memory f = RektBullMemeRouter.Fill({
            amountIn: 1, venue: address(venue), spender: address(venue), unwrapIn: false,
            venueCalldata: abi.encodeCall(MockVenue.swap, (o.tokenIn, o.tokenOut, 1, 1e36, address(router)))
        });
        vm.prank(attacker);
        try router.fill(o, sig, f) returns (uint256) { unauthorizedSuccesses++; } catch {}
    }

    /// An order for a user's account, signed by another user's key, or with its price lowered after signing: must fail.
    function forgedFill(uint256 idx, bool lowerPrice) external {
        if (orders.length == 0) return;
        RektBullMemeRouter.Order memory o = orders[bound(idx, 0, orders.length - 1)];
        uint256 who = o.account == users[0] ? 0 : o.account == users[1] ? 1 : 2;
        bytes memory sig = _sign(lowerPrice ? who : (who + 1) % 3, o);
        if (lowerPrice) o.minAmountOut = o.minAmountOut / 2; // a 0 minimum stays 0 here: refused anyway, as an order with no price
        RektBullMemeRouter.Fill memory f = RektBullMemeRouter.Fill({
            amountIn: 1, venue: address(venue), spender: address(venue), unwrapIn: false,
            venueCalldata: abi.encodeCall(MockVenue.swap, (o.tokenIn, o.tokenOut, 1, 1e36, address(router)))
        });
        try router.fill(o, sig, f) returns (uint256) { unauthorizedSuccesses++; } catch {}
    }

    function orderCount() external view returns (uint256) { return orders.length; }
    function orderAt(uint256 i) external view returns (RektBullMemeRouter.Order memory) { return orders[i]; }
}

contract MemeRouterInvariantTest is Test {
    RektBullMemeRouter router;
    MockERC20 usdc;
    MockERC20 meme;
    MockWrappedNative wnat;
    MemeHandler handler;
    address feeWallet = address(0xFEE);
    address bystander = address(0xB1);

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        meme = new MockERC20("Meme", "MEME", 18);
        wnat = new MockWrappedNative();
        MockVenue venue = new MockVenue();
        address[] memory venues = new address[](1);
        venues[0] = address(venue);
        address[] memory bases = new address[](1);
        bases[0] = address(usdc);
        router = new RektBullMemeRouter(feeWallet, 100, address(wnat), venues, bases);
        handler = new MemeHandler(router, usdc, meme, venue, feeWallet);
        // A bystander who has approved the router but signed nothing.
        meme.mint(bystander, 1e24);
        usdc.mint(bystander, 1e12);
        vm.startPrank(bystander);
        meme.approve(address(router), type(uint256).max);
        usdc.approve(address(router), type(uint256).max);
        vm.stopPrank();
        targetContract(address(handler));
    }

    /// The handler's honest path really fills (so the invariants aren't passing on nothing).
    function test_handlerCanFill() public {
        handler.place(0, true, 1e21, 1e5);   // sell 1,000 MEME for at least 0.1 USDC each
        handler.place(1, false, 1e8, 1e13);  // buy with 100 USDC, at least 1e13 MEME wei per USDC unit
        handler.fill(0, 5e20, 110, false);          // 10% over the user's price: room for the 1% fee
        handler.fill(1, 1e8, 110, false);
        assertEq(handler.fills(), 2);
        handler.fill(0, 1e20, 100, false);          // exactly the user's price before the fee: 1% short, refused
        handler.fill(0, 1e20, 50, false);           // half the user's price: refused
        handler.fill(0, 1e20, 120, true);           // paid to someone else: refused
        assertEq(handler.fills(), 2);
        assertGt(handler.received(handler.users(0)), 0);
    }

    /// The router holds nothing between transactions.
    function invariant_routerHoldsNothing() public view {
        assertEq(usdc.balanceOf(address(router)), 0);
        assertEq(meme.balanceOf(address(router)), 0);
        assertEq(wnat.balanceOf(address(router)), 0);
        assertEq(address(router).balance, 0);
    }

    /// No order is ever filled past its signed size.
    function invariant_neverOverfilled() public view {
        uint256 n = handler.orderCount();
        for (uint256 i; i < n; ++i) {
            RektBullMemeRouter.Order memory o = handler.orderAt(i);
            assertLe(router.filled(router.hashOrder(o)), o.amountIn);
        }
    }

    /// Every user received at least the limit price they signed, for everything filled.
    function invariant_usersGetTheirPrice() public view {
        for (uint256 i; i < 3; ++i) {
            address u = handler.users(i);
            assertGe(handler.received(u), handler.floorOwed(u));
        }
    }

    /// No user gave more than the orders they signed.
    function invariant_neverSoldMoreThanSigned() public view {
        for (uint256 i; i < 3; ++i) {
            address u = handler.users(i);
            assertLe(handler.sold(u), handler.signedSize(u));
        }
    }

    /// The fee wallet received at most 1% of the USDC that went through, and nothing in the meme coin.
    function invariant_feeAtMostOnePercent() public view {
        assertLe(handler.feesUsdc() * 100, handler.grossUsdc() + 100);
        assertEq(usdc.balanceOf(feeWallet), handler.feesUsdc());
        assertEq(meme.balanceOf(feeWallet), 0);
    }

    /// Only the named executor, with the account's own signature over the exact order, ever filled anything.
    function invariant_noUnauthorizedFill() public view {
        assertEq(handler.unauthorizedSuccesses(), 0);
    }

    /// Someone who approved the router but signed nothing never loses a token.
    function invariant_bystanderUntouched() public view {
        assertEq(meme.balanceOf(bystander), 1e24);
        assertEq(usdc.balanceOf(bystander), 1e12);
    }
}
