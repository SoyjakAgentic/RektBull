# The admin panel (/admin)

For RektBull's owners. Open `/admin` and sign in with a wallet listed in
`ADMIN_WALLETS`.

## The rules

- **Who:** only wallets in `ADMIN_WALLETS`. Anyone else gets "This wallet isn't an admin".
- **A fresh signature:** reading needs any sign-in. Every change needs a sign-in
  from the last 15 minutes; after that the panel asks you to sign in again.
- **A reason, and a log:** every change asks why, and is kept in the change log
  with who made it, when, and the value before and after (`admin_log`).
- **Limits:** each value has bounds, so a typo can't set an audit to $0.
- **What it can't do:** move money, show or change an API key, or change a
  contract. The 1% trade fee and the 0.1% yield fee are fixed in the audited
  contracts.
- **Cost:** no new service. Settings are a few rows in the existing database,
  read again at most once a minute; nothing runs on a timer for the web service.

## Prices

| What | Can change | Limits |
|---|---|---|
| Paid runs (quick check, report, launch check, contract audit, pre-sign check, proposal summary, approval cleanup) | Price, and points where a run takes points | Free ($0: signed in, capped a day) to $1,000; 1 to 100 points |
| Safety Pro, 30 and 365 days | Price | $1 to $1,000 |
| Claim fee | Standard and Safety Pro rate | 0% to 10%; Safety Pro no higher than standard |
| Yield move fee | Nothing | Fixed by the Yield Router |
| Free points | A month, a new wallet's, per IP a day | 0 to 1,000; a new wallet no more than everyone |
| Safety Pro AI allowance | Dollars every 30 days | $0 up to the 30-day pass price |

A new price applies to new purchases; passes already bought keep what they
paid for. Pages, FAQs, structured data, `llms.txt`, the catalog API and the
402 answers all read the current price (page text uses `{{price:<product>}}`
placeholders, filled per request by `payments/catalog.fill()`). "Default"
puts a product back to the price in `src/payments/catalog.js`.

## AI agents

Each agent (the eight on the AI agents tab, Group Guard, Channel Poster and
Contract Audit) is in one of three states:

- **Active:** listed and working.
- **Hidden:** keeps working for anyone already using it and by its direct
  link, but drops out of the lists, the agents page, the sitemap and
  `llms.txt`; its page is `noindex`.
- **Off:** paused. New runs are refused with a plain message (a paid run before
  any charge), schedules stop, and its users get one alert: accounts that had it
  on, each Group Guard group, and each Channel Poster owner. Settings are kept,
  so switching it back on carries on where it was.

## Services

Any service can be paused, or paused and hidden, and switched back on, without
a deploy (`src/admin/services.js`). The owner asked for both on 22 November
2026.

Each service is in one of three states:

- **On:** working and shown.
- **Paused:** new work is refused with a plain message. It's still shown, and
  says so: a paused check's button on the Safety page is off and reads "paused
  for now".
- **Paused and hidden:** also taken off the site.
  - **Removed:** its menu link, tiles, cards and buttons are hidden on every
    page.
  - **Desk pages** (Trade, Perps, Predictions) drop out of the sitemap and
    `llms.txt` and are marked `noindex`. They still open by their link and say
    they're paused, so anyone holding a position can still sell, close or
    redeem there.
  - **Only where there's something to hide:** the panel offers "Pause and
    hide" only for services that have something on the site.
  - **How:** pages mark what belongs to a service (`<!--svc:id-->…<!--/svc:id-->`
    for cards and tiles, `<!--svc-inline:id-->…` for links and buttons). A
    hidden one stays in the page, hidden, so the page's scripts still work.

- **The rule:** pausing stops new work only. Selling, closing, cancelling,
  withdrawing, redeeming and revoking always stay open, as with region blocks.
- **Paid checks:** a paused check is refused before any charge, and before its
  input is even read. The quick check, the token report, the launch check, the
  pre-sign check, the proposal summary and approval cleanup each have a
  switch.
- **Desks:**

  | Desk | Pausing stops | Still open |
  | --- | --- | --- |
  | Trade desk, including Launches buys | Buys, and new automatic-trading permissions and intents | Sells, cancels, revokes |
  | Perps (Hyperliquid) | Opening or adding to positions, leverage and margin changes, new agent approvals | Closing, cancelling, revoking |
  | Predictions (Polymarket) | Buys, approvals, wallet set-up, funding, new automatic trading | Selling, redeeming, withdrawing, stopping automatic trading, sending what was prepared |
  | Yield moves | Deposits and moves, new automatic permissions | Withdrawals to the wallet, revokes |
  | Airdrop and unclaimed-funds finder | New checks and claims | Confirming a claim already sent |
  | Governance votes | New votes | — |
  | Free wallet checkup | New checkups | — |

- **Users see:** a plain message ("… is paused by RektBull for now. Nothing
  was charged. Still open: …"). The Safety page turns a paused check's button
  off, the catalog and the developer reference mark it `paused`, and the API
  answers `503 service_paused`.
- **How a switch is kept:** it's read from the database on every request, so
  it takes effect at once on every instance. Each change needs a reason and is
  logged.
- **Defaults:** the token report starts paused and hidden (`default_state`).
  "Back to the default" stores nothing.
- **Elsewhere:** AI agents, the emergency stops and the AI forecasts and picks
  keep their own switches (above, below, and the AI forecasts card).

## Emergency stops

- **Automatic trading:** no automatic trades or stop-loss / take-profit exits are
  sent, and trades waiting to be sent are cancelled (not kept for later at a
  stale price). Trades already sent are still confirmed.
- **Automatic yield moves:** no automatic deposits or moves are sent.

A stop is read from the database on every pass of the trade service, so it
takes effect within one tick. It never stops a user acting from their own
wallet, and revoking always works.

## Region blocks

Lists of places where trading through RektBull is refused, checked on
RektBull's server before anything is sent to the venue
(`src/compliance/regions.js`). The owner's call of 26 November 2026: RektBull
never sends, or helps send, an order the venue itself wouldn't take from where
the user is.

| List | What it covers | Default |
|---|---|---|
| Hyperliquid perps (`hyperliquid`) | Manual trading: the user's own wallet signs, from their own device | Hyperliquid's own list |
| Hyperliquid automatic and copy trading (`hyperliquid_auto`) | Switching it on, and every automatic open, which RektBull's servers send | Hyperliquid's own list |
| Polymarket (`polymarket`) | Manual trading, wallet set-up, funding and approvals | Polymarket's own list |
| Polymarket automatic entries (`polymarket_auto`) | Switching them on, and every entry, which RektBull's servers send | Polymarket's own list |
| Telegram (`telegram`) | Connecting Telegram from the site, and the Telegram app's pages | No blocks |

- **Automatic trading needs both lists to allow it** (the venue's manual list
  and its automatic one). The venue sees RektBull's server, not the user, so
  these lists are its only check. The user's place is recorded when
  automatic trading is switched on and on each visit, and an automatic open
  isn't sent while it's a blocked place.
- **Telegram** doesn't tell a bot where a user is. Its list applies where the
  user's own device reaches RektBull. A trade from Telegram still needs the
  venue's lists.
- **Meme trading** (the Trade desk, Launches, swaps and orders) has no region
  blocks.

The venues' own lists (each with its source):

- **Hyperliquid:** the United States and Ontario (its Terms of Use), and the
  places under comprehensive US sanctions: Cuba, Iran, North Korea, Syria,
  and Crimea, Donetsk and Luhansk.
- **Polymarket:** its own geoblock list (docs.polymarket.com/api-reference/geoblock):
  - the places it blocks;
  - the places it allows to close positions only, including the US, the UK,
    France, Germany, Italy, Poland, Australia, Singapore and Taiwan;
  - the places its own site limits (Ireland, Japan, the Netherlands, South Korea).

An admin can change any list (country codes such as `US`, region codes such
as `CA-ON` for Ontario), or set it empty, or go back to its default.
Each change needs a reason and is logged (`regions:<venue>`).

- **What a block stops:** opening or adding to a position, leverage and margin
  changes, and new approvals.
- **What it never stops:** viewing markets and your own account, cancelling
  orders, closing positions (reduce-only orders) and taking an approval away.
  A user can always get out.
- **Where the country comes from:** one header, named by `GEO_COUNTRY_HEADER`,
  which the load balancer in front of the app sets. The region within a country
  comes from `GEO_SUBDIVISION_HEADER`, for blocks such as Ontario. No other
  header is trusted, because a browser can send any header it likes.
  - Google Cloud's external HTTPS load balancer: add the custom request
    headers `X-Client-Geo-Location: {client_region}` and
    `X-Client-Geo-Subdivision: {client_region_subdivision}` to the backend
    service. Set `GEO_COUNTRY_HEADER=X-Client-Geo-Location` and
    `GEO_SUBDIVISION_HEADER=X-Client-Geo-Subdivision`.
  - Cloudflare in front: `GEO_COUNTRY_HEADER=CF-IPCountry` and
    `GEO_SUBDIVISION_HEADER=CF-Region-Code` (a managed transform).
  - Cloud Run's own domain mapping adds no country header. **Until one is set
    up, every venue is blocked for everyone, because the venues' own lists are
    on from the start.** Set the header before switching trading on. The
    panel says so, and shows where your own request was read as coming from.
  - Without the region header, a list naming regions of a country (Ontario)
    blocks that whole country (Canada).
- **Unknown country or region:** when a venue has blocks and the request
  carries no country, it's refused. When the list names regions of the
  user's country and the region is unknown, it's refused too. Blocks fail
  closed.
- Changes reach every server within a minute.

## Dashboard and health

- **Dashboard:** money in (deposits, hosted checkouts, x402), fees paid in
  claimed or moved tokens (counted), runs that worked and failed (failed runs
  are never charged), credits spent and refunded, active Safety Pro accounts,
  AI spend by day (estimated at list prices), and accounts. Each figure names
  the table it comes from.
- **Health:** each background job's last success and failure (`job_runs`,
  written by `src/admin/jobs.js`; "late" when it hasn't worked in three of its
  intervals), alert delivery by channel (sent, failed, overdue), and services
  that errored today or are switched off. Nothing here calls an outside
  service.

## External services

For each service: calls and errors today and over 7 days, the last error (with
any key in it cut out), its fallback, and whether each of its keys is **set or
not set**. The panel never shows a key's value and can't set one: keys stay in
Google Secret Manager, and rotating one is a step in the Google Cloud console.

- **Switch off:** RektBull treats the service as unavailable, exactly as if its
  free plan were used up, so its fallback takes over where there is one.
- **Limit a day:** replaces `PROVIDER_DAILY_LIMITS` for that service.
- **Claude:** a daily AI budget in dollars, and a switch. Over the budget or
  switched off, AI runs are refused before any charge.
- **Test now:** one cheap call (counted like any other) where a service has
  one, with the time it took or why it failed.

## Accounts

Look up a wallet or account number: credits, passes, latest runs, the credits
ledger, watched wallets, agents and alert channels. Each action needs a reason
and is logged:

- **Add credits:** up to $500 an action.
- **Refund a run:** only a run that succeeded and was paid with credits, and
  only once (it shares the ref a failed run's automatic refund uses). An x402
  payment is outside RektBull's ledger.
- **Extend Safety Pro:** 1 to 365 days, from the end of the current pass.
- **Block:** the wallet can't sign in, and its sessions stop working within a
  minute. Admin wallets can't be blocked here.

## Tools and banner

- **Site banner:** one notice on every page, plain text (escaped), up to 200
  characters, a notice or a warning, an optional link that must be a page on
  RektBull, and an optional end time within 31 days.
- **Airdrops RektBull added:** stop or start offering each one (logged).
- **Hosted crypto checkouts:** the latest 50.
- The weekly digest's drafts and sponsored posts stay on the Research page's
  review section.
