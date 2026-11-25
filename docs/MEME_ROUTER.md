# The Meme Router: automatic meme trades without holding keys

*Status: the contract and its break-it tests are built
(`contracts/contracts/RektBullMemeRouter.sol`, tests in
`contracts/test/memeRouter.test.js` and `memeRouterAudit.test.js`, plus the fuzz tests and Slither below), and checked against four.meme's real
contracts on a copy of BNB Chain. The trade service that fills its orders is
built (below, `src/trade/memeOrders.js`), and off. **Not audited and not
deployed.** Nothing may hold real funds through it until an
external audit is done and every finding is fixed or explicitly accepted.*

## Why a second router

The Trade Router (docs/SESSION_KEYS.md) bounds every automatic trade by a
Chainlink price: a hacked RektBull can't sell a user's tokens far below it.
Meme coins have no Chainlink price, and a price read from the token's own pool
can be pushed around in the same transaction. So automatic meme trading needs
a different bound.

The Meme Router's bound is **the user's own price**. The user signs each order
(an EIP-712 signature; a contract wallet such as a Safe signs through EIP-1271).
RektBull's trade key can fill it when the conditions are met, and the contract
checks every fill against what the user signed. There is no oracle to get
wrong.

## What a user signs

| Field | Meaning |
|---|---|
| `account` | Whose order: the input comes only from it, the output goes only to it |
| `executor` | The only address that may fill it: RektBull's trade key (KMS) |
| `tokenIn`, `tokenOut` | What to sell, what to buy (`0xEeee…` for the native coin as output) |
| `amountIn` | The most that may be sold, filled in one go or in parts |
| `minAmountOut` | The least selling all of `amountIn` must bring back, after RektBull's fee: a limit price |
| `validAfter`, `validUntil` | When it may be filled |
| `epoch`, `salt` | `cancelAll()` moves the epoch on and kills every older order; the salt makes each order unique |

Orders cost nothing to place (a signature, no transaction). The user also
approves the router for the token being sold, once: the approval can only ever
be used to fill that account's own signed orders.

## The guarantees, and what enforces them

| Guarantee | Enforced by | If RektBull is hacked |
|---|---|---|
| Only orders the user signed can be filled | The contract (EIP-712 / EIP-1271 signature on every fill) | Can't invent orders or change one (size, price, tokens) |
| Only the executor the user named can fill them | The contract | A leaked order is useless to anyone else |
| Input comes only from the order's account, at most the order's size over all fills | The contract (`filled` per order) | Can't touch other tokens or other accounts |
| Output (and unused input) goes only to the order's account | The contract (balance checks; it holds nothing between transactions) | Can't send it elsewhere: an exchange paying someone else fails the price check |
| At least the user's limit price, pro rata for a partial fill, measured on what reaches the account (so a token that taxes transfers can't leave the user short) | The contract | **Worst case: the order filled at the user's own price**, at a time of its choosing within the window |
| Fee at most 1% (`MAX_FEE_BPS`), only to the fixed fee wallet, on the base-asset side | The contract (immutable) | Can't raise the fee or redirect it |
| Only exchanges fixed at deployment are called or approved, and only for this fill's input; no exchange may be a token users approve to the router, and no order may trade one | The contract (immutable list, the wrapped native and base assets refused as venues; approval reset after each call) | Can't call anything else |
| Unused input pays no fee; native coin an exchange hands back goes to the account | The contract (the input fee is charged after the trade, on what was used) | — |
| Cancel one order, or all at once | The user's own transaction (`cancel`, `cancelAll`) | Works however RektBull behaves |
| Which tokens and when to trade; the checks before a buy | RektBull's trade service (off-chain) | Could be bypassed, inside the signed orders |

**What this means for each kind of order:**
- **Take-profit**: a sale at a price at or above the target. Filling it early
  can only get the user their target or better.
- **Stop-loss**: a sale at a floor. RektBull's watcher fills it when the price
  falls toward the floor, but a hacked RektBull could fill it at the floor while
  the market is higher. The order screen says so in plain words.
- **Limit buy**: a buy at the user's highest price, for a token the user chose.
  RektBull can't make a user buy a token they didn't sign for.
- **Meme Watch exits** (insiders selling, liquidity pulled): a standing floor
  order the user signs when they buy, filled automatically if an alert fires.

**Out of scope for now:** automatic buying of tokens RektBull's agents find.
That would need orders for tokens the user hasn't seen, so the worst case
would be the whole order spent on a worthless token. It may come later with
small caps, and only if you decide it should.

## How a fill works

`fill(order, signature, { amountIn, venue, spender, venueCalldata, unwrapIn, minAmountOut })`, called by the executor:
1. Checks the executor, the window, the epoch and cancellation, the
   signature, the size left, and that the venue and spender are allowed.
2. Pulls `amountIn` of `tokenIn` from the account.
3. The fee is on the base-asset side (USDC, USDT, WETH, WBNB, the native
   coin): on the output when that's a base asset, taken after the venue call;
   otherwise on the input, taken after the venue call on what it used (unused
   input pays no fee). So buys and sells pay in the base asset; only an order
   from one meme coin straight into another (which the trade service doesn't
   offer) would pay in a meme coin. Unused input still counts towards the
   order's size, and the `Filled` event reports the fill's amount, not what the
   venue used (re-review, N-3); native coin a venue refunds on a non-unwrap
   fill is returned wrapped and counts as used for the fee (N-4).
4. Calls the venue: approves exactly this fill's input to `spender` (reset
   afterwards), or with `unwrapIn`, unwraps WBNB/WETH and sends it as native
   (four.meme's curve is bought with BNB). Unused native comes back wrapped.
5. Sends the output, and any unused input, to the account.
6. Checks what reached the account against the user's price, pro rata,
   after the fee, and against the executor's own `minAmountOut`.

**Deploying:** the constructor refuses any venue that answers like a token
(`totalSupply()` or `balanceOf()`), the wrapped native and the base assets,
and needs a wrapped native. A venue with a function that pulls from a `from`
it is given (Permit2-style) can't be told apart by a call, and through it
anyone could spend approvals given to the router: review every venue's
functions for that before deploying (the re-review's N-1).

**Exchanges, per chain** (fixed at deployment, `src/trade/memeRouterParams.js`):
- **Everywhere:** 0x's AllowanceHolder (any token with a pool, graduated curve
  tokens included).
- **BNB Chain:** four.meme's TokenManager2.
- **Base:** Virtuals' BondingV5 (called) and FRouterV3 (approved), with VIRTUAL
  as a base asset beside WETH and USDC. Virtuals' old Bonding isn't one: nothing
  launches or is bought on it, and holders still sell there from their own
  wallet on the Trade desk.

The same file gives the constructor's arguments for each chain. The checks on
copies of the chains deploy from it, the order service checks the deployed
router against it, and the deployment must use it.

## Tests

`contracts/test/memeRouter.test.js` (15, on a blank local chain), each something
a hacked RektBull or anyone else might try:
- deploying with a fee over 1%, no fee wallet or no exchange;
- an honest sale (99% to the user, 1% to the fee wallet, router left empty)
  and an honest buy (the fee in the base asset, never in the meme coin);
- a price below the user's limit;
- an exchange paying someone else;
- partial fills, each pro rata, never more than the order in all;
- another executor;
- a forged order, a changed price, size or executor;
- before its window, after it, cancelled, and cancelled all;
- an exchange not on the list, or another spender;
- an exchange taking more than the fill's input;
- a contract wallet (EIP-1271) signing through its owner, and another key refused;
- a sale for the native coin;
- a buy paid in wrapped native, sent as native, with the unused part returned;
- an order for another account, which can't touch the user's approved tokens.

The tests found one bug while building: with the fee on the input, it was also
taken off the output. Fixed before commit.

`contracts/scripts/memeRouterFourMemeCheck.js` runs it against four.meme's
real contracts on a copy of BNB Chain (four.meme accepts a contract as the
trader):
- a signed limit buy, paid in WBNB and sent as BNB, filled by the executor
  key at exactly four.meme's quote, with 0.001 WBNB (1%) to the fee wallet;
- a limit four.meme couldn't meet, refused;
- a signed stop-loss sale for BNB, filled by the executor key, with 1.00% to
  the fee wallet and the user paying no gas;
- the router left holding nothing.

## Checks before the audit

- **Slither in CI** (`contracts/scripts/slither.mjs`): every pull request runs
  Slither on all four contracts and fails on any Medium or High finding that
  isn't in `contracts/slither.triage.json` with a reviewed reason. Today: 15,
  all reviewed (none was a real flaw), 0 open.
- **Stateful fuzz tests** (`contracts/test/*.invariant.t.sol`, Hardhat 3's
  Solidity tests): 256 runs of random sequences each for this router, the
  Trade Router, the Yield Router and the Safe Module (29 tests in all). The
  invariants:
    - the router holds nothing;
    - users get their signed (or oracle) price;
    - nothing is filled past its size or sold past what was signed;
    - the fee is at most 1%;
    - no unauthorised fill succeeds;
    - an approved bystander loses nothing.

  A fixed test in each proves the honest path really trades. **Found:** an
  order whose minimum rounds to zero could be filled at any price; orders with
  no minimum are now refused.
- **AI security review** of this contract, including simulations against
  four.meme's live contracts: no exploitable finding. Its function that sells
  for another holder (`from`) needs that holder to be the sender of the
  transaction, so it can't reach users who approved this router. **Found
  below the bar:** for a token that taxes transfers, the price was checked
  before the tax. The check now uses what reaches the account.
- **The same checks on the older contracts** (12 November 2026), before
  their re-audit:
    - **Trade Router:** one High finding, with a working proof: trades that
      are exempt from the daily limit (selling back what the router bought)
      also count as bought, so selling and buying back over and over is
      never limited. Fixed (only trades that counted earn the exemption),
      with a regression test, and listed for the auditor (AUDIT_BRIEF.md
      section 8).
    - **Yield Router:** a hacked RektBull could withdraw and deposit to
      make a move the rate rule refuses (fixed: deposits only into the best
      venue, and no fee on putting money back within 7 days), or withdraw a
      borrowing user's Aave collateral down toward liquidation (fixed: no
      withdrawal may leave the health factor under 1.5). Rates read in the
      same transaction can be pushed by a flash loan: accepted, and
      documented in YIELD_ROUTER.md.
    - **Safe Module and the sign-in checker:** nothing found.
- These are not an audit. They catch the common and mechanical bugs so the
  auditor's time goes to the design.

## The trade service (built 24 November 2026)

Asked for by the owner on 24 November 2026 ("start BNB Chain and Base
orders"), after the same service on Solana (docs/SOLANA_ORDERS.md). Off until
the router is audited and deployed: `MEME_ORDERS_ENABLED`, `MEME_ROUTERS` (JSON,
`{"base":"0x…","bsc":"0x…"}`) and `MEME_ORDERS_EXECUTOR`, the executor's public
address. Its key is a secp256k1 key in Cloud KMS (`KMS_MEME_EXECUTOR_KEY_VERSION`),
used only by the trade service. It is its own key, not the session key, and
there is no stand-in key: these orders exist only on mainnets, and the tests
inject a signer. It pays every fill's network fee, so the owner keeps it
funded with a little ETH on Base and BNB on BNB Chain.

**The orders** (the Trade desk's "Orders on BNB Chain and Base" card,
`public/evm-orders.js`; `/v1/evm/orders`):

| Order | Order fields | Fires | Trades at |
|---|---|---|---|
| Stop-loss | the coin in, `0xEeee…` (ETH, BNB) out | The coins' value falls by the user's amount (DexScreener, the native coin from DefiLlama) | The market, never below the floor |
| Take-profit | the same | It rises by the user's amount | The target less the slippage, or better |
| Meme Watch exit | the same | Meme Watch raises a critical alert for the coin (its check in `myAgents`) | The market, never below the floor |
| Limit buy | WETH or WBNB in, the coin out | The coin's price falls by the user's amount | The limit less the slippage, or more coins |

The terms are worked out as on Solana (`solanaOrders.terms`, with the router's
own `FEE_BPS`). Each order is at most 30 days, and at least $5: RektBull
pays each fill's network fee out of its 1%.

**Placing** is a signature, nothing else: no transaction and no deposit.
1. The checks: the coin's balance, or for a buy the Trade desk's buy checks
   (the per-trade amount, the token check, the bundle check, selling straight
   back). A coin that taxes transfers (0x reports it) is refused, since the
   router's fill must trade exactly what it pulls.
2. The price now: four.meme's helper contract for a coin still on its BNB
   curve, otherwise 0x's price (with no 0x fee: the router takes the 1%).
3. The order: the account's current epoch, a random 256-bit salt, and the
   executor. The router's own `hashOrder` is called on it before the user is
   asked to sign, so a layout that drifted from the contract's is caught here.
4. The worst case in plain words, as on Solana, then `eth_signTypedData_v4`.

**Signing** (`POST /v1/evm/orders/:id/sign`): the signature is checked as the
router checks it, the key's own first, then EIP-1271 for a contract wallet,
and the epoch must still be the one signed. The order is then open, and the
user's wallet is given the calls it still needs, sized to every live order on
the same input (an approval replaces the one before it):
- for a buy, wrapping the native coin into WETH or WBNB, when the wallet holds
  too little of it;
- `approve(router, what the live orders still trade)`, when the allowance is
  short.

**Filling** (the trade service's pass, one sender at a time under a Postgres
advisory lock, so the executor's nonces never collide):
1. The size: what's left of the order, capped by the user's balance and
   allowance. For a coin on a four.meme curve, a sale is rounded down to
   four.meme's sell unit (10^9).
2. For a buy, the token check runs again.
3. The route, with the router as the trader:
   - a coin on its four.meme curve, priced in BNB, on BNB Chain:
     TokenManager2 itself. A buy is `buyTokenAMAP(token, 99%, the user's
     limit)` paid in BNB the router unwraps (`unwrapIn`). A sale is
     `sellToken(0, token, amount, the floor grossed up for the fee)`;
   - anything else: 0x's quote, with the router as taker. It must name
     AllowanceHolder, send no native coin, and quote exactly the amount the
     router passes on: all of a sale (the fee is on the output), or 99% of a
     buy (the fee is on the input). The quote's own minimum, net of the fee,
     goes in as the executor's `minAmountOut`, on top of the user's price.
4. Nothing is sent when the quote is under the user's price for this part.
5. The whole fill runs as a call first (`eth_call` from the executor). A
   `BelowLimit` from the router tells the user it can't fill at their price;
   any other failure waits and tries again.
6. Signed by the KMS key (logged to `key_signatures` first), recorded, then
   broadcast. The receipt's `Filled` event confirms what reached the user and
   the fee; the user is told.

**Cancelling** is the user's own call to the router, never blocked:
`cancel(order)`, with the router's approval revoked when it was the last live
order on that input; or "Cancel every order on this chain", `cancelAll()` (a
new epoch) with every approval revoked. The order is then read back from the
router: `cancelled`, `epochOf` and `filled` are read for every live order once
a minute, so a cancel or a fill made anywhere else is seen too. They go in one
Multicall3 call per chain for up to about 100 orders (`epochOf` once per wallet),
not three calls an order: about 45,000 RPC requests a month per chain whatever
the number of orders. That keeps the plan's allowance from growing with orders
(at three an order, 50 open orders on a chain cost about 13 million a month),
and keeps the pass's fills, which come after it, from waiting.

**Tests:** `test/memeOrders.test.js` runs the whole path on the real database
against a stand-in chain, 0x and four.meme: placed, signed (another key
refused), approved, fired, filled through AllowanceHolder and on the four.meme
curve, confirmed. It also covers below the floor (by the quote, and by the
router's `BelowLimit`), Meme Watch exits, the emergency stop, and cancelling
one order or all of them. `contracts/test/memeOrdersService.test.js` runs the
service's own order, hash, signature, fill, approval, cancel, cancel-all,
wrap and `Filled` decoding against the router itself.

**Exits with a buy (built 25 November 2026).** Asked for by the owner on 24
November 2026 ("start exits with the buy on BNB Chain and Base"), as on Solana.
On the Trade desk, a buy on BNB Chain or Base can carry a stop-loss and/or a
take-profit (`exitsForBuy`, from `trade/proposals.js`):
- **What they cover:** the coins the buy is sure to bring (its minimum), valued
  at the buy's own price (what that minimum cost, in ETH or BNB). The terms
  are the Solana exits' (`terms`, after the router's fee), and the router's own
  `hashOrder` is checked before anyone is asked to sign.
- **The approval** goes in the buy's own batch, after the swap: these coins for
  each exit, plus what's left of the account's other live orders on them
  (`exit_approve`). None when the router already has enough.
- **Signing comes after the buy is sent**, so the buy isn't held up: the page
  asks the wallet to sign each exit (a signature, nothing sent). Declining one
  only leaves it out.
- **Opening:** a signed exit waits (`prepared`, with its `trade_id`, migration
  042, shown as "waiting for its buy to land") until the trade service confirms
  the buy, then opens. It's dropped if the buy fails, is cancelled or expires,
  and signing after that is refused. Cancelling one that's still waiting sends
  the router's `cancel`, since its signature exists.
- **They never stop the buy.** When exits can't be added, the buy goes ahead
  and the plan says why: orders off or not open on that chain, a coin that taxes
  transfers, under $5 covered, or the router not readable just then.

Tests: `test/evmBuyWithExits.test.js` (the Trade desk's real buy on Base with
the stand-in chain of `test/helpers/memeChain.js`) and
`test/browser/evmBuyWithExits.js` (the page, with a wallet that really signs).

**Triggers over WebSocket (built 25 November 2026).** Asked for by the owner
on 25 November 2026, after sizing against Chainstack's Growth plan (20 million
requests a month; each pushed log is one). The trade pass fires orders on
DexScreener's price, kept 10 seconds and read every 15, so up to about 25 seconds
late. `src/trade/memeStream.js` fires them on the chain's own events instead,
about a block after they happen (Base: a block every 0.2 s since its Denim
upgrade on 5 November 2026; BNB Chain: every 0.45 s since Fermi, 14 January
2026). It fills them at once, without waiting for the next pass.
- **Narrow on purpose.** Only orders within 15% of their trigger (`arm_pct`, by the
  trade pass's last DexScreener price) are watched, at most 10 pools per chain
  (`max_pools`), the closest first. New blocks are never subscribed: at these
  block times that alone would be about 13 million requests a month on Base.
- **The price is read from the pool's own event**, with no further call:
  - Sync, for Uniswap v2 and PancakeSwap v2 pools, and Aerodrome's form;
  - Swap, for v3 pools (Uniswap and Aerodrome's concentrated pools), and
    PancakeSwap v3's form;
  - Swap on Uniswap v4's PoolManager, filtered by the pool's id (the PoolManager
    is at `0x4985…2b2b` on Base and `0x28e2…e9df` on BNB Chain, checked onchain).

  Which side of the pool the coin is on is settled by the first event, against
  DexScreener's price. A pool whose events don't agree within 30% isn't used
  and stays on polling.
- **Coins on a four.meme curve:** four.meme's events don't index the coin, so the
  stream subscribes the coin's own Transfers instead. After one, it reads the
  curve's quote for each order on the coin, at most once a second.
- **Meme Watch:** for coins with an open Meme Watch exit, the stream subscribes
  Transfers out of their launch-bundle wallets (Meme Watch's groups, 100 wallets
  a filter). Moves inside a group don't count. Each sale is recorded once
  (`meme_insider_sells`, migration 043). When a group's sales since the stream
  started watching reach 20% of what it bought, the coin's exits fire.
- **A price from the stream is confirmed by the fill's own quote** before anything
  is sent: a stop-loss only if the route's price is at or under its trigger
  (2% leeway), a take-profit or limit buy only if at or over it. A trigger the
  quote doesn't confirm goes back to watching, and nobody is alerted. So a
  misread event can't sell anyone's coins early. The user's floor is checked by
  the router as always.
- **A daily budget** (`daily_budget`, 150,000 pushed logs, about 4.5 million a
  month): at it, price and curve subscriptions stop until the next UTC day. The
  insiders' stay, since they're rare. Every subscribe and pushed log is counted
  as the provider bills it, and recorded in `provider_usage` as `ws:<host>` once
  a minute.
- **Nothing depends on it.** The trade pass keeps polling, and catches whatever
  happened while the stream was down. The client reconnects by itself (1 s,
  doubling to 30 s) and subscribes again, and asks the chain id every 4 minutes,
  because Chainstack closes a connection idle for an hour.
- **One instance streams** (a Postgres advisory lock); any other waits on standby.
- **Off until set up:** the provider's WebSocket URLs (`MEME_STREAM_WS_BASE`,
  `MEME_STREAM_WS_BSC`; the key is in the URL, so they go in the environment's
  secret settings), and the switch in the admin panel (Controls, "Order
  triggers over WebSocket"), which starts off. The admin panel's Health tab
  shows the stream and today's count against the budget.

Tests: `test/memeStream.test.js`:
- pool prices from every event form;
- a pool that doesn't agree with DexScreener, not used;
- the stream client's subscribes, routing, counts and reconnects, on a
  stand-in WebSocket;
- end to end on the real database with the stand-in chain:
  - an order not watched far from its trigger, and watched near it;
  - a stream price the quote doesn't confirm, sending nothing;
  - a real fall, filled at once;
  - Meme Watch's insider sales firing its exit (moves inside the group and
    repeated logs not counted);
  - the budget dropping the pool but keeping the insiders;
  - the switch closing the connection.

**Virtuals curve coins on Base (built 25 November 2026).** Asked for by the
owner on 25 November 2026, before the router is deployed, because its exchanges
can't be added afterwards.
- **Orders are in VIRTUAL,** because Virtuals' curve trades in it: a sale's
  `tokenOut` and a limit buy's `tokenIn` are VIRTUAL. The router takes its 1% in
  VIRTUAL. Prices, floors, worst cases and alerts all say VIRTUAL, and the
  triggers use VIRTUAL's price (DefiLlama).
  - A limit buy needs the VIRTUAL already in the wallet: it can't be wrapped
    from ETH, so a wallet that holds too little is told when placing the order.
  - The user's wallet approves the router for it; nothing is wrapped.
- **A fill** calls BondingV5's `buy` or `sell` (with a 5-minute deadline), and
  the router approves FRouterV3 for exactly that fill's input.
  - A sale passes all its coins, since the fee is taken on the VIRTUAL that
    comes out, with Virtuals' own minimum set to the floor grossed up for the fee.
  - A buy passes 99% of its VIRTUAL, with the user's limit as Virtuals' minimum.
  - Quotes come from FRouterV3's `getAmountsOut`, after Virtuals' taxes
    (`launchpads.curveBuyQuote` / `curveSellQuote`).
  - Once the coin graduates, fills go through 0x, still in VIRTUAL.
- **Refused, with the reason:**
  - while Virtuals' anti-sniper tax is running or about to start on the coin;
  - a coin on Virtuals' old curve;
  - a router deployed without Virtuals.
- **Virtuals' contracts are upgradeable proxies** (EIP-1967). Their admin can
  replace the code, so `memeRouterParams.js` records the implementations that
  were checked, and the order service reads them again every 10 minutes. If
  either changes, orders on Virtuals curve coins stop, both new ones and fills
  of open ones, and say why, until the new code is reviewed and the file
  updated.
  - An upgrade can't take a user's coins through the router: the router
    approves a venue only for a fill's own input, resets the approval, and
    checks what reaches the user against the signed minimum.
  - An upgrade could still make fills misbehave, which is why the service stops.
- **The stream** (triggers over WebSocket) watches a coin on Virtuals' curve as
  it does a four.meme one: by the coin's own Transfers, then the curve's quote.

**The check on a copy of Base** (`contracts/scripts/memeRouterVirtualsCheck.js`,
run 25 November 2026 against Base mainnet):
1. The router deploys with the arguments above. Its constructor refuses a venue
   that answers like a token, and BondingV5 and FRouterV3 pass.
2. A signed limit buy of 50 VIRTUAL, filled by the executor on BondingV5, gave
   the user more than their limit. The fee wallet got 0.5 VIRTUAL, and the
   router kept nothing.
3. A fill under the user's limit was refused by the router (`BelowLimit`).
4. Selling all of it back for VIRTUAL paid exactly 1% to the fee wallet.
5. Both proxies' implementations matched the ones recorded.
6. Every 4-byte constant in FRouterV3's code was tried as a function, from the
   router and from a stranger, on a snapshot that was rolled back. Of 73, none
   that changes state answered; the 10 that answered were all reads. So the
   router's approval of FRouterV3 during a fill can't be used by anyone else.

Run it again before deploying, and whenever Virtuals upgrades either contract:
`npx hardhat run scripts/memeRouterVirtualsCheck.js --network baseMainnetFork`.
Tests: `test/virtualsOrders.test.js`.

## What's next

1. **The audit.** Add `RektBullMemeRouter.sol` to `docs/AUDIT_BRIEF.md`'s
   scope, ideally in one engagement with the Trade Router (about 190 lines of
   code).
2. **The trade service**: built (above). At launch: the executor's KMS key,
   funded with a little ETH and BNB, and migration 041.
3. **A Virtuals check on a copy of Base**: done (above). Run it again before
   deploying.
4. **Deployment** from the owner's hardware wallet, per chain, with the
   pre-flight and verify steps of `docs/ROUTER_DEPLOYMENT.md`, and the
   constructor arguments from `src/trade/memeRouterParams.js`
   (`constructorArgs(chain, feeWallet)`).

## Solana: Turnkey, evaluated (11 November 2026)

The question was whether Turnkey's embedded wallets could give Solana
automatic trading with the same guarantee: the user owns the wallet, and
RektBull's server key can sign only trades that pay the user. From Turnkey's
documentation (docs.turnkey.com, and turnkey.com/pricing):

- **Ownership, yes.** Each user gets their own sub-organization and is its
  root user; keys stay in Turnkey's secure enclaves. An app key can be added
  as a non-root "delegated access" user with policies. Policies are checked in
  the enclave before anything is signed, so a hacked app server can't get past
  them. The user can delete that key (revoke) and export their wallet.
- **Policy limits, per transaction only.** A Solana policy can allow only
  certain programs (`solana.tx.program_keys`), check instruction accounts and
  data, and cap plain SOL and SPL transfers by destination and amount. **Daily
  or cumulative caps aren't a policy feature** ("Limits apply per transaction,
  not per day"); they'd need Turnkey's separate Verifiable Cloud sidecar.
- **The deciding gap:** Turnkey's docs say transfers made *inside* another
  program (a pump.fun buy, a Jupiter swap) aren't seen by transfer rules. So a
  policy can say "only pump.fun and Jupiter", but not "and the output goes
  back to the user". Turnkey's own FAQ says allowing a router this way is
  "Not entirely" safe.
- **Cost and speed:** the free plan has 25 free signatures a month, then
  $0.10 a signature. Pro is $99 a month and $0.05 a signature. Both allow 1–3
  requests a second across all users, which is too slow for trading at any
  scale; only the custom Enterprise plan reaches 60.

**Conclusion: not Turnkey alone.** The guarantee has to come from a program
that checks the output, the same as on EVM. **Recommended for Solana:** a small
RektBull order program, the Solana twin of this router:
- the user signs orders (ed25519, checked through Solana's signature
  instruction);
- the user approves the program's own account (a PDA) as an SPL token
  delegate for the amount being sold. Unlike a delegate held by RektBull's
  key, the PDA can only move tokens under the program's rules;
- the program fills an order through pump.fun or Jupiter and checks the
  output reached the user at their price.

**Built (12 November 2026):** [SOLANA_ORDERS.md](SOLANA_ORDERS.md). Orders
are accounts the user creates in the same transaction as the approval,
rather than signed messages, and it was checked against pump.fun's real
program. It needs its own audit. Until then, Solana trading stays approve-each: the
user signs every trade, which phase 4 builds first. Turnkey can still be
looked at later as a wallet for users who have none: an app key whose policy
allows only the RektBull program would sit inside that program's
guarantees.
