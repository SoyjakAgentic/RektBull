/**
 * A stand-in chain for the order service's tests (test/memeOrders.test.js, test/evmBuyWithExits.test.js): an RPC
 * provider that answers as the Meme Router (on Base and BNB Chain), the tokens and Multicall3 would, with balances,
 * approvals, receipts, and what was sent.
 */
const { ethers } = require('ethers');
const tx = require('../../src/trade/memeOrderTx');

const E18 = 10n ** 18n;
const ROUTER_BASE = '0x' + '1'.repeat(40);
const ROUTER_BSC = '0x' + '2'.repeat(40);
const AH = '0x0000000000001ff3684f28c67538d4d072c22734';
const TM2 = '0x5c952063c7fc8610ffdb798152d69f0b9550762b';
const WETH = '0x4200000000000000000000000000000000000006';
const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const BULL = '0x' + 'b0'.repeat(20); // a meme coin on Base
const FOUR = '0x' + 'f4'.repeat(20); // a coin on its four.meme curve
const FEE_WALLET = '0x' + 'fe'.repeat(20);
const net = x => x - x / 100n;
const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
const MC = new ethers.Interface(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)']);

/** The stand-in chain: the routers, the tokens, balances, approvals, and what was sent. */
function standIn() {
  const s = {
    tokens: new Map(), // address -> Map(owner -> balance)
    allowances: new Map(), // `${token}:${owner}:${spender}` -> amount
    native: new Map(),
    epoch: new Map(), cancelled: new Set(), filled: new Map(),
    receipts: new Map(), sent: [], calls: [],
    onFill: null, // (order, fill) => throws a revert, or returns
  };
  const routers = { [ROUTER_BASE]: { chainId: 8453, wrapped: WETH, venues: [AH] }, [ROUTER_BSC]: { chainId: 56, wrapped: WBNB, venues: [AH, TM2] } };
  const revert = (name, args) => Object.assign(new Error(`reverted: ${name}`), { data: tx.ROUTER.encodeErrorResult(name, args) });
  s.provider = chainId => ({
    getCode: async a => (routers[a.toLowerCase()] || s.tokens.has(a.toLowerCase()) ? '0x6080' : '0x'),
    getBalance: async a => s.native.get(a.toLowerCase()) ?? 0n,
    getFeeData: async () => ({ maxFeePerGas: 1_000_000_000n, gasPrice: 1_000_000_000n }),
    getTransactionReceipt: async h => s.receipts.get(h) || null,
    broadcastTransaction: async raw => { s.sent.push({ chainId, raw }); },
    // Every eth_call the service makes, recorded; Multicall3's batch answered call by call, as the contract does.
    async call({ to, data }) {
      s.calls.push({ to: to.toLowerCase() });
      if (to.toLowerCase() === MULTICALL3) {
        const [calls] = MC.decodeFunctionData('aggregate3', data);
        const results = [];
        for (const c of calls) {
          try { results.push([true, await answer(c.target, c.callData)]); } catch { if (!c.allowFailure) throw new Error('reverted'); results.push([false, '0x']); }
        }
        return MC.encodeFunctionResult('aggregate3', [results]);
      }
      return answer(to, data);
    },
  });
  const answer = async (to, data) => {
    {
      to = to.toLowerCase();
      if (routers[to]) {
        const r = routers[to];
        const c = tx.ROUTER.parseTransaction({ data });
        const out = v => tx.ROUTER.encodeFunctionResult(c.name, [v]);
        switch (c.name) {
          case 'FEE_BPS': return out(100);
          case 'FEE_WALLET': return out(FEE_WALLET);
          case 'WRAPPED_NATIVE': return out(r.wrapped);
          case 'isVenue': return out(r.venues.includes(c.args[0].toLowerCase()));
          case 'epochOf': return out(s.epoch.get(c.args[0].toLowerCase()) ?? 0n);
          case 'hashOrder': return out(tx.hash(r.chainId, to, tx.order(c.args[0].toObject())));
          case 'cancelled': return out(s.cancelled.has(c.args[0].toLowerCase()));
          case 'filled': return out(s.filled.get(c.args[0].toLowerCase()) ?? 0n);
          case 'fill': {
            const o = tx.order(c.args[0].toObject());
            if (tx.signer(r.chainId, to, o, c.args[1]).toLowerCase() !== o.account.toLowerCase()) throw revert('BadSignature', []);
            if (s.onFill) s.onFill(o, c.args[2].toObject());
            return out(1n);
          }
          default: throw new Error(`unexpected router call ${c.name}`);
        }
      }
      if (s.tokens.has(to)) {
        const c = tx.ERC20.parseTransaction({ data });
        const out = v => tx.ERC20.encodeFunctionResult(c.name, [v]);
        switch (c.name) {
          case 'decimals': return out(18);
          case 'symbol': return out('TKN');
          case 'totalSupply': return out(10n ** 27n); // a billion coins
          case 'balanceOf': return out(s.tokens.get(to).get(c.args[0].toLowerCase()) ?? 0n);
          case 'allowance': return out(s.allowances.get(`${to}:${c.args[0].toLowerCase()}:${c.args[1].toLowerCase()}`) ?? 0n);
          default: throw new Error(`unexpected token call ${c.name}`);
        }
      }
      throw new Error(`unexpected call to ${to}`);
    }
  };
  s.hold = (token, owner, amount) => { if (!s.tokens.has(token)) s.tokens.set(token, new Map()); s.tokens.get(token).set(owner.toLowerCase(), amount); };
  s.approve = (token, owner, spender, amount) => s.allowances.set(`${token}:${owner.toLowerCase()}:${spender.toLowerCase()}`, amount);
  s.revert = revert;
  return s;
}

module.exports = { standIn, E18, ROUTER_BASE, ROUTER_BSC, AH, TM2, WETH, WBNB, BULL, FOUR, FEE_WALLET, net, MULTICALL3, MC };
