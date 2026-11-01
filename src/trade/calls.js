/**
 * The transactions a planned trade asks the user's wallet to send, checked
 * (as soyjak-agentic's evmCalls, §651): an approval only ever to 0x's
 * AllowanceHolder and only for this trade's amount, then the swap, only ever
 * through AllowanceHolder. A quote naming any other contract is refused.
 *
 * The user's wallet shows and signs each call itself; RektBull signs nothing.
 */
const { ethers } = require('ethers');
const { tradeChain, NATIVE } = require('./chains');
const { TradeBlocked } = require('./zeroex');

const ERC20 = new ethers.Interface(['function approve(address spender, uint256 amount) returns (bool)']);

function walletCalls(plan) {
  const chain = tradeChain(plan.chain);
  const ah = chain.allowanceHolder;
  const tx = plan.quote.transaction;
  if (!tx || String(tx.to || '').toLowerCase() !== ah) {
    throw new TradeBlocked(`0x returned a transaction to ${tx?.to}, not its AllowanceHolder: not using it.`);
  }
  const sellToken = plan.side === 'buy' ? plan.baseToken.address : plan.token;
  const calls = [];
  const spender = plan.quote.allowanceSpender;
  if (spender) {
    if (String(spender).toLowerCase() !== ah) throw new TradeBlocked(`0x asked for an approval to ${spender}, not its AllowanceHolder: not using it.`);
    if (sellToken === NATIVE) throw new TradeBlocked('0x asked for an approval on the native coin, which has none.');
    calls.push({ step: 'approve', to: sellToken, value: '0x0', data: ERC20.encodeFunctionData('approve', [ah, plan.quote.sellAmount]) });
  }
  const value = BigInt(tx.value || 0);
  if (value > 0n && sellToken !== NATIVE) throw new TradeBlocked('0x asked to send ETH with a trade that doesn\'t sell ETH: not using it.');
  calls.push({
    step: 'swap', to: tx.to, data: tx.data, value: ethers.toQuantity(value),
    ...(tx.gas ? { gas: ethers.toQuantity(BigInt(tx.gas) * 12n / 10n) } : {}),
  });
  return { chainId: ethers.toQuantity(chain.chainId), from: plan.wallet, calls };
}

module.exports = { walletCalls };
