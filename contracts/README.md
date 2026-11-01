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
