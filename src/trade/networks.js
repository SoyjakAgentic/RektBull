/**
 * Where autonomous trading runs, keyed by chain id: the Trade Router, the
 * tokens it was deployed with (only these can be traded automatically: each
 * has a Chainlink-style price feed in the router), the exchange it calls,
 * and MetaMask's DelegationManager.
 *
 * Base Sepolia only until the router is audited (docs/SESSION_KEYS.md, 0b).
 * Its tokens, feeds and exchange are test stand-ins from
 * contracts/deployments/base-sepolia.json.
 *
 * AUTO_TRADING_NETWORKS (JSON, same shape) replaces this, e.g. for a local
 * fork in tests.
 */
const { DELEGATOR_CONTRACTS } = require('@metamask/delegation-deployments');

const DEFAULTS = {
  84532: {
    name: 'base-sepolia',
    label: 'Base Sepolia (test network)',
    router: '0x9307067d6a5fc22d1085a2fb16b1385dcc0e6b68',
    venue: { type: 'mock', address: '0x58539f66f95c8a88289247ba9c881ede6d666cf1' },
    tokens: {
      tUSDC: { address: '0x852ced5643c06f4cbec5403d2dbb92113e6ca2a8', decimals: 6 },
      tWETH: { address: '0x113540db537cb7b3131a528281bdadd4708d1806', decimals: 18 },
    },
    defaultBase: 'tUSDC',
    explorerTx: 'https://sepolia.basescan.org/tx/',
  },
};

function load() {
  const raw = process.env.AUTO_TRADING_NETWORKS;
  if (!raw) return DEFAULTS;
  try { return JSON.parse(raw); } catch { throw new Error('AUTO_TRADING_NETWORKS is not valid JSON'); }
}

function network(chainId) {
  const n = load()[String(chainId)];
  if (!n) throw Object.assign(new Error(`automatic trading isn't available on chain ${chainId}`), { status: 422 });
  const mm = DELEGATOR_CONTRACTS['1.3.0'][Number(chainId)];
  if (!mm) throw Object.assign(new Error(`MetaMask's delegation contracts aren't deployed on chain ${chainId}`), { status: 422 });
  return {
    chainId: Number(chainId), ...n, router: n.router.toLowerCase(),
    delegationManager: mm.DelegationManager, delegatorImpl: mm.EIP7702StatelessDeleGatorImpl, mm,
  };
}

/** The router token entry for a symbol or an address, or null. */
function routerToken(net, symbolOrAddress) {
  const k = String(symbolOrAddress || '');
  if (net.tokens[k]) return { symbol: k, ...net.tokens[k], address: net.tokens[k].address.toLowerCase() };
  const hit = Object.entries(net.tokens).find(([, t]) => t.address.toLowerCase() === k.toLowerCase());
  return hit ? { symbol: hit[0], ...hit[1], address: hit[1].address.toLowerCase() } : null;
}

const chainIds = () => Object.keys(load()).map(Number);

module.exports = { network, routerToken, chainIds };
