# RektBull: testing with real wallets

*Every automated test drives the wallets with stand-ins: test keys, a forked
chain, and a fake wallet in the browser. Before mainnet, a person has to go
through each wallet's real screens once. This is the checklist. It uses Base
Sepolia (test money only), plus one small approve-each trade on Base mainnet.*

Fill in the **Record** lines as you go and paste the finished checklist into
a GitHub issue. Anything that doesn't match **Expect** is a finding, even if
the trade still worked.

## 0. Set up (once)

**You need:**
- Docker (Docker Desktop on a Mac or Windows).
- A browser with the wallet under test. Use a **fresh test wallet or account**
  for each wallet type, never one holding real funds (except in section 5).
- A little Base Sepolia ETH in each test wallet for gas (any Base Sepolia
  faucet; 0.01 ETH is plenty).
- A free 0x API key from dashboard.0x.org.

**A throwaway session key.** On test networks RektBull may sign with a plain
key instead of Google Cloud KMS. Make a new one; never reuse it:

```bash
node -e "const w=require('ethers').Wallet.createRandom();console.log(w.privateKey, w.address)"
```

Send the printed address about 0.01 Base Sepolia ETH: the session key pays
gas for automatic trades.

**`.env`** (next to `docker-compose.yml`; start from `.env.local.example`):

```bash
ZEROEX_API_KEY=...                 # from dashboard.0x.org
SWAP_FEE_WALLET_EVM=0x...          # your own address is fine for testing
DEV_SESSION_KEY=0x...              # the throwaway key above (testnets only)
SESSION_KEY_ADDRESS=0x...          # its address; must match, or RektBull refuses to sign
# Optional: your own RPC instead of the public one
# RPC_URLS_BASE_SEPOLIA=https://...
```

`docker-compose.yml` already sets `TRADING_ENABLED=true` and local sign-in.

```bash
docker compose up --build
```

Open **http://localhost:8080/trade** in the browser with the wallet.

| | Expect | Record |
|---|---|---|
| 0.1 | The app logs that it's listening on 8080; no "can't reach database" | |
| 0.2 | `/trade` loads; the wallet is offered under "Connect" | wallet name and version: |

**Contracts used** (Base Sepolia, from `contracts/deployments/base-sepolia.json`):
Trade Router `0xc791690584E69023cb7f68c5214988371f31211b`, RektBull Safe
Module `0xbEB7CFa95a005A18Eb571BfdCb97CaF6Bd462F81`, Coinbase Spend Permission
Manager `0xf85210B21cC50302F477BA56686d2019dC9b67Ad`. Check each address your
wallet shows against these.

## 1. Sign in (every wallet)

| | Step | Expect | Record |
|---|---|---|---|
| 1.1 | Connect, then **Sign in with this wallet** | The wallet shows a readable "Sign-In with Ethereum" message for `localhost:8080`, not raw hex | screenshot |
| 1.2 | Sign | "Signed in." | |
| 1.3 | Safe and Coinbase only: sign in with the smart wallet itself (Coinbase) or a Safe owner (Safe) | Works once the wallet is deployed onchain (checked with EIP-1271). **Not supported yet:** a Coinbase wallet that has never sent a transaction (not deployed) signs with EIP-6492, which RektBull doesn't check; if sign-in fails, send any small transaction first and record it | deployed before? result: |

## 2. MetaMask (EIP-7702 smart account)

Select **MetaMask** as the wallet type.

| | Step | Expect | Record |
|---|---|---|---|
| 2.1 | In MetaMask, switch the test account to a **smart account** on Base Sepolia (Account details → Smart account, or accept MetaMask's prompt) | MetaMask explains the upgrade and shows MetaMask's own delegator contract, not a RektBull address. The address stays the same | screenshot; tx hash: |
| 2.2 | Reload `/trade` | "✓ This wallet is a MetaMask smart account on the test network." | |
| 2.3 | Set limits (leave the defaults $500 / $10,000) → **Save limits from my wallet** | MetaMask asks to call `setLimits` on the router `0xc791…211b` | |
| 2.4 | Set a daily limit of 25000 | The page asks you to type 25000 before anything goes to the wallet | |
| 2.5 | **Get 1,000 test tUSDC** | A `mint` call on tUSDC; the balance shows in MetaMask after you import the token | |
| 2.6 | **Let the router trade my test tokens** | One `approve` per test token, spender the router, amount sized to your limits (not unlimited) | amounts shown: |
| 2.7 | **Sign the permission** | MetaMask shows a delegation signature (typed data) naming RektBull's session key, with the router as the only target and `swap` as the only method, and an expiry. **Write down exactly how MetaMask presents this:** this is what real users will see | screenshot: |
| 2.8 | Queue an automatic buy of $50 of tWETH | Status moves from queued to done; the history shows a Basescan link | tx hash: |
| 2.9 | Open the tx on sepolia.basescan.org | `Swapped` event; tWETH arrives in **your** account; 1% fee to the fee wallet; nothing goes to the session key | |
| 2.10 | Queue a buy of $600 (above the per-trade limit) | Refused with a clear reason about the per-trade limit; no transaction | message: |
| 2.11 | **Stop all automatic trading**, then queue another buy | MetaMask asks to call `revoke` on the router; the next trade is refused | |

## 3. Safe

Create a Safe on Base Sepolia at app.safe.global (1-of-1 is fine; try 2-of-2
once if you can). Fund it with a little Base Sepolia ETH. Select **Safe** as
the wallet type and sign in with an owner.

| | Step | Expect | Record |
|---|---|---|---|
| 3.1 | Give the Safe test tokens: in Safe{Wallet}'s Transaction Builder, call `mint(address,uint256)` on tUSDC `0xa77eb22934917d94d09c4d96d508ecf8f40129b3` with the Safe's address and `1000000000` (1,000 tUSDC, 6 decimals), using ABI `[{"type":"function","name":"mint","inputs":[{"name":"to","type":"address"},{"name":"amount","type":"uint256"}],"outputs":[],"stateMutability":"nonpayable"}]` | Safe shows the tokens | |
| 3.2 | Enter the Safe's address → **Get my Safe's setup transactions** | Five calls: enable the module, two approvals to the router, `setLimits`, `setSession` | |
| 3.3 | Submit them from Safe{Wallet} (Transaction Builder, one batch) | Safe{Wallet} shows a warning for **enabling a module**. Note how loud it is: users will see it | screenshot: |
| 3.4 | **Link my Safe** | Linked; the page shows the module and session key are set | |
| 3.5 | Try linking a Safe you don't own | Refused: not an owner | |
| 3.6 | Queue a $50 buy of tWETH | Done; tWETH lands in the **Safe** | tx hash: |
| 3.7 | In Safe{Wallet}, Settings → Modules | The RektBull module is listed; disabling it is one Safe transaction | |
| 3.8 | Call `revoke()` on the module from the Safe (Transaction Builder), then queue a trade | Refused (`NotSessionKey`), shown as a readable message | message: |

## 4. Coinbase Smart Wallet

Use a Coinbase Smart Wallet (keys.coinbase.com passkey wallet, or the
Coinbase Wallet app in smart-wallet mode) on Base Sepolia. Select **Coinbase**
as the wallet type and sign in with the smart wallet.

| | Step | Expect | Record |
|---|---|---|---|
| 4.1 | Get test tUSDC: switch the type to MetaMask for a moment and use **Get 1,000 test tUSDC** (it mints to the signed-in address), then switch back | tUSDC in the wallet | |
| 4.2 | **Set up from my wallet** | One batch (`wallet_sendCalls`): `setLimits`, `setOperator` on the router, and a spend-permission approval per test token on Coinbase's Spend Permission Manager, spender the router | screenshot: |
| 4.3 | **The open question:** does Coinbase let this website make the batch? The first time, it adds the Spend Permission Manager as an owner of the wallet. Coinbase may block that for an unknown site | allowed / blocked, and the exact message: |
| 4.4 | **Link my wallet** | Linked; spend permissions found for the router | |
| 4.5 | Queue a $50 buy of tWETH | Done; tWETH lands in the **Coinbase wallet**; the router keeps nothing | tx hash: |
| 4.6 | Check the wallet's own "spend permissions" screen, if it has one | The permissions are listed with the router as spender and can be revoked there | |
| 4.7 | Revoke one permission in the wallet, then queue a trade in that token | Refused with a readable reason | message: |

**If 4.3 is blocked:** stop here and record it. The fallback is asking users
to grant the permission through Coinbase's own spend-permission screen; that
is a product decision, not a workaround to code around.

## 5. One small real trade on Base mainnet (approve-each)

This is the ordinary manual path: you approve and sign every trade yourself,
RektBull holds nothing, no session key and no router involved. Use **$5–10**
from a normal wallet.

| | Step | Expect | Record |
|---|---|---|---|
| 5.1 | On `/trade`, check a trade: buy $5 of WETH with USDC | The token check names its sources; the plan shows the 1% fee and the minimum you'll receive | |
| 5.2 | **Approve and sign in my wallet** | Approval for exactly the trade amount (not unlimited), spender 0x's AllowanceHolder `0x0000000000001fF3684f28c67538d4D072C22734`, then the swap | amount approved: |
| 5.3 | Check the tx on basescan.org | WETH arrives in your wallet; ~1% goes to `SWAP_FEE_WALLET_EVM` | tx hash: |
| 5.4 | Wait for "confirmed" on the page | The history shows it confirmed | |

## 6. Troubleshooting

| You see | Usually means |
|---|---|
| "Automatic trading is not set up yet (SESSION_KEY_ADDRESS)" | `SESSION_KEY_ADDRESS` missing from `.env`; restart `docker compose` after editing |
| "the session key is 0x…, but SESSION_KEY_ADDRESS says 0x…" | `DEV_SESSION_KEY` and `SESSION_KEY_ADDRESS` don't match |
| "no session key configured" | `DEV_SESSION_KEY` missing |
| A queued trade fails with "insufficient funds" | The session key has no Base Sepolia ETH for gas |
| "Trading needs a 0x API key" | `ZEROEX_API_KEY` missing |
| `StalePrice` | The test feeds are too old for the router's max age; tell the maintainers (the test deployment allows a year) |
| `OverTradeLimit` / `OverPeriodLimit` / `Expired` / `LimitsOff` | Working as intended: raise the limits, save new ones, or set limits first |
| `SequencerDown` | Base's sequencer was down or restarted within the hour; wait |
| `BeforeSpendPermissionStart` (Coinbase) | The wallet's clock is ahead of the chain; wait a few minutes |
| The page can't be reached | Use `http://localhost:8080` on the same computer as Docker; it isn't exposed to the network |

## 7. When it's done

- Open an issue titled "Real-wallet test: <wallet>, <date>" with the filled
  checklist and screenshots.
- Every finding becomes its own issue; anything that shows users something
  misleading blocks mainnet.
- Delete the throwaway session key. It has signed only on testnets, but don't
  keep it.
