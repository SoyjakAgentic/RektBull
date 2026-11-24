# The Solana order program: automatic meme trades without holding keys

*Status: the program and its tests are built
(`solana/programs/rektbull-orders`, 28 break-it tests, a random-sequence
invariant test, and checks against pump.fun's, PumpSwap's and Jupiter's real
programs on copies of mainnet). **Not audited, not deployed.** The trade
service that uses it is built (24 November 2026, "The trade service" below) and
stays off until then. Nothing may hold real funds through it until an external
audit is done and every finding is fixed or explicitly accepted.*

It is the Solana twin of the EVM Meme Router ([MEME_ROUTER.md](MEME_ROUTER.md)):
the same guarantee, built the way Solana works. Turnkey alone couldn't give
that guarantee: its rules can't see where a swap's output goes (MEME_ROUTER.md,
"Solana: Turnkey, evaluated").

## The promise

A hacked RektBull can only fill a user's order at the user's own price, inside
the order's window, and the output always reaches the user. Nobody holds the
user's keys or their funds between transactions.

## How a user sets up an order

In one transaction the user signs (it can be the same one as a buy, so exits
are in place from the start):

1. **Place the order.** The program creates a small account for the order, at
   an address derived from the user's own key: nobody else can create or cancel
   it. It costs about 0.002 SOL of rent, returned when the order is cancelled
   or filled.
2. **Approve the program's `delegate` address** on the token account being
   sold, for the amount being sold (an SPL `approve`). For a buy paid in SOL,
   the user wraps the SOL first (wrapped SOL is a token account, so it can be
   approved; native SOL can't).

| Order field | Meaning |
|---|---|
| `owner` | Whose order: the input comes only from them, the output goes only to them |
| `executor` | The only key that may fill it: RektBull's trade key |
| `input_mint`, `output_mint` | What to sell and what to buy; `output_native` delivers SOL itself |
| `amount_in` | The most that may be sold, filled at once or in parts |
| `min_amount_out` | The least selling all of `amount_in` must bring the user, after RektBull's fee: a limit price. An order with none is refused |
| `valid_after`, `valid_until` | When it may be filled |

**Why an order account and not a signed message** (the EVM router uses
signatures): on Solana the user has to sign a transaction anyway, for the
`approve`. Putting the order in that same transaction needs no signature
checking in the program, no replay protection (the account is the order),
and nothing for an auditor to get wrong there.

**Stopping:** `cancel_order` closes one order (the user's own transaction).
Revoking the delegate on the token account stops every sell order at once.

## The two program addresses

| Address | Its one job | Why it's separate |
|---|---|---|
| `delegate` (PDA `["delegate"]`) | The only address users approve. It signs one thing: moving a fill's input from the order's owner to `transit` | It never signs anything an exchange sees, so an exchange can't use users' approvals |
| `transit` (PDA `["transit", owner]`, one per user) | Holds a fill's funds during the fill and is the trader on the exchange (pump.fun's `user`, Jupiter's authority) | Nobody ever approves it, and it belongs to one user, so an exchange call signed by it can only reach what this fill put in it, and never another user's exchange-side accounts |

A fill may only call an exchange's swap instructions (`is_swap`: pump.fun's
buys and sells, PumpSwap's, Jupiter's routes), and only transit's signature
reaches the exchange: a fill the owner signed is refused, and the executor's
signature isn't passed on. (The second AI audit, 15 November 2026: with one
shared transit and any instruction allowed, anyone naming themselves executor
of their own order could close transit's pump.fun volume account and take its
rent.)

## How a fill works

`fill(amount_in, unwrap_in, venue_data)`, signed by the order's executor:

1. Checks the executor, the window, the size left, and that the exchange is
   one of the fixed list. The user's price for this part is
   `ceil(min_amount_out × amount_in / order amount_in)`.
2. The delegate moves `amount_in` from the owner's token account (it must be
   theirs, for the order's input token) to transit.
3. With `unwrap_in`, transit's wrapped SOL is unwrapped first (pump.fun's
   curve is bought with SOL) and the account's rent goes back to the executor
   who opened it. When the input is SOL, USDC or USDT, the 1% fee is charged
   after the exchange call, on what the exchange used (`fee_on_used`): unused
   input pays no fee.
4. The exchange call (`venue_data`, with its accounts), signed by transit
   only. The delegate's address may not appear in it at all.
5. The output to the owner: native SOL (everything transit holds, less a 1%
   fee when the output is the base asset) or tokens to the owner's own
   account. PumpSwap and Jupiter pay wrapped SOL, so for an order paying out
   native SOL through them, transit's wrapped-SOL account is closed into SOL
   first (its rent goes back to the executor who opened it). Unused input goes back: tokens to the account they came from, SOL
   to the owner. Transit's token accounts the fill emptied are closed, their
   rent back to the executor who opened them (a Token-2022 account holding
   withheld transfer fees can't close and is left open); the trade service
   opens them again before the next fill (re-review, N-1).
   An input-side fee must fit in what the venue left: a fill that leaves no
   room for it is refused (`NoRoomForFee`, re-review N-2), so the trade service
   leaves the 1% as headroom.
6. **The user's price, on what actually reached them** (the owner's SOL or
   token balance, before and after), and transit must end holding nothing.
7. The fill is added to the order; a completed order closes and its rent goes
   back to the owner.

**Exchanges, fixed in the program:** pump.fun's bonding curve
(`6EF8rrecth…`), PumpSwap (`pAMMBay6oc…`, for graduated pump.fun coins) and
Jupiter v6 (`JUP6LkbZbj…`, any other token with a pool).

## The guarantees, and what enforces them

| Guarantee | Enforced by | If RektBull is hacked |
|---|---|---|
| Only the order's owner can place or cancel it | The program (the order's address comes from the owner's key; the owner signs) | Can't invent orders or change one |
| Only the executor the user named can fill it | The program | A leaked order is useless to anyone else |
| Input comes only from the order's owner, at most the order's size over all fills, and never more than the user approved | The program (`filled_in`, the source's owner) and the token program (the approved amount) | Can't touch other tokens or other users |
| Output and unused input go only to the owner | The program (balance checks; transit holds nothing between transactions) | An exchange paying someone else fails the price check |
| At least the user's price, pro rata, measured on what reaches them | The program | **Worst case: the order filled at the user's own price**, at a time of its choosing within the window |
| Fee at most 1% (`FEE_BPS`), only to the fixed `FEE_WALLET`, on the base-asset side | The program (constants) | Can't raise or redirect it |
| Only the three exchanges are called; only transit signs for them | The program (constant list) | Can't call anything else, or use users' approvals there |
| Which tokens and when to trade; the checks before a buy | RektBull's trade service (off-chain) | Could be bypassed, inside the user's orders |

The program has no admin and no settings. **Its upgrade authority** (who can
replace the code) is the one trust point Solana adds: until the audit it is the
owner's hardware wallet; after the audit and deployment it is removed
(`--final`), so nobody can change the program.

What the stop-loss worst case means is the same as on EVM: a stop-loss is a
sale at a floor, so a hacked RektBull could fill it at the floor while the
market is higher. The order screen says so in plain words.

## Tests

`solana/programs/rektbull-orders/tests/orders.rs` runs the compiled program
on LiteSVM (an in-process Solana chain), with a stand-in exchange
(`programs/mock-venue`) loaded at Jupiter's address. **23 break-it tests:**
- honest fills: a sale for SOL (99% to the user, 1% to the fee wallet, the
  order closed), a buy paid in wrapped SOL and sent as SOL (unused SOL back),
  a buy paid in USDC (the fee in USDC, never in the meme coin), unused token
  input returned;
- a price below the user's limit; an exchange paying someone else;
- partial fills, each pro rata, never more than the order;
- another executor; before and after the window;
- cancel by the owner only (rent back), a cancelled order can't be filled,
  revoking the delegate stops fills;
- an exchange not on the list; orders with no minimum or bad fields;
- an order placed for someone else; an order pointed at someone else's
  approved tokens;
- an exchange trying to use the delegate's or transit's signature on a
  victim's approved tokens; an exchange trying to take the owner's SOL;
- the fee sent anywhere but the fee wallet; the output sent to an account the
  owner doesn't hold;
- stray SOL and tokens sent to transit (they can't jam fills; the next fill
  sweeps them);
- a sale paid in wrapped SOL and delivered as native SOL (the account's rent
  back to the executor), and that unwrapping only works on transit's own
  wrapped-SOL account.

**Random sequences** (the counterpart of the EVM routers' invariant fuzzing):
64 fixed-seed sequences of 40 steps each, covering two users placing orders
(some approved for less than the order), fills at random prices and sizes
through an exchange that sometimes pays someone else, an attacker filling,
cancels by anyone, revokes, time passing and stray funds. After every step:
- no user lost more tokens than their fills sold, and no order was overfilled;
- every fill that went through paid its owner at least their price, with a
  fee of at most 1%;
- the attacker never filled anything, and a bystander who approved the
  delegate lost nothing.

At the end transit holds nothing. In the last run, 182 fills went through and
799 were refused.

**The tests catch real bugs:** with the price check removed, 3 tests fail;
with the delegate allowed to sign an exchange call, the theft test fails.

**Against pump.fun's real program** (`tests/pump_fun.rs`, run by hand:
`python3 -I scripts/pump_fixtures.py` copies pump.fun's program, its fee
program and one live SOL-paired curve from mainnet; then
`cargo test -p rektbull-orders --test pump_fun -- --ignored`). With pump.fun's
current v3 instructions and transit as pump.fun's trader, on 12 November 2026:
- a 0.1 SOL limit buy filled by the executor: 0.001 SOL to the fee wallet,
  3,132,730 tokens (6 decimals) to the user, the unused SOL back to them;
- the same buy with a limit pump.fun couldn't meet: refused (`BelowLimit`);
- a stop-loss sale of everything back for native SOL: 0.000956 SOL to the fee
  wallet (1%), the rest to the user;
- transit left with nothing.

**Found on the way:**
- **pump.fun's volume account.** pump.fun creates a volume-tracking account
  for each trader on their first trade, with rent taken from the trader, which
  here would mean a user's SOL taken mid-fill. Each user has their own transit,
  so the user's first order transaction creates it for their transit
  (`init_user_volume_accumulator`, paid by them and shown on the order screen):
  a 137-byte account, 1,844,400 lamports (about 0.0018 SOL) of rent-exempt
  deposit, once per user and exchange.
- **pump.fun's extra charge.** pump.fun takes a small fixed amount from the
  trader on top of `spendable_quote_in`: 552,720 lamports in this test, the
  same for an ordinary wallet. The trade service simulates each fill and
  leaves that headroom; the unused part comes back to the user.

**Against PumpSwap's and Jupiter's real programs** (`tests/venues.rs`, run by
hand: `python3 -I scripts/venue_fixtures.py` copies a live PumpSwap pool from a
recent buy, and asks Jupiter's public API for two real routes with transit as
the trader, then copies every account and program they touch; then
`cargo test -p rektbull-orders --test venues -- --ignored`). On 13 November 2026:
- **PumpSwap** (a graduated pump.fun coin): a 0.1 wrapped-SOL limit buy, 1% to
  the fee wallet in wrapped SOL, the coin to the user, the unused wrapped SOL
  back; then a stop-loss sale of all of it, delivered as native SOL, 1% to the
  fee wallet. Transactions of 452 and 414 bytes, with RektBull's own address
  lookup table.
- **Jupiter**: wrapped SOL to USDC (routed through Orca Whirlpool): first a
  limit above Jupiter's own quote, refused (`BelowLimit`), then a fill at or
  above the quote. Then USDC back to native SOL (through Raydium CLMM), the
  fee in USDC. Transactions of 821 and 731 bytes, with Jupiter's lookup
  tables.
- Transit left with nothing after each.

**Found on the way:**
- **Fills need address lookup tables.** A fill names the order program's own
  19 accounts plus the exchange's (17 for pump.fun, about 26 for PumpSwap,
  23–25 for Jupiter). A PumpSwap fill without a table is 1,317 bytes, over
  Solana's 1,232-byte limit; pump.fun's fit (1,018 bytes) but with little room
  for priority-fee instructions. So the trade service sends every fill as a
  version-0 transaction, with RektBull's own lookup table of the fixed
  accounts (the program's addresses, the fee wallet, mints, the exchanges'
  global accounts) plus Jupiter's tables for Jupiter routes. All the checks
  now assert their transactions fit.
- **PumpSwap's volume account,** like pump.fun's: created for the user's
  transit in their first order transaction, paid by them.
- **Proprietary AMMs can't be checked on a copy.** Jupiter first routed
  through ZeroFi and BisonFi, whose prices are pushed onchain every slot: a
  copy is stale at once, and their swaps failed in the exchange itself, before
  the order program's checks. The check therefore asks Jupiter for classic
  pools only (Orca, Raydium, Meteora). On mainnet, Jupiter may route through
  any of them; the order program's checks are the same whatever the route.

## The trade service (built 24 November 2026)

Asked for by the owner on 23 November 2026 ("start the order service on
Solana"). Sell orders for SOL first; limit buys followed the same day ("start
limit buys on Solana"), below.

**The orders** (the Trade desk's "Orders on Solana" card, `public/solana-orders.js`):

| Order | Fires | Trades at |
|---|---|---|
| Stop-loss | When the coins' value falls by the user's amount (DexScreener's price of the coin's most liquid pair, SOL's from DefiLlama), checked every trade-service pass | The market, but never below the user's floor (down 35% by default, 15 points under the stop) |
| Take-profit | When it rises by the user's amount | The target less the user's slippage (3% by default), or better |
| Meme Watch exit | When Meme Watch raises a critical alert for the coin: launch-bundle wallets selling (the stream, within seconds, or the 6-hour check), or liquidity pulled. Needs Meme Watch on | The market, but never below the user's floor (down 50% by default) |

| Limit buy | When the coin's price falls by the user's amount (DexScreener's price) | The user's limit less their slippage (3% by default), or more coins |

Each is one order account for a share of what the user holds (up to all of
it), or for a limit buy the SOL they choose to spend, ending after at most 30
days. The floor is the order's `min_amount_out`, after RektBull's 1%, so the
program refuses anything below it.

### Limit buys (built 24 November 2026)

**Placing.** The checks are the Trade desk's for a buy (`trade/solana.js`):
- the per-trade amount;
- RektBull's token check: a critical risk refuses, an unanswered "can it be
  sold?" refuses, and high risks are shown and must be confirmed;
- the bundle check for a coin under a week old;
- selling straight back (Jupiter's quote);
- the wallet's SOL, covering the order, the deposit, new accounts' rent and the
  network fee.

The terms come from what the SOL (less room for the 1%) would buy now: the
trigger is that many coins over (1 − the user's dip), and the limit is the
trigger less their slippage. One transaction for the wallet
(`placeBuyInstructions`):
- the SOL wrapped into the user's own wrapped-SOL account (created when
  missing). The delegate can only be approved on a token account, and wrapped
  SOL is one; the SOL stays in the user's wallet;
- their token account for the coin, created when missing (the program
  delivers only there);
- the volume accounts, once;
- `place_order` (wrapped SOL in, the coin out, the limit as the least);
- `ApproveChecked` of the delegate on the wrapped-SOL account, for this buy
  plus what's left of their other open buys.

The worst case, before signing: "your X SOL buys N coins (your limit less your
slippage), the 1% fee included, at a moment RektBull picks before <date>, even
if the price is lower then". It also says: nothing is bought if the price never
comes down, the SOL stays wrapped until then, and the token check runs again
before each fill.

**Filling.**
1. The token check runs again first: a coin can turn bad after the order was
   placed. A critical risk stops it, and the user is told; a check that can't
   run waits.
2. Jupiter is asked to swap 99% of the part being filled; the program takes
   the 1% in wrapped SOL from what the exchange didn't use (`fee_on_used`),
   and returns anything left to the user's wrapped-SOL account.
3. Nothing is sent when the quote is fewer coins than the user's price for
   this part.
4. The executor opens transit's wrapped-SOL and coin accounts and the fee
   wallet's wrapped-SOL account when missing. The coins go only to the user's
   own account for the coin.

**Cancelling** the last buy on the wrapped-SOL account also revokes the
approval and closes that account, so the SOL is unwrapped back to the user.

**Tested against the program** (`tests/js_client.rs`), from the service's own
code:
- the wrap, approve and place transaction;
- a fill of fewer coins than the limit, refused (`BelowLimit`);
- a fill: the coins to the user, 1% of the SOL the exchange used to the fee
  wallet in wrapped SOL, the order closed and transit left with nothing.

**In `test/solanaOrders.test.js`:**
- the per-trade amount, and high risks needing confirmation;
- the terms, and the transaction decoded (only the user signs; the wrap goes
  into their own account; the approval is only that SOL, to the delegate);
- fired by the price, and stopped by a critical risk found at fill time;
- a quote below the limit not sent;
- the fill's accounts, confirmed from `Filled`, the user told what they bought;
- cancelling, which revokes and unwraps.

### Direct curve fills (built 24 November 2026)

Asked for by the owner on 24 November 2026. While a coin is on a SOL-priced
pump.fun curve, fills go straight to it (`src/trade/pumpCurve.js`):
- a sale with pump.fun's `sell_v3`, its own minimum set so the user keeps their
  floor after the 1%;
- a buy with `buy_exact_quote_in_v3`. The program unwraps the SOL for the curve
  and takes the 1% in SOL. pump.fun is offered 99% of the part, less 0.001 SOL
  of headroom for the small fixed amount it takes from the trader;
- transit is the trader. Jupiter isn't in the path, so its keyless limit (one
  request every two seconds) doesn't hold fills back when many orders fire at
  once, as on a rug. Fills also need fewer accounts: no lookup tables, 1,080
  bytes for a buy and 1,037 for a sale.

**The accounts** are pump.fun's published IDL's (`idl/pump.json`, read 24
November 2026), in its order, and derived as it says:
- the Global account, the coin's curve and its token accounts;
- the fee program's config;
- the event authority;
- transit's volume account (the user's one-time setup).

All of them matched a live mainnet trade. The buyback fee recipient isn't
derived: it is one of the eight in Global's `buyback_fee_recipients`, read from
the chain (kept 10 minutes) and picked at random.

**Pricing** is the simulation's: the whole fill runs first. A floor the curve
can't meet fails there, on pump.fun's own slippage check (`TooLittleSolReceived`)
or the program's (`BelowLimit`). Nothing is sent, and the user is told "about"
what the curve would give. A direct fill that fails for any other reason falls
back to Jupiter in the same attempt. So does a coin whose curve has completed
(moved to PumpSwap), or one priced in something other than SOL.

**Tested against pump.fun's real program** (`tests/pump_js.rs`, by hand:
`python3 -I scripts/pump_fixtures.py && node scripts/pump_js_fixture.js`, then
`cargo test -p rektbull-orders --test pump_js -- --ignored`). With a curve
copied from mainnet on 24 November 2026, the service's own code built:
- the one-time setup: transit's volume account, paid by the user;
- a 0.1 SOL limit buy filled straight on the curve: 913,531,011,902 units to
  the user, 995,482 lamports to the fee wallet;
- a stop-loss filled straight on the curve: 50,127,273 lamports to the user,
  484,260 to the fee wallet;
- a floor of 50 SOL, refused by pump.fun's `TooLittleSolReceived`.

Transit was left with nothing after each. `test/pumpDirect.test.js` checks:
- the addresses against mainnet's;
- the data layouts;
- the service's routing: direct; below the floor, nothing sent; Jupiter on
  another failure or a completed curve.

### Exits with a buy (built 24 November 2026)

Asked for by the owner on 24 November 2026: on the Trade desk, a Solana buy
can carry a stop-loss and/or a take-profit in the same transaction, so the coins
are protected from the moment the buy lands (`trade/solana.js`,
`solanaOrders.exitsForBuy`). The orders are for the coins the buy is sure to
bring (Jupiter's minimum): anything it brings above that isn't covered. Their
value is worked out at the buy's own price.

**The transaction.** After the buy and RektBull's fee, the transaction carries:
- `place_order` for each exit;
- one `ApproveChecked` of the delegate on the user's token account for the
  coin, created by the buy itself;
- once per wallet, pump.fun's and PumpSwap's volume accounts for the user's
  order address.

The simulation runs the whole transaction and reads the orders back.

**Solana's 1,232 bytes.** Measured on a pump.fun route recorded from mainnet:

| The buy carries | Size |
|---|---|
| Nothing else | 754 bytes |
| One order | 1,050 bytes |
| Two orders | 1,234 bytes |
| One order, plus a first order's volume accounts | 1,275 bytes |

RektBull's own lookup table doesn't help here: its overhead cancels the
saving. So the largest set that fits is used:
1. every order asked, with the volume accounts;
2. without them;
3. the stop-loss alone;
4. the buy alone.

The plan says what was left out ("only the stop-loss fitted…"); the rest can be
placed from Orders on Solana once the buy has landed.

**Volume accounts left out to fit: the user pays for them** (the owner's call,
24 November 2026). When they don't fit in the buy's transaction:
- they come in a small setup transaction of their own, signed and paid by the
  user's wallet just before the buy;
- the cost is about 0.0018 SOL each, once per wallet;
- the page says the wallet will ask twice.

RektBull's executor never pays for them. If a fill's route needs one that still
doesn't exist, nothing is sent, and the user is told and shown "Set up" on the
Orders card (`POST /v1/solana/orders/setup`, a transaction they sign). The order
fills once it's done. So a stop-loss is never silently stuck.

**Recorded only when the trade is made.** A preview shows the exits and their
worst case but stores nothing. The trade (one click, or a proposal approved)
records the orders as prepared. They open once the transaction lands, and are
forgotten after 10 minutes if it never does.

**Tested:**
- **`test/buyWithExits.test.js`**, on the recorded route:
  - one stop-loss placed, with its approval for exactly the buy's minimum;
  - both exits for a first-time wallet: the stop-loss alone, saying so, with
    the volume accounts in a setup transaction the user signs and pays for;
  - orders off: the buy alone, saying why;
  - the trade recording its order, while a preview records nothing.
- **`test/solanaOrders.test.js`:** a fill whose route needs a missing volume
  account isn't sent; the user is told, the setup transaction is theirs to sign,
  and once it's done the fill goes (the executor never pays for one).
- **`test/browser/buyWithExits.js`:** the option on the page.

**Placing** (`src/trade/solanaOrders.js` `prepare`, `src/trade/solanaOrderTx.js`):
1. The checks: the coin is a mint, the wallet holds it, Jupiter has a route
   to sell it for SOL (its quote is the value the trigger and floor are worked
   from).
2. One transaction for the user's wallet: `place_order` (naming RektBull's
   executor), an SPL `ApproveChecked` of the program's delegate for this
   order's coins plus what's left of the user's other open orders on the same
   token account (an approval replaces the one before it), and, once per
   user, pump.fun's and PumpSwap's volume accounts for their transit (for a
   pump.fun coin only).
3. It runs in a simulation, and the order account it would write is read back
   and compared with what was asked, before the wallet sees it.
4. **The worst case, in plain words, before the user signs:** "Worst case, even
   if RektBull were hacked: your N coins are sold for X SOL after the 1% fee
   (your floor), at a moment RektBull picks before the end date, even if the
   market is higher then." Also: nothing else can be touched; a price falling
   straight past the floor can't fill and the user keeps the coins; how to stop
   it. The costs: the order's deposit (0.00218544 SOL, returned when it's
   filled or cancelled), the volume accounts once (0.0018444 SOL each), and the
   1% only on a fill.
5. Once the wallet has sent it, the order is read from the chain and compared
   with what was prepared before RektBull watches it (`confirm`; the trade
   service also picks it up by itself). An order that doesn't match is never
   filled.

**Filling** (the trade service, `tick`, every `TRADE_TICK_MS`):
1. Orders are read back from the chain: placed, partly filled, closed (filled
   or cancelled), or past their end date (the user is told, and can cancel to
   get the deposit back).
2. Triggers are checked; a fired order is filled at once, at most 5 a pass.
3. The size: what's left of the order, but no more than the user still holds
   and still approves. Nothing left (sold by hand, or the approval revoked):
   the user is told once, and it's tried again every 5 minutes.
4. The route: Jupiter's `/build` with the user's transit as the taker, 5%
   slippage (Jupiter's own check; the user's floor is the program's). Every
   instruction is checked as for a trade the user signs (`trade/solana.js`):
   Jupiter's swap only, for exactly this amount and these coins, no fee inside,
   paying transit's own wrapped-SOL account; its lookup tables are checked
   against the chain.
5. **Below the floor, nothing is sent:** when the quote, less the 1%, is under
   the user's price for this part, the user is told once and it's tried again
   every 30 seconds while the order is open.
6. The fill transaction (version 0, with Jupiter's lookup tables and RektBull's
   own): transit's token and wrapped-SOL accounts opened by the executor when
   missing (the program returns their rent to it), then `fill`, with Jupiter's
   accounts passed unsigned. It must fit 1,232 bytes, runs in a simulation, and
   gets a compute limit of what it used plus a fifth and a priority fee (the
   75th percentile of what the swap's accounts paid lately, at most 0.001 SOL).
7. The executor signs (KMS, `src/trade/solanaExecutor.js`), the signature is
   logged in `key_signatures`, the fill is recorded, then sent.
8. Next pass: confirmed or failed. A confirmed fill's numbers come from the
   program's own `Filled` event (what reached the user, and the fee); the user
   is told what was sold and for how much. A failed or expired one is tried
   again after 30 seconds.

**The executor** is an Ed25519 key in Google Cloud KMS (`EC_SIGN_ED25519`),
used only by the trade service. KMS signs each transaction's message as given,
and the signature is checked against the key before anything is sent. Off
mainnet only, a throwaway seed (`DEV_SOLANA_EXECUTOR_KEY`) can stand in: it is
refused in production and whenever the RPC's chain is mainnet (by its genesis
hash). It must be the address orders name (`SOLANA_ORDERS_EXECUTOR`).

**Off unless all of these hold:**
- `SOLANA_ORDERS_ENABLED=true`, with the program's, the executor's and the fee
  wallet's addresses set;
- the program is deployed and **can't be upgraded** (its upgrade authority
  removed), read from the chain. A program that can still be upgraded is
  accepted only off mainnet, outside production, with
  `SOLANA_ORDERS_ALLOW_UPGRADEABLE`.

The admin panel's emergency stop for automatic trading stops every fill. Pausing
the Trade desk stops new orders. Neither ever stops a user cancelling.
"Delete my data" asks the user to cancel open orders first.

**Tested:**
- **Against the program itself** (`tests/js_client.rs`). The service's own
  transaction code, run by `scripts/js_client_fixture.js` with test keys, builds
  and signs:
  - placing a stop-loss with its approval;
  - a fill below the user's price, refused (`BelowLimit`);
  - a half fill: 99% to the user as SOL, 1% to the fee wallet;
  - the rest filled, with the order and transit's accounts closed;
  - a second order, its approval covering both;
  - a cancel;
  - a fill of the cancelled order, refused.

  LiteSVM runs them against the compiled program with signatures checked, through
  a stand-in exchange that pays wrapped SOL as Jupiter does. `npm test` checks the
  committed transactions are what today's code builds.
- **The service** (`test/solanaOrders.test.js`), on a real database with a
  stand-in chain and Jupiter:
  - the layouts, maths and worst case, and the executor key's checks;
  - a stop-loss prepared, its transaction decoded (only the user signs; the
    approval is for exactly its coins, to the delegate), then confirmed;
  - fired by its price, with the quote below the floor: nothing sent, the user
    told;
  - the market back: the fill built, signed by the executor alone (checked),
    logged and sent;
  - confirmed from the `Filled` event, filled, the user told;
  - a Meme Watch exit refused without Meme Watch, then fired by its signal;
  - the emergency stop holding every fill;
  - cancelling, which revokes the approval with the last order.
- **The page** (`test/browser/solanaOrders.js`): the reason it's off, the
  worst case before anything is signed, placing from the wallet, cancelling.

## Checks before the audit

- **Clippy** (Rust's linter) with every warning an error, in CI.
- The break-it tests, the random sequences and the deliberate-bug checks
  above, in CI (`.github/workflows/test.yml`, job `solana`). CI builds with
  Agave 4.3.2 and Rust 1.99.0.
- **Security review** of the program, looking at:
  - what an exchange call signed by transit can reach;
  - whether the unwrap rent refund or swept stray funds can move a user's own
    funds to the executor or the fee wallet;
  - fee rounding and re-entry (Solana refuses a call back into the calling
    program).

  No exploitable finding. **Notes for deployment:**
  - the fee wallet must hold at least the rent-exempt minimum of SOL before
    the first fill that pays it in SOL;
  - Token-2022 coins with a transfer hook can't be traded (the program
    doesn't pass a hook's extra accounts). pump.fun's coins don't use hooks;
  - pump.fun's volume rewards for trades through the program accrue to the
    user's own transit's volume account, which the program has no instruction
    to claim. Users trading by hand keep their own. The owner can close that
    account and get its rent back with `close_volume_account` (owner-signed;
    it sends only pump.fun's or PumpSwap's `close_user_volume_accumulator`,
    never from a fill; re-review, N-1);
  - the swap allowlist pins instruction names of three upgradeable programs
    while this one becomes immutable: a future pump.fun `buy_v4`, or a Jupiter
    route variant not on the list, can't be filled (users can only cancel), and
    an upgrade could change what a listed one does; the price check stays the
    backstop (re-review, N-3). The trade service only builds listed variants;
  - transit's token accounts other than `transit_in` and `transit_out` (a
    Jupiter route's intermediate ones) aren't checked for leftovers; a hacked
    executor could park surplus above the user's price there, within the
    documented worst case and only that owner's (re-review, N-4).
- These are not an audit.

## Building

From `solana/`: `cargo build-sbf --arch v0`, then `cargo test -p rektbull-orders`.
The program uses Anchor 0.32.3 and is built as SBF v0, the bytecode every
Solana runtime accepts. The tests run those exact bytes. Moving to a newer SBF
version is a choice to make at deployment.

## Deploying (after the audit)

1. Generate the program's keypair offline, set `declare_id!` to its address
   and `FEE_WALLET` to RektBull's Solana fee wallet (a hardware wallet), then
   freeze the commit for the audit.
2. Fund the fee wallet with at least the rent-exempt minimum.
3. Deploy from the owner's hardware wallet as the upgrade authority; verify
   the deployed bytes match a reproducible build of the audited commit.
4. Remove the upgrade authority (`solana program set-upgrade-authority
   --final`).
5. One-time setup by the executor: RektBull's address lookup table for fills
   (the program's delegate, the fee wallet, wrapped SOL, the token programs,
   Jupiter's program and event authority), then `SOLANA_ORDERS_LOOKUP_TABLE`.
   (Each user's first order transaction creates pump.fun's and PumpSwap's
   volume accounts for their own transit.)
6. The executor's key: an `EC_SIGN_ED25519` key in Cloud KMS, signing rights
   for the trade service's account only. Its public address goes in
   `SOLANA_ORDERS_EXECUTOR` and its version in `KMS_SOLANA_EXECUTOR_KEY_VERSION`.
   Fund it with a little SOL for fills' network fees and transit's account
   rent, which the program returns.
7. Try it on devnet first: the program deployed there, a dev seed for the
   executor, `SOLANA_ORDERS_ALLOW_UPGRADEABLE` while it can still be upgraded.
   Then on mainnet, set `SOLANA_ORDERS_PROGRAM_ID`, `SOLANA_ORDERS_FEE_WALLET`
   and `SOLANA_ORDERS_ENABLED=true`.
8. No private key, seed phrase or program keypair ever goes into the
   repository, a chat or an issue.

## What's next

1. **The audit**, with the EVM contracts or on its own ([AUDIT_BRIEF.md](AUDIT_BRIEF.md)).
   The trade service is in the repository for the auditors to read; it isn't
   trusted by the program.
2. **Then, in the service:**

