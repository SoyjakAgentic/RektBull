# The Meme Router: automatic meme trades without holding keys

*Status: the contract and its break-it tests are built
(`contracts/contracts/RektBullMemeRouter.sol`, 17 tests in
`contracts/test/memeRouter.test.js`, plus the fuzz tests and Slither below), and checked against four.meme's real
contracts on a copy of BNB Chain. **Not audited, not deployed, and the trade
service doesn't use it yet.** Nothing may hold real funds through it until an
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
| Only exchanges fixed at deployment are called or approved, and only for this fill's input | The contract (immutable list; approval reset after each call) | Can't call anything else |
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

`fill(order, signature, { amountIn, venue, spender, venueCalldata, unwrapIn })`, called by the executor:
1. Checks the executor, the window, the epoch and cancellation, the
   signature, the size left, and that the venue and spender are allowed.
2. Pulls `amountIn` of `tokenIn` from the account.
3. Takes the fee: from the output when it's a base asset (USDC, USDT, WETH,
   WBNB, the native coin), otherwise from the input. So buys and sells pay in
   the base asset; only an order from one meme coin straight into another
   (which the trade service doesn't offer) would pay in a meme coin.
4. Calls the venue: approves exactly this fill's input to `spender` (reset
   afterwards), or with `unwrapIn`, unwraps WBNB/WETH and sends it as native
   (four.meme's curve is bought with BNB). Unused native comes back wrapped.
5. Sends the output, and any unused input, to the account.
6. Checks what reached the account against the user's price, pro rata,
   after the fee.

**Exchanges, per chain** (fixed at deployment): 0x's AllowanceHolder
everywhere (any token with a pool, graduated curve tokens included), four.meme's
TokenManager2 on BNB Chain, and Virtuals' Bonding contract with its FRouter on
Base.

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

## What's next

1. **The audit.** Add `RektBullMemeRouter.sol` to `docs/AUDIT_BRIEF.md`'s
   scope, ideally in one engagement with the Trade Router (about 190 lines of
   code).
2. **The trade service.**
   - An `orders` table, and an order screen showing the worst case in plain
     words before the user signs.
   - The approval to the router, for exactly the amount being sold.
   - A watcher that fills take-profits, stop-losses and Meme Watch exits
     through the KMS trade key, simulating each fill first.
   - The 1% covers the gas RektBull pays, as on the Trade Router.
3. **A Virtuals check on a copy of Base**, like the four.meme one.
4. **Deployment** from the owner's hardware wallet, per chain, with the
   pre-flight and verify steps of `docs/ROUTER_DEPLOYMENT.md`.

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

It needs its own audit. Until then, Solana trading stays approve-each: the
user signs every trade, which phase 4 builds first. Turnkey can still be
looked at later as a wallet for users who have none: an app key whose policy
allows only the RektBull program would sit inside that program's
guarantees.
