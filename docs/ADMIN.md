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
