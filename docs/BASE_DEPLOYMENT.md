# Deploying the Trade Router on Base mainnet

*The owner does this, on their own computer, with a hardware wallet. Nothing
here needs a private key, a seed phrase or a KMS key, and nothing of the kind
may ever be pasted into a chat, an issue or the repository.*

This deploys two contracts, both audited (commit `31c9c8c`, AUDIT_BRIEF.md
section 1): the **RektBull Trade Router** and the **RektBull Safe Module**.
The Yield Router is separate and waits for its own audit (YIELD_ROUTER.md).

Neither contract has an owner or admin. Once deployed, the wallet that
deployed it has no power over it; it only pays the gas. The fee wallet only
receives fees.

## What the scripts check for you

`contracts/scripts/deployBase.js` refuses to send anything unless every check
passes, and says where each answer came from:

| Check | Source |
|---|---|
| The router and module sources are unchanged since the audited commit | git |
| OpenZeppelin 5.6.1, solc 0.8.24, optimizer 200 runs, viaIR, cancun | node_modules, the compiler's build record |
| Chain id 8453 | the RPC |
| Fee ≤ 1%, price bound between 0.01% and 5% | config/base.json |
| The fee wallet is a Safe, and how many owners must sign | onchain |
| The sequencer is up, and has been for more than the router's 1-hour grace period | Chainlink's L2 Sequencer Uptime feed |
| The 0x AllowanceHolder and Coinbase's Spend Permission Manager have code | onchain |
| Each token's name, symbol and decimals | onchain |
| Each feed's description, decimals, current price and age | onchain |
| Each feed's heartbeat, measured from its last 12 rounds, and the price age the router will accept (more than the heartbeat, at most twice it, longer than any recent gap) | onchain round history |
| The deploying wallet has enough ETH | the RPC |
| No `DEPLOYER_PRIVATE_KEY` in the environment | the script refuses to run with one |

After sending, and any time later with `npm run verify:base`, it reads the
deployment back: the code matches the compiled contract (apart from its
settings), every setting matches config/base.json, the router gives a live
price for each token, and the deployment came from the expected wallet.

All of this runs on a copy of Base mainnet in CI (`contracts/test/baseDeploy.test.js`),
including the cases where a wrong parameter must be caught.

## The parameters (config/base.json)

Checked onchain on 2026-11-08; the script checks them again at deployment.

| Token | Address | Feed | Heartbeat | Price accepted up to |
|---|---|---|---|---|
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | USDC / USD `0x7e860098F58bBFC8648a4311b374B1D669a2bc6B` | 24 h | 25 h |
| WETH | `0x4200000000000000000000000000000000000006` | ETH / USD `0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70` | 20 min | 30 min |
| cbBTC | `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf` | cbBTC / USD `0x07DA0E54543a844a80ABE69c8A12F22B3aA59f9D` | 20 min | 30 min |

Fee 1%, price bound 2%, sequencer feed `0xBCF85224fc0756B9Fa45aA7892530B47e10b6433`,
Spend Permission Manager `0xf85210B21cC50302F477BA56686d2019dC9b67Ad`, venue
0x AllowanceHolder `0x0000000000001fF3684f28c67538d4D072C22734`.

A price older than its limit makes the router refuse to trade that token until
the feed updates; it never trades on an old price.

## Steps

1. **The fees Safe.** At app.safe.global, create a Safe on Base whose owners
   are hardware wallets; 2 of 3 is a good choice. Its address is `FEE_WALLET`.
   It can't be changed after deployment, so check it twice.

2. **The deploying wallet.** An account on a Ledger or Trezor with about
   0.01 ETH on Base (the rehearsal estimated about 0.005 ETH; gas varies).

3. **Frame.** Install Frame (frame.sh), connect the hardware wallet, select
   that account and choose Base. Frame signs with the hardware wallet and
   never holds a key; the scripts reach it at `http://127.0.0.1:1248`
   (`FRAME_RPC_URL` to change it).

4. **Rehearse, then pre-flight, then send.** On your computer:

   ```sh
   git clone https://github.com/SoyjakAgentic/RektBull && cd RektBull/contracts
   npm ci && npm run build
   npm run deploy:base:rehearse                     # a full deployment on a local copy of Base; nothing is sent
   FEE_WALLET=0x... npm run deploy:base             # every check against the real chain, and the plan; nothing is sent
   FEE_WALLET=0x... DEPLOY=yes npm run deploy:base  # sends: approve two contract creations on the hardware wallet
   ```

   The plan (`deployments/base-plan.json`) shows the addresses the contracts
   will get. Each screen on the hardware wallet should show a contract
   creation from your account on Base. If anything says FAIL, stop: nothing
   was sent.

5. **Verify.** `npm run verify:base` reads everything back and writes
   `deployments/base-source.json`. On basescan.org, use "Verify and Publish"
   for each contract: Solidity (Standard-Json-Input), compiler
   `v0.8.24+commit.e11b9ed9`, the `input` from that file, and its constructor
   arguments (`routerConstructorArgs`, `safeModuleConstructorArgs`).
   Commit `deployments/base.json` and `deployments/base-plan.json` in a pull request.

6. **Switch it on.** `verify:base` prints the `AUTO_TRADING_NETWORKS` entry
   for Base. Set it on the API and trade services, then follow
   [LAUNCH_PLAN.md](LAUNCH_PLAN.md) section 8 from step 2 (the KMS key, the
   trade service, real-wallet testing with small limits).

## If something fails

- **A heartbeat or price check:** Chainlink may have changed the feed. Check
  it on data.chain.link and update config/base.json in a pull request; never
  edit the check to pass.
- **The sequencer feed:** Base's sequencer restarted within the hour. Wait.
- **A source check:** the router or module changed since the audit. Don't
  deploy; the change needs auditing.
- **Verification after deploying:** don't switch automatic trading on. The
  contracts hold nothing and have no admin, so nothing is at risk while you
  find out why.
