# Private submission of order fills

Built 25 November 2026. Code: `src/trade/privateSend.js`, used by the two order
services (`src/trade/memeOrders.js` on BNB Chain and Base,
`src/trade/solanaOrders.js` on Solana). Migration 044.

## Why

RektBull's executor fills the orders users sign: stop-losses, take-profits,
Meme Watch exits and limit buys. Each fill carries the user's own minimum (their
floor or limit), which the Meme Router or the order program enforces. A fill
sent the usual way waits in a public mempool, where a bot can see it and trade
on both sides of it (a "sandwich"). That pushes the fill down to the user's
minimum. Nothing below the minimum can happen, but every order would fill at the
worst price the user allowed, not the market's.

A private route hands the signed fill to block builders or validators without
broadcasting it, so there's nothing to watch.

## Per chain

| Chain | Route | Default |
|---|---|---|
| BNB Chain | Privacy RPCs: the same signed transaction to each at once | 48 Club (`https://rpc.48.club`) and BlockRazor's full-privacy mode (`https://bsc.blockrazor.xyz/fullprivacy`) |
| Solana | Jito's `sendTransaction` with `bundleOnly=true`: a single-transaction bundle | `https://mainnet.block-engine.jito.wtf` |
| Base | The usual way | None: its sequencer orders transactions, and it has no public mempool to watch |

**Sources (read 25 November 2026):**
- BNB Chain's MEV user guide (docs.bnbchain.org, "BSC MEV, User Guide",
  dated 29 May 2026) lists 48 Club's, BlockRazor's, PancakeSwap's and Merkle's
  privacy RPCs as free. It gives the average time to inclusion through them as
  about 4 to 5 seconds.
- 48 Club's page (docs.48.club/privacy-rpc) says transactions go to its
  Puissant builder's private mempool without being broadcast publicly.
- BlockRazor's page (blockrazor.io/rpc/bsc) says its full-privacy mode needs
  no key, forwards transactions directly to builders, protects against
  reverts, and shares nothing with searchers. BlockRazor's other modes share
  transactions with searchers for backruns and refund part of the profit to
  the sender. Here that would be RektBull's executor, not the user, so they
  aren't used.
- Jito's low-latency send docs (docs.jito.wtf/lowlatencytxnsend) cover the
  send itself:
  - `bundleOnly=true` sends a transaction as a single-transaction bundle with
    revert protection.
  - Bundles must tip at least 1,000 lamports, in the same transaction as the
    work, and never to a tip account taken from a lookup table.
  - The limit is one request a second from an address.
  - There are 8 tip accounts (`getTipAccounts`), plus a tip floor
    (`bundles.jito.wtf/api/v1/bundles/tip_floor`) of what landed bundles paid.

PancakeSwap's and Merkle's pages didn't load when checked, so neither is a
default. Any privacy RPC can be added with `MEME_PRIVATE_SEND`.

## How a fill is sent

**BNB Chain:**
1. **Nonce.** The executor's nonce is the higher of two numbers:
   - the chain's own count;
   - one past the last fill still out there.

   The chain's public RPC can't see transactions it was never sent, so the
   service counts them itself. Each nonce is recorded with its fill
   (`meme_order_fills.nonce`).
2. **Send.** The signed fill is recorded first, as before, with the signed
   transaction itself (`raw_tx`, which holds nothing secret). It then goes to
   every privacy RPC at once. The relays that took it are recorded (`relays`).
   It's one signed transaction, so only one copy can land.
3. **If every relay refuses,** it's sent the usual way at once (`public_at`).
4. **If it hasn't landed after `PRIVATE_SEND_GRACE_MS` (12 seconds),** the same
   signed transaction is sent the usual way as well. It has the same hash and
   nonce, so it still lands once at most. The trade service runs every 15
   seconds, so in practice that's the next pass.
5. **If the usual way refuses it too** (not "already known" or "nonce too
   low", which mean it's out there or it landed), it can't land. Nor can the
   executor's later fills on that chain, whose nonces come after it. They are
   all marked failed with the reason and filled again, with fresh nonces, in
   the same pass. A later fill that still landed somehow can't harm anyone:
   the router never fills more than the order signed, and its read-back
   records what was filled.

**Solana:**
1. **Tip.** The fill gets one more instruction: a SOL transfer from the
   executor to one of Jito's 8 tip accounts, picked at random. The tip account
   is named in the transaction itself, never taken from a lookup table.
   - The tip is what bundles that landed lately paid (Jito's tip floor, read
     at most once a minute).
   - A stop-loss or a Meme Watch exit tips the 75th percentile, since those
     must land. Others tip the median.
   - It's always between Jito's minimum of 1,000 lamports and
     `SOLANA_JITO_TIP_MAX_LAMPORTS` (200,000 lamports, 0.0002 SOL, by default).
   - RektBull's executor pays it, like the network fee, and only if the fill
     lands.
2. **Send.** It goes to Jito as a single-transaction bundle. Sends are at least
   1.1 seconds apart, for Jito's limit.
   - If adding the tip would make the fill bigger than Solana's 1,232 bytes, it
     goes the usual way without a tip.
   - If Jito's tip accounts can't be read, it also goes the usual way without
     a tip.
3. **If Jito refuses it,** it's sent the usual way at once (`public_at`).
4. **If it hasn't landed after the grace period,** the same signed transaction
   (same signature, so it lands once at most) is sent the usual way as well.
   The blockhash expiry still applies as before.

**Never a reason to wait.** A relay or Jito being down, refusing or slow
never holds an exit. The fallback is the usual way, which is what every fill
did before this. The user's floor or limit protects them the same either way.

**Every call is counted** (`usage.track`: `private-send:<host>` and `jito`).
Jito's tip accounts and tip floor are cached (`lib/cache`).

## Settings

- **`MEME_PRIVATE_SEND`:** JSON, chain to privacy RPC URLs, e.g.
  `{"bsc":["https://rpc.48.club","https://bsc.blockrazor.xyz/fullprivacy"]}`.
  Use `{}` for none. Only `https://` URLs count.
- **`SOLANA_JITO_URL`:** Jito's block engine, global or regional (Jito lists
  Amsterdam, Dublin, Frankfurt, London, New York, Salt Lake City, Singapore
  and Tokyo). Use `off` for none.
- **`SOLANA_JITO_TIP_MAX_LAMPORTS`:** the most one fill tips (default 200,000).
- **`PRIVATE_SEND_GRACE_MS`:** how long a private fill has to land before it's
  also sent the usual way (default 12,000).

Unset, production (`NODE_ENV=production`, as the Dockerfile sets it) uses the
defaults above. Anywhere else uses none, so tests and development never reach
these services.

None of these is a secret. No key is needed for the defaults.

## Tests

- **`test/memeOrders.test.js`, step 9** (BNB Chain):
  - each fill goes to both privacy RPCs and not the public mempool, with the
    same signed transaction to each;
  - the second fill's nonce comes after the first, which the chain's RPC
    can't see;
  - within the grace period nothing is sent the usual way; after it, the same
    transaction is;
  - when the usual way refuses the earlier fill, both fail and the later is
    filled again at once with a fresh nonce;
  - when both relays refuse, the fill is sent the usual way at once.
- **`test/solanaOrders.test.js`, steps 3 and 7:**
  - a stop-loss goes to Jito as a bundle, tipping the 75th percentile from the
    executor to a tip account named in the transaction;
  - after the grace period, the same transaction is sent the usual way;
  - when Jito refuses a limit buy (tipping the median), it's sent the usual way
    at once.
- **`test/privateSend.test.js`:** the module's own rules:
  - only `https://` relays count;
  - "already known" counts as accepted;
  - the tip's bounds;
  - Jito sends are spaced a second apart;
  - a refusal is reported, not thrown.
