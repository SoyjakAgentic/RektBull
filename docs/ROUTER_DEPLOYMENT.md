# Deploying the Trade Router (Base, Ethereum, Arbitrum)

*The owner does this, on their own computer, with a hardware wallet. Nothing
here needs a private key, a seed phrase or a KMS key, and nothing of the kind
may ever be pasted into a chat, an issue or the repository.*

Each chain gets its own copy of two contracts: the **RektBull Trade Router**
and the **RektBull Safe Module**. Same code everywhere; only the settings
differ (its tokens, their price feeds, and the sequencer feed on L2s). The
Yield Router is deployed separately (YIELD_ROUTER.md).

**Not yet:** the Trade Router changed after its November 2026 audit (the
H-1 fix) and the Safe Module was never audited, so both are listed under
`awaitingAudit` in `config/<chain>.json` and the pre-flight refuses them
(AUDIT_BRIEF.md section 8). After the next audit, set `auditedCommit` to the
audited commit and remove those entries.

Neither contract has an owner or admin. Once deployed, the wallet that
deployed it has no power over it; it only pays the gas. The fee wallet only
receives fees.

Start with Base. Ethereum and Arbitrum follow the same steps with their own
name in place of `base`.

## What the scripts check for you

`contracts/scripts/deployRouter.js` refuses to send anything unless every
check passes, and says where each answer came from:

| Check | Source |
|---|---|
| The router and module sources are unchanged since the audited commit | git |
| OpenZeppelin 5.6.1, solc 0.8.24, optimizer 200 runs, viaIR, cancun | node_modules, the compiler's build record |
| The chain id | the RPC |
| Fee ≤ 1%, price bound between 0.01% and 5% | config/&lt;chain&gt;.json |
| The fee wallet is a Safe on this chain, and how many owners must sign | onchain |
| On an L2, the sequencer is up, and has been for more than the router's 1-hour grace period; only Ethereum may have no sequencer feed | Chainlink's L2 Sequencer Uptime feed |
| The 0x AllowanceHolder and Coinbase's Spend Permission Manager have code | onchain |
| Each token's name, symbol and decimals | onchain |
| Each feed's description, decimals, current price and age | onchain |
| Each feed's heartbeat, measured from its last 12 rounds, and the price age the router will accept (more than the heartbeat, at most twice it, longer than any recent gap) | onchain round history; heartbeats as published in Chainlink's reference data directory |
| The deploying wallet has enough ETH | the RPC |
| No `DEPLOYER_PRIVATE_KEY` in the environment | the script refuses to run with one |

After sending, and any time later with `npm run verify:<chain>`, it reads the
deployment back: the code matches the compiled contract (apart from its
settings), every setting matches the config, the router gives a live price for
each token, and the deployment came from the expected wallet.

All of it runs on a copy of each chain in CI (`contracts/test/routerDeploy.test.js`).

## The parameters

Checked onchain on 2026-11-08 (Base) and 2026-11-11 (Ethereum, Arbitrum); the
script checks them again at deployment. Every chain: fee 1%, price bound 2%,
venue 0x AllowanceHolder `0x0000000000001fF3684f28c67538d4D072C22734`, Spend
Permission Manager `0xf85210B21cC50302F477BA56686d2019dC9b67Ad`.

**Base** (`config/base.json`), sequencer feed `0xBCF85224fc0756B9Fa45aA7892530B47e10b6433`:

| Token | Feed | Heartbeat | Price accepted up to |
|---|---|---|---|
| USDC `0x8335…2913` | USDC / USD `0x7e86…bc6B` | 24 h | 25 h |
| WETH `0x4200…0006` | ETH / USD `0x7104…Bb70` | 20 min | 30 min |
| cbBTC `0xcbB7…33Bf` | cbBTC / USD `0x07DA…9f9D` | 20 min | 30 min |

**Ethereum** (`config/ethereum.json`), no sequencer:

| Token | Feed | Heartbeat | Price accepted up to |
|---|---|---|---|
| USDC `0xA0b8…eB48` | USDC / USD `0x8fFf…18f6` | 23 h | 25 h |
| USDT `0xdAC1…1ec7` | USDT / USD `0x3E7d…e32D` | 24 h | 25 h |
| DAI `0x6B17…1d0F` | DAI / USD `0xAed0…1ee9` | 1 h | 90 min |
| WETH `0xC02a…6Cc2` | ETH / USD `0x5f4e…8419` | 1 h | 90 min |
| cbBTC `0xcbB7…33Bf` | cbBTC / USD `0x2665…423A` | 24 h | 25 h |

**Arbitrum** (`config/arbitrum.json`), sequencer feed `0xFdB631F5EE196F0ed6FAa767959853A9F217697D`:

| Token | Feed | Heartbeat | Price accepted up to |
|---|---|---|---|
| USDC `0xaf88…5831` | USDC / USD `0x5083…4aD3` | 4 min | 8 min |
| USDT (onchain name USD₮0) `0xFd08…cbb9` | USDT / USD `0x3f3f…DdE7` | 4 min | 8 min |
| WETH `0x82aF…Bab1` | ETH / USD `0x639F…a612` | 29 min | 45 min |
| WBTC `0x2f2a…5B0f` | WBTC / USD `0xd0C7…6d57` | 24 h | 25 h |
| ARB `0x912C…6548` | ARB / USD `0xb2A8…48D6` | 24 h | 25 h |

Full addresses are in each config file. A price older than its limit makes
the router refuse to trade that token until the feed updates; it never trades
on an old price. WBTC isn't on Ethereum: there's no WBTC / USD feed there,
only WBTC / BTC, and the router takes one feed per token.

## How each chain differs for automatic trading

- **Ethereum:** trades are sent through **Flashbots Protect**
  (`sendRpc` in its config): privately to block builders, so nobody can see a
  trade in the public mempool and trade ahead of it, and a trade that would
  revert is never included. Only one trade is in flight at a time there, since
  the public RPC can't count a private transaction in the key's nonce.
- **Gas:** RektBull's key pays the gas for automatic trades. A buy must be
  large enough that its 1% fee covers that gas, checked when it's queued and
  again with the real estimate before it's sent, and the user is told the
  minimum (on Ethereum often a few hundred to a few thousand dollars; on Base
  and Arbitrum cents). Sells and stop-loss exits are never refused for this.
- **Arbitrum:** like Base, it has a sequencer: the router refuses trades while
  it's down or within an hour of a restart.

## Steps (for each chain)

1. **The fees Safe.** At app.safe.global, create a Safe on that chain whose
   owners are hardware wallets; 2 of 3 is a good choice. It can be the same
   address on every chain if Safe deploys it there with the same setup, but
   it must exist on the chain you're deploying to (the script checks). Its
   address is `FEE_WALLET`, and it can't be changed after deployment.

2. **The deploying wallet.** An account on a Ledger or Trezor with ETH on
   that chain: about 0.01 ETH on Base and Arbitrum; on Ethereum the
   rehearsal estimates it at the current gas price (about 0.006 ETH at a few
   gwei; more when the network is busy).

3. **Frame.** Install Frame (frame.sh), connect the hardware wallet, select
   that account and choose the chain. Frame signs with the hardware wallet and
   never holds a key; the scripts reach it at `http://127.0.0.1:1248`
   (`FRAME_RPC_URL` to change it).

4. **Rehearse, then pre-flight, then send.** On your computer:

   ```sh
   git clone https://github.com/SoyjakAgentic/RektBull && cd RektBull/contracts
   npm ci && npm run build
   npm run deploy:base:rehearse                     # a full deployment on a local copy of the chain; nothing is sent
   FEE_WALLET=0x... npm run deploy:base             # every check against the real chain, and the plan; nothing is sent
   FEE_WALLET=0x... DEPLOY=yes npm run deploy:base  # sends: approve two contract creations on the hardware wallet
   ```

   For the others, use `deploy:ethereum` or `deploy:arbitrum` (and their
   `:rehearse`). The plan (`deployments/<chain>-plan.json`) shows the
   addresses the contracts will get. Each screen on the hardware wallet should
   show a contract creation from your account on that chain. If anything says
   FAIL, stop: nothing was sent.

5. **Verify.** `npm run verify:<chain>` reads everything back and writes
   `deployments/<chain>-source.json`. On the chain's explorer (basescan.org,
   etherscan.io, arbiscan.io), use "Verify and Publish" for each contract:
   Solidity (Standard-Json-Input), compiler `v0.8.24+commit.e11b9ed9`, the
   `input` from that file, and its constructor arguments
   (`routerConstructorArgs`, `safeModuleConstructorArgs`). Commit
   `deployments/<chain>.json` and `deployments/<chain>-plan.json` in a pull
   request.

6. **Switch it on.** `verify:<chain>` prints that chain's
   `AUTO_TRADING_NETWORKS` entry. `AUTO_TRADING_NETWORKS` holds every chain's
   entry in one JSON object (keyed by chain id); add each one as its router
   is deployed, on the API and trade services. Then follow
   [LAUNCH_PLAN.md](LAUNCH_PLAN.md) section 8 from step 2 (the KMS key, the
   trade service, real-wallet testing with small limits). The trade service's
   key needs ETH for gas on each chain.

## If something fails

- **A heartbeat or price check:** Chainlink may have changed the feed. Check
  it on data.chain.link and update config/&lt;chain&gt;.json in a pull
  request; never edit the check to pass.
- **The sequencer feed:** the L2's sequencer restarted within the hour. Wait.
- **A source check:** the router or module changed since the audit. Don't
  deploy; the change needs auditing.
- **Verification after deploying:** don't switch automatic trading on for that
  chain. The contracts hold nothing and have no admin, so nothing is at risk
  while you find out why.
