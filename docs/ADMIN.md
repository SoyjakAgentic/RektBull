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
| Paid runs (quick check, report, launch check, contract audit, pre-sign check, proposal summary, approval cleanup) | Price, and points where a run takes points | $0.01 to $1,000; 1 to 100 points |
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

## Emergency stops

- **Automatic trading:** no automatic trades or stop-loss / take-profit exits are
  sent, and trades waiting to be sent are cancelled (not kept for later at a
  stale price). Trades already sent are still confirmed.
- **Automatic yield moves:** no automatic deposits or moves are sent.

A stop is read from the database on every pass of the trade service, so it
takes effect within one tick. It never stops a user acting from their own
wallet, and revoking always works.

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
