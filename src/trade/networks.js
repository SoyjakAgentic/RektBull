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
    router: '0xc791690584e69023cb7f68c5214988371f31211b',
    venue: { type: 'mock', address: '0xc82ed04e1e2a1fca59329e8f122d06a3afa75345' },
    tokens: {
      tUSDC: { address: '0xa77eb22934917d94d09c4d96d508ecf8f40129b3', decimals: 6 },
      tWETH: { address: '0x992fdc153a2973eb30ed8c0886e0e263ee52c8cb', decimals: 18 },
    },
    defaultBase: 'tUSDC',
    // Milestone 3: Safe (RektBull Safe Module) and Coinbase Smart Wallet (Coinbase's Spend Permission Manager).
    safeModule: '0xbeb7cfa95a005a18eb571bfdcb97caf6bd462f81',
    spendPermissionManager: '0xf85210b21cc50302f477ba56686d2019dc9b67ad',
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
