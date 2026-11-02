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
| Trade Router | [`0x9307067d6a5FC22d1085A2Fb16B1385DCC0E6B68`](https://sepolia.basescan.org/address/0x9307067d6a5FC22d1085A2Fb16B1385DCC0E6B68) |
| EIP-7702 upgrade of a test wallet | [tx](https://sepolia.basescan.org/tx/0x9d184dabed0d053edfd09127b07693e62ca15b09115db629a6224b9d24be006a) |
| A delegated trade by the session key (1% fee taken) | [tx](https://sepolia.basescan.org/tx/0x3539ab456d634594d859c9a4d97e783e12c718e8f18298cce2fb948fa1bea33d) |
| The session key trying to take the user's tokens | Refused by MetaMask's `AllowedTargetsEnforcer` (simulated, no gas) |

Deployed 2026-11-01 with test tokens, price feeds and exchange. Full
addresses: `deployments/base-sepolia.json`. Source not yet verified on Basescan.
