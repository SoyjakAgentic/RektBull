/**
 * Protected sending (Trade desk, stage 1): what to offer a wallet as fees, by
 * how fast the user wants their trade in a block, and the private networks
 * that keep trades the user signs out of the public mempool.
 *
 * Speed: 'standard' leaves the fee to the wallet. 'fast' and 'fastest' offer a
 * priority fee at the 75th and 95th percentile of what the chain's last 20
 * blocks paid (eth_feeHistory, the median over those blocks), and a max fee of
 * twice the next block's base fee plus that. The wallet shows the fee and the
 * user can still change it. Arbitrum orders transactions as they arrive, so a
 * priority fee doesn't make a trade faster there: none is offered.
 *
 * Protected networks, from each provider's own documentation (13 November 2026):
 *   Ethereum   Flashbots Protect, https://rpc.flashbots.net/fast (docs.flashbots.net/flashbots-protect/quick-start):
 *              hidden from the public mempool, a reverting transaction isn't included and costs nothing.
 *              It drops a transaction with a priority fee of 0, and a wallet that switches network before
 *              the transaction confirms may resend it publicly.
 *   BNB Chain  PancakeSwap MEV Guard (with bloXroute), https://bscrpc.pancakeswap.finance
 *              (docs.pancakeswap.finance/trading-tools/pancakeswap-mev-guard); or 48 Club's privacy RPC,
 *              https://rpc.48.club (docs.48.club/privacy-rpc), which a page can recognise: eth_call to
 *              0x…0048 answers 0x30 there and an error elsewhere.
 *   Base, Arbitrum  no public mempool: transactions go straight to the sequencer.
 */
const { cached } = require('../lib/cache');
const rpc = require('../providers/rpc');

const SPEEDS = { standard: null, fast: 75, fastest: 95 };
const BLOCKS = 20;

const PROTECTED = {
  ethereum: {
    networks: [{ id: 'flashbots', name: 'Flashbots Protect', rpc: 'https://rpc.flashbots.net/fast', chain_id: '0x1', chain_name: 'Flashbots Protect', currency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, explorer: 'https://etherscan.io', docs: 'https://docs.flashbots.net/flashbots-protect/quick-start',
      what: 'Your trades skip the public mempool, so bots can\'t front-run or sandwich them, and a trade that would fail isn\'t included, so it costs nothing.',
      caveats: ['Don\'t switch your wallet\'s network before a trade confirms: it may send it again publicly.', 'A trade with no priority fee is dropped: use Fast or Fastest, or check your wallet sets one.'] }],
  },
  bsc: {
    networks: [
      { id: 'pancakeswap', name: 'PancakeSwap MEV Guard', rpc: 'https://bscrpc.pancakeswap.finance', chain_id: '0x38', chain_name: 'PancakeSwap MEV Guard', currency: { name: 'BNB', symbol: 'BNB', decimals: 18 }, explorer: 'https://bscscan.com', docs: 'https://docs.pancakeswap.finance/trading-tools/pancakeswap-mev-guard',
        what: 'A private RPC run with bloXroute: your trades skip the public mempool, away from front-running and sandwich bots. Free.', caveats: [] },
      { id: '48club', name: '48 Club Privacy RPC', rpc: 'https://rpc.48.club', chain_id: '0x38', chain_name: '48 Club Privacy RPC', currency: { name: 'BNB', symbol: 'BNB', decimals: 18 }, explorer: 'https://bscscan.com', docs: 'https://docs.48.club/privacy-rpc',
        what: 'Your trades go to 48 Club\'s private builder, not the public mempool, away from sandwich bots.', caveats: ['48 Club says trades may take a little longer to be included.'] },
    ],
    // 48 Club's documented check: a page can tell whether the wallet sends through it.
    detect: { network: '48club', call: { to: '0x0000000000000000000000000000000000000048', data: '0x' }, answer: '0x30' },
  },
  base: { networks: [], note: 'Base has no public mempool: trades go straight to its sequencer, so sandwich bots can\'t see them coming. Nothing to add.' },
  arbitrum: { networks: [], note: 'Arbitrum has no public mempool: trades go straight to its sequencer in the order they arrive. Nothing to add.' },
};

const median = xs => { const s = [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)); return s[Math.floor(s.length / 2)]; };

/**
 * The fees to offer for a speed: { speed, max_fee_per_gas, max_priority_fee_per_gas, base_fee_per_gas } in wei
 * (hex), read from the chain's last 20 blocks (cached 6 seconds), or { speed, none: why } when no fee is offered.
 */
async function suggest(chain, speed) {
  if (!(speed in SPEEDS)) throw Object.assign(new Error(`send_speed must be one of: ${Object.keys(SPEEDS).join(', ')}`), { status: 400 });
  if (!SPEEDS[speed]) return { speed, none: 'Your wallet chooses the fee.' };
  if (chain === 'arbitrum') return { speed, none: 'Arbitrum orders transactions as they arrive: a higher fee doesn\'t make a trade faster, so your wallet chooses the fee.' };
  const h = await cached(`trade:fees:${chain}`, 6, () => rpc.evmRpc(chain, 'eth_feeHistory', ['0x' + BLOCKS.toString(16), 'latest', Object.values(SPEEDS).filter(Boolean)]));
  const col = Object.values(SPEEDS).filter(Boolean).indexOf(SPEEDS[speed]);
  const rewards = (h.reward || []).map(r => BigInt(r[col])).filter(r => r > 0n);
  let priority = rewards.length ? median(rewards) : 0n;
  if (priority < 1n) priority = 1n; // never 0: Flashbots Protect drops those
  const base = BigInt(h.baseFeePerGas[h.baseFeePerGas.length - 1]); // the next block's
  const hex = v => '0x' + v.toString(16);
  return { speed, max_priority_fee_per_gas: hex(priority), max_fee_per_gas: hex(base * 2n + priority), base_fee_per_gas: hex(base), source: `the median ${SPEEDS[speed]}th-percentile priority fee of ${chain}'s last ${BLOCKS} blocks (eth_feeHistory)` };
}

module.exports = { suggest, SPEEDS, PROTECTED };
