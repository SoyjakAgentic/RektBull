# RektBull browser extension

Checks what your wallet is about to sign, before it shows it: transactions
(simulated), permits, Permit2 and Seaport signatures, sign-in messages,
`eth_sign`, and the site itself. A risky request stops with a warning that
says why and names the source of every fact; a safe one goes straight to the
wallet. Manifest V3; Chrome, Brave and Edge (Chromium).

## How it works

| File | Runs in | Does |
|---|---|---|
| `inpage.js` | the page's own world, before any page script | wraps `window.ethereum` and EIP-6963 wallets; holds checked requests until RektBull answers |
| `bridge.js` | the extension's isolated world | hands `inpage.js` an HMAC key before page scripts run, verifies every message both ways, shows the warning in a closed shadow root, forwards to the background |
| `background.js` | the extension's service worker | holds the link token and settings, calls `POST /v1/presign/check`, keeps the badge on unread monitor alerts |
| `popup.html/js` | the toolbar popup | link status, free checks or Safety Pro, unread alerts, settings |

- **A page can't fake RektBull's answer**: decisions are HMAC-signed with a
  key the page never sees, so a forged "allow" is ignored; forged check
  requests are ignored too (no checks spent).
- **If a check can't run** (not linked, out of free checks, RektBull
  unreachable), the request goes to the wallet as it would without the
  extension, with a short note. It never blocks signing on its own failure.
- **Limits**: a page that reaches into a wallet's private methods, or that
  the wallet serves from its own popup (e.g. a WalletConnect session on
  another device), isn't seen. Your wallet's own screen is always the last
  word.

## Develop

1. `chrome://extensions` → Developer mode → **Load unpacked** → this folder.
2. In the popup → Advanced, set the RektBull address to your local server
   (`http://localhost:8080`), then open `http://localhost:8080/extension`,
   sign in and **Link**.
3. Test: `TEST_DATABASE_URL=… node test/browser/extension.js` (loads this
   folder into Chromium and drives a test dapp).

## Publish (Chrome Web Store, $5 once; Edge Add-ons free)

1. `npm run extension:zip` (needs `zip`) → `rektbull-extension.zip`.
2. Chrome Web Store developer dashboard → New item → upload the zip.
3. Permissions to justify in the listing:
   - **content scripts on all sites**: wallet requests come from any site;
     only signing requests are read, and only when one is made;
   - **storage**: the link token and settings;
   - **alarms**: refreshing the unread-alerts badge every 30 minutes;
   - **host access to rektbull.com**: the API.
4. Privacy policy URL for the listing: **https://rektbull.com/privacy**
   (`public/privacy.html`; set `OPERATOR_NAME` and `PRIVACY_CONTACT` first).
   In the store's privacy form: it handles "website content" (only the
   signing request and the site's origin, when a site asks to sign) and
   "authentication information" (the account link); not sold, not used for
   anything but the check, not used for creditworthiness or ads.
5. Bump `version` in `manifest.json` for every upload.
