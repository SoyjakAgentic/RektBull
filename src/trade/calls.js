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

/** The checked 0x swap call (only ever through AllowanceHolder), with its approval when 0x asks for one. */
function zeroexCalls(plan, ah, sellToken, { step, alwaysApprove = false } = {}) {
  const tx = plan.quote.transaction;
  if (!tx || String(tx.to || '').toLowerCase() !== ah) throw new TradeBlocked(`0x returned a transaction to ${tx?.to}, not its AllowanceHolder: not using it.`);
  const out = [];
  const spender = plan.quote.allowanceSpender || (alwaysApprove ? ah : null);
  if (spender) {
    if (String(spender).toLowerCase() !== ah) throw new TradeBlocked(`0x asked for an approval to ${spender}, not its AllowanceHolder: not using it.`);
    if (sellToken === NATIVE) throw new TradeBlocked('0x asked for an approval on the native coin, which has none.');
    out.push({ step: 'approve', to: sellToken, value: '0x0', data: ERC20.encodeFunctionData('approve', [ah, plan.quote.sellAmount]) });
  }
  const value = BigInt(tx.value || 0);
  if (value > 0n && sellToken !== NATIVE) throw new TradeBlocked('0x asked to send ETH with a trade that doesn\'t sell ETH: not using it.');
  out.push({ step, to: tx.to, data: tx.data, value: ethers.toQuantity(value), ...(tx.gas ? { gas: ethers.toQuantity(BigInt(tx.gas) * 12n / 10n) } : {}) });
  return out;
}

/**
 * A Virtuals curve trade: only ever approvals to Virtuals' FRouter for this trade's amount, and calls
 * to its Bonding contract, around the checked 0x leg. The curve call is the step named 'swap' (the one
 * whose transaction confirms the trade).
 */
function curveCalls(plan, chain) {
  const lp = require('../services/launchpads');
  const r = plan.route;
  if (r.bonding !== lp.ADDR.bonding || r.frouter !== lp.ADDR.frouter || r.virtual !== lp.VIRTUAL) throw new TradeBlocked('The curve route names a contract RektBull doesn\'t use: not using it.');
  const ah = chain.allowanceHolder;
  const calls = [];
  if (plan.side === 'buy') {
    calls.push(...zeroexCalls(plan, ah, plan.baseToken.address, { step: 'to_virtual' }));
    calls.push({ step: 'approve', to: r.virtual, value: '0x0', data: ERC20.encodeFunctionData('approve', [r.frouter, r.virtual_in]) });
    calls.push({ step: 'swap', to: r.bonding, value: '0x0', data: lp.BONDING.encodeFunctionData('buy', [r.virtual_in, plan.token, r.min_out, r.deadline]) });
  } else {
    calls.push({ step: 'approve', to: plan.token, value: '0x0', data: ERC20.encodeFunctionData('approve', [r.frouter, r.amount]) });
    calls.push({ step: 'swap', to: r.bonding, value: '0x0', data: lp.BONDING.encodeFunctionData('sell', [r.amount, plan.token, r.min_virtual, r.deadline]) });
    calls.push(...zeroexCalls(plan, ah, r.virtual, { step: 'from_virtual', alwaysApprove: true }));
  }
  return { chainId: ethers.toQuantity(chain.chainId), from: plan.wallet, calls, confirm_step: 'swap' };
}

/**
 * A four.meme curve trade (BNB Chain): only ever calls to four.meme's TokenManager2 and an approval to
 * it for this trade's amount, around the checked 0x leg. A buy sends exactly the BNB it names; a sale's
 * fee goes only to RektBull's own fee wallet, at most 1%. The curve call is the step named 'swap'.
 */
function fourMemeCalls(plan, chain) {
  const lp = require('../services/launchpads');
  const env = require('../config/env');
  const r = plan.route;
  if (r.token_manager !== lp.FOURMEME.tokenManager) throw new TradeBlocked('The curve route names a contract RektBull doesn\'t use: not using it.');
  const tm = r.token_manager;
  const ah = chain.allowanceHolder;
  const calls = [];
  if (plan.side === 'buy') {
    if (BigInt(r.funds) !== plan.quote.minBuyAmount) throw new TradeBlocked('The curve buy doesn\'t match the BNB its swap delivers: not using it.');
    calls.push(...zeroexCalls(plan, ah, plan.baseToken.address, { step: 'to_bnb' }));
    calls.push({ step: 'swap', to: tm, value: ethers.toQuantity(BigInt(r.funds)), data: lp.TOKEN_MANAGER.encodeFunctionData('buyTokenAMAP', [plan.token, r.funds, r.min_out]) });
  } else {
    const fee = Number(r.fee_bps || 0);
    if (fee > 100 || (fee > 0 && String(r.fee_recipient || '') !== String(env.swapFeeWalletEvm || '').toLowerCase())) throw new TradeBlocked('The curve sale names a fee RektBull doesn\'t charge: not using it.');
    calls.push({ step: 'approve', to: plan.token, value: '0x0', data: ERC20.encodeFunctionData('approve', [tm, r.amount]) });
    const data = fee > 0
      ? lp.TOKEN_MANAGER.encodeFunctionData('sellToken(uint256,address,uint256,uint256,uint256,address)', [0, plan.token, r.amount, r.min_funds, fee, r.fee_recipient])
      : lp.TOKEN_MANAGER.encodeFunctionData('sellToken(uint256,address,uint256,uint256)', [0, plan.token, r.amount, r.min_funds]);
    calls.push({ step: 'swap', to: tm, value: '0x0', data });
    if (r.bnb_to_base) calls.push(...zeroexCalls(plan, ah, NATIVE, { step: 'from_bnb' }));
  }
  return { chainId: ethers.toQuantity(chain.chainId), from: plan.wallet, calls, confirm_step: 'swap' };
}

function walletCalls(plan) {
  const chain = tradeChain(plan.chain);
  if (plan.route?.kind === 'virtuals_curve') return curveCalls(plan, chain);
  if (plan.route?.kind === 'fourmeme_curve') return fourMemeCalls(plan, chain);
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
