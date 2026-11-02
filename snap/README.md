# RektBull Snap for MetaMask

The RektBull pre-sign check inside MetaMask's own confirmation screen.
Before you confirm a transaction or a signature, MetaMask shows what
RektBull found: the verdict, every finding with its source, what the
simulation says would leave and reach your wallet, and what couldn't be
checked. A high or critical verdict is shown as a warning MetaMask makes you
read first. New risk monitor alerts become MetaMask notifications (checked
every 30 minutes), and the Snap's home page shows your free checks or Safety
Pro and the latest alerts.

It holds no keys and can't sign or send anything. Its link token (from
rektbull.com) is kept in MetaMask's encrypted Snap storage and can only run
checks and read alerts.

## Permissions, and why

| Permission | Why | Needs MetaMask's review |
|---|---|---|
| `endowment:transaction-insight` (with origin) | Show the check on transaction confirmations | No |
| `endowment:signature-insight` (with origin) | Show the check on signature requests | No |
| `endowment:network-access` | Call the RektBull API (`/v1/presign/check`, `/v1/me`, `/v1/monitor/alerts`) | **Yes** |
| `endowment:rpc` (only `https://rektbull.com`) | Let rektbull.com link and unlink your account | **Yes** |
| `endowment:cronjob` (every 30 min) | Turn new monitor alerts into notifications | No |
| `endowment:page-home` | The Snap's home page | No |
| `snap_manageState` | Keep the link token, encrypted | No |
| `snap_notify` | Alert notifications | No |

No key-management methods are used, so no third-party audit is required.

## Develop and test

```bash
npm ci
npm test          # builds a test bundle, runs the snaps-jest suite, rebuilds the production bundle
npm run serve     # serves the Snap at http://localhost:8081
```

Try it in **MetaMask Flask** (the developer build, which installs Snaps that
aren't allowlisted yet): open `https://rektbull.com/extension?snap=local:http://localhost:8081`
(or your local RektBull with that query), sign in, and press **Install and link
the RektBull Snap**. The production bundle only ever talks to rektbull.com;
only the test build (`SNAP_ENV=test`) accepts another API address.

## Publish

1. Bump `version` in `package.json` **and** `snap.manifest.json` (they must match).
2. `npm test` (rebuilds the production bundle and fixes the manifest's shasum),
   then `npm publish --access public` (the `@rektbull` npm scope must exist).
3. Get allowlisted (needed for network access): make the source public (this
   repository), remove unused permissions, scan with Snapper and fix what it
   finds, then fill in the MetaMask Snaps Directory form (name "RektBull",
   descriptions, repository and npm links, the version, support contact,
   images, a demo video). The MetaMask Snaps team reviews it; at least two
   approvals are needed. Every new version is resubmitted.
4. Until it's allowlisted, regular MetaMask won't install it; Flask will.
