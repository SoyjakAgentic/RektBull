# The Solana order program: automatic meme trades without holding keys

*Status: the program and its tests are built
(`solana/programs/rektbull-orders`, 23 break-it tests, a random-sequence
invariant test, and checks against pump.fun's, PumpSwap's and Jupiter's real
programs on copies of mainnet). **Not audited, not deployed, and the trade service doesn't use it
yet.** Nothing may hold real funds through it until an external audit is done
and every finding is fixed or explicitly accepted.*

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
| `transit` (PDA `["transit"]`) | Holds a fill's funds during the fill and is the trader on the exchange (pump.fun's `user`, Jupiter's authority) | Nobody ever approves it, so an exchange call signed by it can only reach what this fill put in it |

## How a fill works

`fill(amount_in, unwrap_in, venue_data)`, signed by the order's executor:

1. Checks the executor, the window, the size left, and that the exchange is
   one of the fixed list. The user's price for this part is
   `ceil(min_amount_out × amount_in / order amount_in)`.
2. The delegate moves `amount_in` from the owner's token account (it must be
   theirs, for the order's input token) to transit.
3. The fee, when the input is SOL, USDC or USDT: 1% to the fee wallet. With
   `unwrap_in`, transit's wrapped SOL is unwrapped first (pump.fun's curve is
   bought with SOL) and the account's rent goes back to the executor who
   opened it.
4. The exchange call (`venue_data`, with its accounts), signed by transit
   only. The delegate's address may not appear in it at all.
5. The output to the owner: native SOL (everything transit holds, less a 1%
   fee when the output is the base asset) or tokens to the owner's own
   account. PumpSwap and Jupiter pay wrapped SOL, so for an order paying out
   native SOL through them, transit's wrapped-SOL account is closed into SOL
   first (its rent goes back to the executor who opened it). Unused input goes back: tokens to the account they came from, SOL
   to the owner.
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
  here would mean a user's SOL. The trade service creates it once for transit
  (`init_user_volume_accumulator`, paid by the executor) before the first fill:
  a 137-byte account, 1,844,400 lamports (about 0.0018 SOL) of rent-exempt
  deposit, paid once in all, since every fill trades through the same transit.
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
- **PumpSwap's volume account,** like pump.fun's: created once for transit by
  the executor (`init_user_volume_accumulator`), so no user's SOL pays its rent.
- **Proprietary AMMs can't be checked on a copy.** Jupiter first routed
  through ZeroFi and BisonFi, whose prices are pushed onchain every slot: a
  copy is stale at once, and their swaps failed in the exchange itself, before
  the order program's checks. The check therefore asks Jupiter for classic
  pools only (Orca, Raydium, Meteora). On mainnet, Jupiter may route through
  any of them; the order program's checks are the same whatever the route.

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
  - pump.fun's volume rewards for trades through the program accrue to
    transit's volume account, which nobody can claim. Users trading by hand
    keep their own.
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
5. One-time setup by the executor: pump.fun's and PumpSwap's volume accounts
   for transit, and RektBull's address lookup table for fills.
6. No private key, seed phrase or program keypair ever goes into the
   repository, a chat or an issue.

## What's next

1. **The trade service:** an `orders` table; an order screen that states the
   worst case before the user signs; the place-and-approve transaction (with
   the buy, for exits); a watcher that fills through the KMS trade key
   (Ed25519), simulating each fill first and sizing pump.fun's headroom, and
   sending fills as version-0 transactions with lookup tables.
2. **The audit**, with the EVM contracts or on its own ([AUDIT_BRIEF.md](AUDIT_BRIEF.md)).
