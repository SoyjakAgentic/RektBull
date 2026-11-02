# RektBull contracts

The **RektBull Trade Router** (`contracts/RektBullTradeRouter.sol`): the only
contract a RektBull trading permission may call. Design and reasoning:
[../docs/SESSION_KEYS.md](../docs/SESSION_KEYS.md).

On every trade it enforces onchain:
- the bought tokens go to the caller (the user's own account), nowhere else;
- the fee is at most 1% (`MAX_FEE_BPS`, a constant), paid only to the fixed fee wallet;
- the output is within `MAX_SLIPPAGE_BPS` (at most 5%, deployed at 2%) of the
  Chainlink reference price, so a bad price can't move value out;
- the trade fits the caller's own limits (per trade and per period in USD,
  plus an expiry), which only the caller can set or revoke;
- prices are fresh, and on L2s the sequencer has been up for at least an hour.
- selling tokens the router bought for the user, up to the amount bought,
  doesn't count toward the limits, so an exit is never blocked; everything
  else does.

No owner, no admin, no upgrades: venues, tokens, price feeds, the fee and the
fee wallet are fixed at deployment. Funds are only pulled from `msg.sender`.

**Not audited yet.** Do not deploy to mainnet or send real funds until the
external audit (milestone 0b) is done and every finding is fixed.

## How a user grants a permission

1. Upgrade their wallet to a MetaMask smart account with EIP-7702 (same address).
2. Approve the router for the tokens they want traded, and call
   `setLimits(perTradeUsd, perPeriodUsd, periodSeconds, validUntil)` from
   their own wallet.
3. Sign a MetaMask delegation to RektBull's session key with four caveats:
   `RedeemerEnforcer` (only RektBull's key), `TimestampEnforcer` (expiry),
   `AllowedTargetsEnforcer` (only the router), `AllowedMethodsEnforcer` (only
   `swap`, so not `setLimits` or `revoke`).

Revoke: `revoke()` on the router stops all trading at once; disabling the
delegation in MetaMask's DelegationManager also stops it.

## Tests

```bash
npm install
npm test        # runs on a copy of Base Sepolia, against MetaMask's real deployed contracts
```

Also here: the **RektBull Safe Module** (`contracts/RektBullSafeModule.sol`),
which lets RektBull's session key make a Safe call the router's `swap` and
nothing else, and the router's `swapWithSpendPermission`, which trades for a
Coinbase Smart Wallet through a Coinbase spend permission granted to the router.
Their break-it tests are in `test/walletsBreakIt.test.js`; see
[../docs/SESSION_KEYS.md](../docs/SESSION_KEYS.md), milestone 3.

Also here: **`SignInCheck6492.sol`**, never deployed. The service runs its
creation code in a read-only `eth_call` to check sign-in from a Coinbase Smart
Wallet that hasn't been deployed yet (EIP-6492). The service carries a copy of
the code in `src/auth/signInCheck6492.json`; after changing the contract, run
`npm run export:signin-check` (`test/signInCheck.test.js` fails if the copy is
stale).

Built with **Hardhat 3** (ES modules: `"type": "module"`, `hardhat.config.js`
uses `defineConfig`). The forked copy of Base Sepolia is the `default`
network; tests and scripts get it with `await network.create()`, and a
standalone node is `npx hardhat --network default node`. Tests use Node's
built-in test runner (`node:test`) through `@nomicfoundation/hardhat-node-test-runner`.

Known audit findings with no fix released yet (Nov 2026): `zod` inside
Hardhat 3 (memory use when validating very large input; here it only
validates our own config), and `uuid` inside MetaMask's delegation library
(only affects a calling style that library doesn't use).

`test/breakIt.test.js` tries every way a hacked RektBull could take funds or
break a limit; all must fail. Set `BASE_SEPOLIA_RPC_URL` to use your own RPC
instead of the public one.

## Deploy (testnet)

```bash
DEPLOYER_PRIVATE_KEY=0x... npm run deploy:base-sepolia
```

Deploys the router with **test** tokens, price feeds and exchange (testnets
have no real liquidity), runs one real delegated trade and one refused attack,
and writes the addresses to `deployments/base-sepolia.json`. The script
refuses to run on any chain but Base Sepolia.

Mainnet deployment is a separate, audited step, run by you from a hardware
wallet, with real Chainlink feeds and 0x as the venue.

## Live on Base Sepolia (testnet)

| | |
|---|---|
| Trade Router | [`0xc791690584E69023cb7f68c5214988371f31211b`](https://sepolia.basescan.org/address/0xc791690584E69023cb7f68c5214988371f31211b) |
| RektBull Safe Module | [`0xbEB7CFa95a005A18Eb571BfdCb97CaF6Bd462F81`](https://sepolia.basescan.org/address/0xbEB7CFa95a005A18Eb571BfdCb97CaF6Bd462F81) |
| Coinbase Spend Permission Manager (Coinbase's) | [`0xf85210B21cC50302F477BA56686d2019dC9b67Ad`](https://sepolia.basescan.org/address/0xf85210B21cC50302F477BA56686d2019dC9b67Ad) |
| EIP-7702 upgrade of a test wallet | [tx](https://sepolia.basescan.org/tx/0x99bd2ef35e2d386b3ba095e583ecad2d337843221acb38c13f6669fc834550cc) |
| A delegated trade by the session key (1% fee taken) | [tx](https://sepolia.basescan.org/tx/0x3b8c0bb7b27b8e936ac2285009e989716d2345358f07f7f3c35ab0b3445eeed2) |
| The session key trying to take the user's tokens | Refused by MetaMask's `AllowedTargetsEnforcer` (simulated, no gas) |

Deployed 2026-11-02 with test tokens, price feeds and exchange. The
test price feeds never update, so this deployment accepts prices up to a year
old (`TEST_FEED_MAX_AGE` in `scripts/deploy.js`); mainnet uses real Chainlink
feeds with their own heartbeat. Full addresses: `deployments/base-sepolia.json`.
Source not yet verified on Basescan. Earlier test routers
(`0x9307067d6a5FC22d1085A2Fb16B1385DCC0E6B68`, `0x800C3172fbA781aD7747b24A2F45f11a20b1C193`)
are retired.
