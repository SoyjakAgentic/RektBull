# Phones first

The owner's direction of 26 November 2026: a mobile-first interface, and a
Telegram trading terminal. This page covers the phone layout. The Telegram
commands are in [HYPERLIQUID.md](HYPERLIQUID.md) ("From Telegram").

## The layout (built 26 November 2026)

- **Tab bar** (`src/pages/header.html`, shown under 720 px wide by `site.css`):
  - **Tabs:** Trade, Launches, Perps, Alerts (the AI agents page) and Account.
  - **Current page:** the tab for the page you're on is marked (`common.js`).
  - **Account:** does what the header's wallet button does.
  - **Safe area:** it sits above the phone's home indicator, and pages end
    above it.
- **Top menu:** stays on one line on phones and scrolls sideways, instead of
  wrapping into rows.
- **Touch:** on touch screens, buttons and selects are at least 44 px tall.
  Text fields use 16 px text, so iOS doesn't zoom in when one is tapped.
- **Installable:** `public/manifest.webmanifest`, linked from every page.
  - It gives a home-screen app that opens standalone, with shortcuts to Trade,
    Launches and Perps.
  - Icons: 192 and 512 px, plus a maskable 512 px with the mark inside the
    safe zone.
  - The service worker (`sw.js`) is the one browser push already uses.

## Wallets on phones

**Today:** on a phone, a wallet connects inside the wallet app's own browser
(MetaMask, Phantom, Solflare, Coinbase Wallet, Trust and others inject it).
In Safari or Chrome with no wallet, the Account tab says so.

**WalletConnect, checked 26 November 2026:** `@walletconnect/ethereum-provider`
2.26.0 and `@reown/appkit-cdn` 1.8.24.

- **The licence:** the WalletConnect Community License (in the package, not MIT).
  - It's free up to **500 monthly active users** (unique wallets connecting in
    30 days) or 2.5 million requests a month. Above either, a paid commercial
    licence from Reown is required, priced on request.
  - It requires the notice "Portions © 2025 Reown, Inc." and a copy of the
    licence.
  - All use must go through Reown's relay network, and modifications to their
    code belong to Reown.
- **The build:** the UMD file needs a dozen other libraries loaded as globals,
  and AppKit's CDN build is 424 ES module files (34 MB). Without a build step,
  it would have to be bundled once into one vendor file.

**The plan put to the owner:**
1. **"Open in your wallet" links now,** with no licence or third party:
   - MetaMask, Trust Wallet, Coinbase Wallet and OKX for EVM chains;
   - Phantom for EVM chains and Solana;
   - Solflare for Solana.
2. **WalletConnect with the Telegram Mini App,** where leaving Telegram for a
   wallet's browser would break the flow. The owner decides on the commercial
   licence as usage nears 500 monthly wallets.

## Tests

- `test/mobile.test.js`: every page carries the tab bar and the manifest link,
  and the manifest's icons exist.
- `test/browser/mobile.js`: run as an iPhone in Chromium.
  - The tab bar is on every page, with the current tab marked.
  - Nothing scrolls sideways, and the menu stays on one line.
  - Account does what the header's button does.
  - Buttons are 44 px tall, and there's no tab bar on a desktop.
