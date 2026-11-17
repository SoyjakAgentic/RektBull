/**
 * A user's Polymarket wallet: which kind it is, its address, what it has
 * approved, and the wallet transactions RektBull prepares for it to sign
 * (docs.polymarket.com/trading/wallets-auth and trading/positions/manage).
 *
 * A Deposit Wallet's transactions are a signed EIP-712 `Batch` that
 * Polymarket's relayer sends, gas paid by Polymarket. The relayer wants a
 * Builder API key, so RektBull's server forwards the batch with its own key:
 * it forwards only batches it prepared itself and stored (polymarket_batches),
 * signed by the account's own wallet. It can't change one (the signature
 * covers every call) and it holds nothing of the user's.
 *
 * An EOA sends the same calls itself, as Polygon transactions. For legacy
 * Proxy and Safe wallets Polymarket documents no raw relayer payload ("use an
 * SDK"), so RektBull prepares none: orders only.
 */
const crypto = require('crypto');
const { ethers } = require('ethers');
const db = require('../config/db');
const env = require('../config/env');
const pm = require('../providers/polymarket');
const rpc = require('../providers/rpc');
const { cached } = require('../lib/cache');
const { CHAIN_ID, C, APPROVALS, WALLET_TYPES } = require('./contracts');

const MAX = ethers.MaxUint256;
const ERC20 = new ethers.Interface(['function approve(address spender, uint256 amount) returns (bool)', 'function allowance(address owner, address spender) view returns (uint256)', 'function balanceOf(address) view returns (uint256)', 'function transfer(address to, uint256 amount) returns (bool)']);
const ERC1155 = new ethers.Interface(['function setApprovalForAll(address operator, bool approved)', 'function isApprovedForAll(address account, address operator) view returns (bool)']);
const POSITIONS = new ethers.Interface([
  'function redeem(bytes31 conditionId, uint256 outcomeIndex, uint256 amount)',
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
]);
const RAMP = new ethers.Interface(['function wrap(address _asset, address _to, uint256 _amount)', 'function unwrap(address _asset, address _to, uint256 _amount)']);
const SESSION = new ethers.Interface(['function authorizeSessionSigner(address sessionSigner, uint256 validUntil)', 'function revokeSessionSigner(address sessionSigner)']);
const BATCH_TYPES = {
  Call: [{ name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }],
  Batch: [{ name: 'wallet', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'calls', type: 'Call[]' }],
};
const DOMAIN_TYPE = [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }];
// Solady's ERC-1967 beacon proxy (with immutable args), as deployed for every Deposit Wallet since 29 June 2026.
const PROXY_RUNTIME = '0x363d3d373d3d363d602036600436635c60da1b60e01b36527fa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50545afa5036515af43d6000803e604d573d6000fd5b3d6000f3';
const SESSION_DAYS_HOURS = 4315; // Polymarket accepts exactly "now + 180 days" (the docs' example: 4,315 hours)
const BATCH_SECONDS = 600;

class WalletRefused extends Error {
  constructor(message, status = 422, code = 'wallet_refused') { super(message); this.status = status; this.code = code; this.isWalletRefused = true; }
}
const lower = a => String(a || '').toLowerCase();
const isAddress = a => /^0x[0-9a-fA-F]{40}$/.test(String(a || ''));

/**
 * The Deposit Wallet address of a signing key (docs: "Derive a Deposit Wallet Address"):
 * CREATE2 from the factory, salt keccak(abi.encode(factory, bytes32(signer))), beacon-proxy init code.
 * Wallets deployed before 29 June 2026 are a different proxy at a different address.
 */
function depositWalletAddress(signer) {
  const args = ethers.AbiCoder.defaultAbiCoder().encode(['address', 'bytes32'], [C.depositWalletFactory, ethers.zeroPadValue(signer, 32)]);
  const init = ethers.concat(['0x61', ethers.toBeHex(0x52 + 64, 2), '0x3d8160233d3973', C.depositWalletBeacon, '0x60195155f3', PROXY_RUNTIME, args]);
  return ethers.getCreate2Address(C.depositWalletFactory, ethers.keccak256(args), ethers.keccak256(init));
}

const call = async (to, data) => rpc.evmRpc('polygon', 'eth_call', [{ to, data }, 'latest']);

/** Which of the eight trading approvals `wallet` has, read from Polygon, and its pUSD balance. */
async function approvalStatus(wallet) {
  return cached(`polymarket:approvals:${lower(wallet)}`, 10, async () => {
    const rows = await Promise.all(APPROVALS.map(async a => {
      try {
        const raw = a.kind === 'erc20' ? await call(a.token, ERC20.encodeFunctionData('allowance', [wallet, a.spender])) : await call(a.token, ERC1155.encodeFunctionData('isApprovedForAll', [wallet, a.spender]));
        // An allowance counts as given while it's above any order RektBull could prepare.
        return { ...a, approved: a.kind === 'erc20' ? BigInt(raw) >= 2n ** 128n : BigInt(raw) === 1n };
      } catch (err) { return { ...a, approved: null, not_checked: `couldn't be read from Polygon: ${err.message}` }; }
    }));
    let pusd = null; let balanceNote = null;
    try { pusd = Number(BigInt(await call(C.pUSD, ERC20.encodeFunctionData('balanceOf', [wallet])))) / 1e6; } catch (err) { balanceNote = `pUSD balance couldn't be read from Polygon: ${err.message}`; }
    return { approvals: rows, pusd_balance: pusd, ...(balanceNote ? { balance_not_checked: balanceNote } : {}), source: 'Polygon RPC (allowance, isApprovedForAll, balanceOf)' };
  });
}

const approvalCall = a => ({
  target: a.token, value: '0',
  data: a.kind === 'erc20' ? ERC20.encodeFunctionData('approve', [a.spender, MAX]) : ERC1155.encodeFunctionData('setApprovalForAll', [a.spender, true]),
  what: `${a.kind === 'erc20' ? 'Approve' : 'Allow'} ${a.spender_name} for your ${a.token_name}. ${a.what}`,
});

/**
 * The account's Polymarket wallet. `address` is needed for proxy and safe (copied from the
 * user's polymarket.com profile) and optional for deposit (an older wallet than the derived one).
 */
async function resolve(account, { walletType = 'deposit', address = null } = {}) {
  const type = WALLET_TYPES[walletType];
  if (!type) throw new WalletRefused(`wallet_type must be one of: ${Object.keys(WALLET_TYPES).join(', ')}`, 400);
  const signer = ethers.getAddress(account.wallet);
  let wallet; let derived = false;
  if (walletType === 'eoa') wallet = signer;
  else if (address) { if (!isAddress(address)) throw new WalletRefused('address must be your Polymarket wallet address (0x…)', 400); wallet = ethers.getAddress(address); }
  else if (walletType === 'deposit') { wallet = depositWalletAddress(signer); derived = true; }
  else throw new WalletRefused(`Paste your Polymarket wallet address (from your profile menu on polymarket.com): a ${type.label} can't be worked out from your key.`, 400);
  return { wallet_type: walletType, signature_type: type.signature_type, signer, wallet, derived, label: type.label, about: type.about };
}

/** The wallet with what's needed before it can trade: deployed, funded, approved. */
async function status(account, opts) {
  const w = await resolve(account, opts);
  let deployed = null; let deployedNote = null;
  if (w.wallet_type === 'deposit') {
    try { deployed = !!(await pm.deployed(w.wallet)).deployed; } catch (err) { deployedNote = err.message; }
  } else if (w.wallet_type === 'eoa') deployed = true;
  const a = deployed === false ? { approvals: APPROVALS.map(x => ({ ...x, approved: false })), pusd_balance: 0, source: 'the wallet is not deployed yet' } : await approvalStatus(w.wallet);
  return {
    ...w, deployed, ...(deployedNote ? { deployed_not_checked: deployedNote } : {}),
    pusd_balance: a.pusd_balance, ...(a.balance_not_checked ? { balance_not_checked: a.balance_not_checked } : {}),
    approvals: a.approvals.map(({ id, token_name, spender_name, spender, token, what, approved, not_checked }) => ({ id, token: token_name, token_address: token, to: spender_name, to_address: spender, what, approved, ...(not_checked ? { not_checked } : {}) })),
    ready: deployed === true && a.approvals.every(x => x.approved === true),
    can_prepare_setup: w.wallet_type === 'deposit' || w.wallet_type === 'eoa',
    ...(w.wallet_type === 'proxy' || w.wallet_type === 'safe' ? { setup_note: 'Polymarket documents no way for another app to send approvals or redemptions for a legacy Proxy or Safe wallet. Set them up, and redeem, on polymarket.com; RektBull prepares your orders.' } : {}),
    ...(w.wallet_type === 'eoa' ? { setup_note: 'Polymarket accepts EOA trading only from addresses it has allowlisted. If yours isn\'t, its orders are rejected: use a Deposit Wallet.' } : {}),
    sources: [a.source, ...(w.wallet_type === 'deposit' ? [pm.SOURCES.relayer + ' /deployed'] : [])],
  };
}

function batchTypedData(wallet, nonce, deadline, calls) {
  return {
    domain: { name: 'DepositWallet', version: '1', chainId: CHAIN_ID, verifyingContract: wallet },
    types: { EIP712Domain: DOMAIN_TYPE, ...BATCH_TYPES }, primaryType: 'Batch',
    message: { wallet, nonce: String(nonce), deadline: String(deadline), calls: calls.map(c => ({ target: c.target, value: c.value, data: c.data })) },
  };
}

/** The calls that redeem one resolved position, for its position system (V2 Router, or a CTF collateral adapter). */
function redeemCalls({ positionSystem, negRisk, conditionId, assetId, shares }) {
  if (positionSystem === 'v2') {
    // A V2 position id is (31-byte condition id << 8) | outcome index.
    const id = BigInt(assetId);
    const cond = ethers.toBeHex(id >> 8n, 31);
    const amount = BigInt(Math.floor(Number(shares) * 1e6));
    return [
      { target: C.positionManager, value: '0', data: ERC1155.encodeFunctionData('setApprovalForAll', [C.router, true]), what: 'Allow Polymarket\'s Router to take the resolved shares it redeems (Polymarket requires this before a redemption).' },
      { target: C.router, value: '0', data: POSITIONS.encodeFunctionData('redeem', [cond, id & 255n, amount]), what: 'Redeem your resolved shares for pUSD, paid to this wallet.' },
    ];
  }
  const adapter = negRisk ? C.negRiskCtfCollateralAdapter : C.ctfCollateralAdapter;
  return [
    { target: C.conditionalTokens, value: '0', data: ERC1155.encodeFunctionData('setApprovalForAll', [adapter, true]), what: `Allow Polymarket's ${negRisk ? 'NegRiskCtfCollateralAdapter' : 'CtfCollateralAdapter'} to take the resolved shares it redeems (Polymarket requires this before a redemption).` },
    { target: adapter, value: '0', data: POSITIONS.encodeFunctionData('redeemPositions', [C.pUSD, ethers.ZeroHash, conditionId, [1, 2]]), what: 'Redeem your resolved shares in this market for pUSD, paid to this wallet.' },
  ];
}

/**
 * RektBull's share of the profit on a redemption (catalog: polymarket_profit):
 * payout (what Polymarket values the redeemed shares at, $1 a winning share)
 * minus cost (the shares' average price times their number), both from
 * Polymarket's Data API. Nothing on a loss, without a fee wallet, or under a cent.
 */
function profitShare(redeemed) {
  const bps = require('../payments/catalog').product('polymarket_profit').fee_bps;
  const sum = f => redeemed.reduce((s, x) => s + f(x), 0);
  const payout = sum(x => Number(x.current_value) || 0);
  const cost = sum(x => (Number(x.avg_price) || 0) * (Number(x.current_size) || 0));
  const profit = Math.max(0, payout - cost);
  const units = BigInt(Math.floor(profit * bps / 10000 * 1e6));
  const r2 = v => Math.round(v * 100) / 100;
  const out = { bps, payout_usd: r2(payout), cost_usd: r2(cost), profit_usd: r2(profit), fee_usd: Number(units) / 1e6, fee_units: 0n, source: pm.SOURCES.data };
  if (!env.polymarketFeeWallet) return { ...out, fee_usd: 0, note: 'No profit share: RektBull\'s fee wallet isn\'t set.' };
  if (profit <= 0) return { ...out, fee_usd: 0, note: 'No profit share: this redemption isn\'t a profit.' };
  if (units < 10000n) return { ...out, fee_usd: 0, note: 'No profit share: it would be under a cent.' };
  return { ...out, fee_units: units };
}

/** Which calls a batch of `kind` makes. Every one targets a documented Polymarket contract or the wallet itself; money only ever goes to the wallet or its owner. */
async function callsFor(kind, w, input, st) {
  if (kind === 'approvals') {
    const missing = st.approvals.filter(a => a.approved !== true).map(a => APPROVALS.find(x => x.id === a.id));
    if (!missing.length) throw new WalletRefused('Every trading approval is already in place.', 409, 'nothing_to_do');
    return { calls: missing.map(approvalCall), detail: { approvals: missing.map(a => a.id) } };
  }
  if (kind === 'redeem') {
    const assetId = String(input.asset_id || '');
    const { positions } = await pm.positions(w.wallet);
    const p = positions.find(x => String(x.token_id) === assetId);
    if (!p) throw new WalletRefused('Polymarket\'s Data API shows no such position in this wallet.', 404);
    if (!p.redeemable) throw new WalletRefused('This position isn\'t redeemable yet: its market hasn\'t resolved.');
    const m = p.slug ? await pm.market(p.slug) : null;
    if (!m) throw new WalletRefused('The position\'s market couldn\'t be read from Polymarket, so RektBull can\'t tell which contract redeems it. Redeem it on polymarket.com.');
    const positionSystem = m.version === 'v2' ? 'v2' : 'ctf';
    const calls = redeemCalls({ positionSystem, negRisk: !!p.negative_risk, conditionId: p.condition_id, assetId, shares: p.current_size });
    // A CTF redemption redeems every outcome of the market this wallet holds; a V2 one, this position only.
    const redeemed = positionSystem === 'v2' ? [p] : positions.filter(x => x.condition_id === p.condition_id && x.redeemable);
    const share = profitShare(redeemed);
    if (share.fee_units > 0n) {
      calls.push({ target: C.pUSD, value: '0', data: ERC20.encodeFunctionData('transfer', [env.polymarketFeeWallet, share.fee_units]),
        what: `RektBull's profit share: ${share.bps / 100}% of your ${share.profit_usd} pUSD profit (${share.payout_usd} paid out, ${share.cost_usd} paid for the shares), ${share.fee_usd} pUSD to RektBull. It's in the same transaction as the redemption, so it's paid only if the redemption goes through.` });
    }
    return { calls, detail: { asset_id: assetId, title: p.title, outcome: p.outcome, shares: p.current_size, position_system: positionSystem, profit_share: { ...share, fee_units: String(share.fee_units) } } };
  }
  if (kind === 'withdraw') {
    const amount = Math.floor(Number(input.amount_usd) * 1e6);
    if (!(amount > 0)) throw new WalletRefused('amount_usd must be above 0', 400);
    if (st.pusd_balance !== null && amount / 1e6 > st.pusd_balance) throw new WalletRefused(`This wallet holds ${st.pusd_balance} pUSD.`);
    // Only ever to the wallet's own owner.
    return { calls: [
      { target: C.pUSD, value: '0', data: ERC20.encodeFunctionData('approve', [C.collateralOfframp, BigInt(amount)]), what: `Approve Polymarket's CollateralOfframp for exactly ${amount / 1e6} pUSD, to unwrap it.` },
      { target: C.collateralOfframp, value: '0', data: RAMP.encodeFunctionData('unwrap', [C.USDCe, w.signer, BigInt(amount)]), what: `Unwrap ${amount / 1e6} pUSD into USDC.e, sent to your own wallet ${w.signer} on Polygon.` },
    ], detail: { amount_usd: amount / 1e6, to: w.signer } };
  }
  if (kind === 'session_authorize' || kind === 'session_revoke') {
    if (!isAddress(input.session_signer)) throw new WalletRefused('session_signer is missing', 400);
    if (kind === 'session_revoke') return { calls: [{ target: w.wallet, value: '0', data: SESSION.encodeFunctionData('revokeSessionSigner', [input.session_signer]), what: 'End RektBull\'s Session Key on your Polymarket wallet. Polymarket cancels the open orders it placed.' }], detail: { session_signer: lower(input.session_signer) } };
    const validUntil = Math.floor(Date.now() / 1000) + SESSION_DAYS_HOURS * 3600;
    return { calls: [{ target: w.wallet, value: '0', data: SESSION.encodeFunctionData('authorizeSessionSigner', [input.session_signer, validUntil]), what: 'Let RektBull\'s key place Polymarket orders for this wallet for 180 days (Polymarket\'s fixed term). It can trade; it cannot withdraw. You can end it at any time.' }], detail: { session_signer: lower(input.session_signer), valid_until: validUntil } };
  }
  throw new WalletRefused('kind must be approvals, redeem or withdraw', 400);
}

/**
 * Prepares a wallet transaction of `kind` for the account to sign.
 * Deposit Wallet: an EIP-712 Batch (then submit()). EOA: plain Polygon transactions for the wallet to send.
 */
async function prepare(account, kind, input = {}) {
  const w = await resolve(account, { walletType: input.wallet_type, address: input.address });
  if (w.wallet_type === 'proxy' || w.wallet_type === 'safe') throw new WalletRefused('Polymarket documents no way for another app to send this for a legacy Proxy or Safe wallet. Do it on polymarket.com.', 422, 'not_supported');
  if (kind.startsWith('session_') && w.wallet_type !== 'deposit') throw new WalletRefused('Polymarket Session Keys work only with Deposit Wallets.', 422, 'not_supported');
  const st = await status(account, { walletType: w.wallet_type, address: w.wallet });
  if (w.wallet_type === 'deposit' && st.deployed !== true) throw new WalletRefused(st.deployed === false ? 'Deploy your Polymarket wallet first.' : `Whether your wallet is deployed couldn't be read: ${st.deployed_not_checked}`, 409, 'not_deployed');
  const { calls, detail } = await callsFor(kind, w, input, st);
  if (w.wallet_type === 'eoa') {
    return { kind, wallet_type: 'eoa', chain_id: '0x' + CHAIN_ID.toString(16), calls: calls.map(c => ({ to: c.target, data: c.data, value: '0x0', label: c.what })), detail, note: 'Each step is a Polygon transaction from your wallet and needs POL for gas.' };
  }
  const { nonce } = await pm.walletNonce(w.signer);
  const deadline = Math.floor(Date.now() / 1000) + BATCH_SECONDS;
  const id = crypto.randomUUID();
  await db.query('INSERT INTO polymarket_batches (id, account_id, signer, wallet, kind, nonce, deadline, calls, detail) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [id, account.id, lower(w.signer), lower(w.wallet), kind, String(nonce), deadline, JSON.stringify(calls), JSON.stringify(detail)]);
  return { id, kind, wallet_type: 'deposit', wallet: w.wallet, steps: calls.map(c => ({ what: c.what, contract: c.target })), detail, typed_data: batchTypedData(w.wallet, nonce, deadline, calls), expires_at: deadline, gas: 'Paid by Polymarket\'s relayer.' };
}

/** Forwards a batch the account signed to Polymarket's relayer, exactly as prepared. */
async function submit(account, id, signature) {
  const { rows: [b] } = await db.query('SELECT * FROM polymarket_batches WHERE id = $1 AND account_id = $2', [id, account.id]);
  if (!b) throw new WalletRefused('No such prepared transaction.', 404);
  if (b.status !== 'prepared') throw new WalletRefused(`This transaction was already ${b.status}.`, 409);
  if (Number(b.deadline) < Math.floor(Date.now() / 1000) + 10) throw new WalletRefused('This prepared transaction has expired: prepare it again.', 409, 'expired');
  const wallet = ethers.getAddress(b.wallet); const signer = ethers.getAddress(b.signer);
  const td = batchTypedData(wallet, b.nonce, b.deadline, b.calls);
  let signedBy = null;
  try { signedBy = ethers.verifyTypedData(td.domain, BATCH_TYPES, td.message, signature); } catch { /* not a plain signature */ }
  if (lower(signedBy) !== lower(signer) || lower(signer) !== lower(account.wallet)) throw new WalletRefused('The signature isn\'t your wallet\'s signature of this transaction.', 400, 'bad_signature');
  const calls = b.calls.map(c => ({ target: c.target, value: c.value, data: c.data }));
  let out;
  if (b.kind === 'session_authorize') {
    out = await pm.relayer('POST', '/v1/session-signers/authorizations', { body: { walletAddress: wallet, sessionSignerAddress: ethers.getAddress(b.detail.session_signer), scopes: ['CLOB'], validUntil: String(b.detail.valid_until), nonce: b.nonce, deadline: String(b.deadline), signature } });
  } else if (b.kind === 'session_revoke') {
    out = await pm.relayer('POST', '/v1/session-signers/revocations', { body: { walletAddress: wallet, sessionSignerAddress: ethers.getAddress(b.detail.session_signer), nonce: b.nonce, deadline: String(b.deadline), signature } });
  } else {
    out = await pm.relayer('POST', '/submit', { body: { type: 'WALLET', from: signer, to: C.depositWalletFactory, nonce: b.nonce, signature, metadata: `RektBull: ${b.kind}`, depositWalletParams: { depositWallet: wallet, deadline: String(b.deadline), calls } } });
  }
  const relayerId = out?.transactionID || out?.transactionId || null;
  await db.query('UPDATE polymarket_batches SET status = $2, relayer_id = $3, tx_hash = $4 WHERE id = $1', [id, 'submitted', relayerId, out?.transactionHash || null]);
  require('../lib/cache')._memory.delete(`polymarket:approvals:${lower(wallet)}`);
  return { id, kind: b.kind, status: 'submitted', relayer_id: relayerId };
}

const TERMINAL = { STATE_CONFIRMED: 'confirmed', STATE_FAILED: 'failed', STATE_INVALID: 'failed' };
/** Where a submitted batch stands, asked of the relayer. */
async function progress(account, id) {
  const { rows: [b] } = await db.query('SELECT * FROM polymarket_batches WHERE id = $1 AND account_id = $2', [id, account.id]);
  if (!b) throw new WalletRefused('No such transaction.', 404);
  if (b.status === 'submitted' && b.relayer_id) {
    const t = await pm.relayer('GET', `/v1/account/transactions/${b.relayer_id}`);
    const next = TERMINAL[t?.state];
    if (next) {
      await db.query('UPDATE polymarket_batches SET status = $2, tx_hash = COALESCE($3, tx_hash), error = $4 WHERE id = $1', [id, next, t.transaction_hash || null, next === 'failed' ? String(t.error_msg || t.state).slice(0, 300) : null]);
      Object.assign(b, { status: next, tx_hash: t.transaction_hash || b.tx_hash, error: next === 'failed' ? t.error_msg || t.state : null });
      if (b.kind.startsWith('session_')) await require('./auto').batchSettled(b);
      // RektBull Points: a rebate of the profit share, once the redemption that paid it is confirmed.
      const share = b.detail?.profit_share;
      if (next === 'confirmed' && b.kind === 'redeem' && share?.fee_usd > 0) {
        await require('../rewards/points').safeCredit({ accountId: b.account_id, source: 'polymarket_profit', ref: b.id, feeUsd: share.fee_usd });
      }
    }
  }
  return { id, kind: b.kind, status: b.status, tx_hash: b.tx_hash || null, ...(b.error ? { error: b.error } : {}), source: pm.SOURCES.relayer };
}

/** Deploys the account's Deposit Wallet through the relayer (it belongs to the account's key alone; nothing to sign). */
async function deploy(account) {
  const signer = ethers.getAddress(account.wallet);
  const wallet = depositWalletAddress(signer);
  if ((await pm.deployed(wallet)).deployed) return { wallet, status: 'confirmed', already: true };
  const out = await pm.relayer('POST', '/submit', { body: { type: 'WALLET-CREATE', from: signer, to: C.depositWalletFactory, metadata: 'Deploy Deposit Wallet' } });
  return { wallet, status: 'submitted', relayer_id: out?.transactionID || null };
}

/** Funding a Polymarket wallet from the user's own Polygon USDC.e: approve the Onramp for exactly the amount, then wrap to the wallet. */
async function fundCalls(account, input) {
  const w = await resolve(account, { walletType: input.wallet_type, address: input.address });
  const amount = Math.floor(Number(input.amount_usd) * 1e6);
  if (!(amount > 0)) throw new WalletRefused('amount_usd must be above 0', 400);
  return {
    chain_id: '0x' + CHAIN_ID.toString(16), wallet: w.wallet, atomic: false,
    calls: [
      { to: C.USDCe, data: ERC20.encodeFunctionData('approve', [C.collateralOnramp, BigInt(amount)]), value: '0x0', label: `Approve Polymarket's CollateralOnramp for exactly ${amount / 1e6} USDC.e` },
      { to: C.collateralOnramp, data: RAMP.encodeFunctionData('wrap', [C.USDCe, w.wallet, BigInt(amount)]), value: '0x0', label: `Wrap ${amount / 1e6} USDC.e into pUSD, credited to your Polymarket wallet ${w.wallet}` },
    ],
    note: 'Two Polygon transactions from your own wallet (USDC.e and a little POL for gas). pUSD is Polymarket\'s collateral, backed 1:1 by USDC. You can also deposit on polymarket.com.',
  };
}

module.exports = { profitShare, depositWalletAddress, approvalStatus, resolve, status, prepare, submit, progress, deploy, fundCalls, batchTypedData, redeemCalls, WalletRefused, BATCH_TYPES, SESSION, SESSION_DAYS_HOURS };
