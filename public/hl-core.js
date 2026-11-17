/*
 * Hyperliquid's wire formats and signing, shared by the Perps page (in the
 * browser, as window.HLCore) and the server (require). One implementation, so
 * what the tests check against Hyperliquid's own SDK vectors is what both use.
 *
 * Two kinds of signature (docs/HYPERLIQUID.md has the sources):
 *   - L1 actions (orders, cancels, leverage): the action is msgpack-encoded,
 *     hashed with the nonce (and the vault address and expiry when set), and the
 *     hash is signed as an EIP-712 "Agent" on chain id 1337. Wallets refuse to
 *     sign for chain 1337, which is why an agent key signs these.
 *   - User-signed actions (approveAgent, approveBuilderFee): plain EIP-712 on
 *     the chain the user's wallet is on (signatureChainId), signed by the
 *     user's own wallet.
 *
 * Nothing here holds a key: callers pass a signer.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('ethers'));
  else root.HLCore = factory(root.ethers);
})(typeof self !== 'undefined' ? self : this, function (lib) {
  'use strict';
  const ethers = lib.ethers || lib;
  const ZERO = '0x0000000000000000000000000000000000000000';

  /* ── msgpack (the subset Hyperliquid's actions use: maps in key order, arrays, strings, booleans, integers) ── */

  function utf8(s) {
    return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(s) : Uint8Array.from(Buffer.from(s, 'utf8'));
  }
  function be(n, bytes) {
    const out = [];
    let v = BigInt(n);
    for (let i = 0; i < bytes; i++) { out.unshift(Number(v & 255n)); v >>= 8n; }
    return out;
  }
  function pack(v, out) {
    if (v === null) { out.push(0xc0); return; }
    if (v === true) { out.push(0xc3); return; }
    if (v === false) { out.push(0xc2); return; }
    if (typeof v === 'number' || typeof v === 'bigint') {
      if (typeof v === 'number' && !Number.isSafeInteger(v)) throw new Error('only whole numbers can be signed: send prices and sizes as strings');
      const n = BigInt(v);
      if (n >= 0n) {
        if (n < 128n) out.push(Number(n));
        else if (n < 256n) out.push(0xcc, ...be(n, 1));
        else if (n < 65536n) out.push(0xcd, ...be(n, 2));
        else if (n < 4294967296n) out.push(0xce, ...be(n, 4));
        else if (n < 18446744073709551616n) out.push(0xcf, ...be(n, 8));
        else throw new Error('integer too large to sign');
      } else if (n >= -32n) out.push(Number(256n + n));
      else if (n >= -128n) out.push(0xd0, ...be(256n + n, 1));
      else if (n >= -32768n) out.push(0xd1, ...be(65536n + n, 2));
      else if (n >= -2147483648n) out.push(0xd2, ...be(4294967296n + n, 4));
      else if (n >= -9223372036854775808n) out.push(0xd3, ...be(18446744073709551616n + n, 8));
      else throw new Error('integer too small to sign');
      return;
    }
    if (typeof v === 'string') {
      const b = utf8(v);
      if (b.length < 32) out.push(0xa0 | b.length);
      else if (b.length < 256) out.push(0xd9, b.length);
      else if (b.length < 65536) out.push(0xda, ...be(b.length, 2));
      else out.push(0xdb, ...be(b.length, 4));
      for (const x of b) out.push(x);
      return;
    }
    if (Array.isArray(v)) {
      if (v.length < 16) out.push(0x90 | v.length);
      else if (v.length < 65536) out.push(0xdc, ...be(v.length, 2));
      else out.push(0xdd, ...be(v.length, 4));
      for (const x of v) pack(x, out);
      return;
    }
    if (typeof v === 'object') {
      const keys = Object.keys(v).filter(k => v[k] !== undefined);
      if (keys.length < 16) out.push(0x80 | keys.length);
      else if (keys.length < 65536) out.push(0xde, ...be(keys.length, 2));
      else out.push(0xdf, ...be(keys.length, 4));
      for (const k of keys) { pack(k, out); pack(v[k], out); }
      return;
    }
    throw new Error(`cannot sign a value of type ${typeof v}`);
  }
  /** The msgpack bytes of an action. Key order is the order the keys were set in: it's part of what's signed. */
  function msgpack(value) {
    const out = [];
    pack(value, out);
    return Uint8Array.from(out);
  }

  /* ── L1 actions ── */

  /** keccak256(msgpack(action) ++ nonce ++ vault ++ expiry): what the agent signs (as "connectionId"). */
  function actionHash(action, { nonce, vaultAddress = null, expiresAfter = null }) {
    if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error('nonce must be a whole number (the time in milliseconds)');
    const bytes = [...msgpack(action), ...be(nonce, 8)];
    if (vaultAddress) bytes.push(1, ...ethers.getBytes(vaultAddress));
    else bytes.push(0);
    if (expiresAfter !== null && expiresAfter !== undefined) bytes.push(0, ...be(expiresAfter, 8));
    return ethers.keccak256(Uint8Array.from(bytes));
  }

  const L1_DOMAIN = { name: 'Exchange', version: '1', chainId: 1337, verifyingContract: ZERO };
  const L1_TYPES = { Agent: [{ name: 'source', type: 'string' }, { name: 'connectionId', type: 'bytes32' }] };

  /** The EIP-712 typed data for an L1 action. source is "a" on mainnet and "b" on testnet. */
  function l1TypedData(action, { nonce, vaultAddress = null, expiresAfter = null, mainnet }) {
    if (typeof mainnet !== 'boolean') throw new Error('say which network: mainnet true or false');
    return { domain: L1_DOMAIN, types: L1_TYPES, primaryType: 'Agent', message: { source: mainnet ? 'a' : 'b', connectionId: actionHash(action, { nonce, vaultAddress, expiresAfter }) } };
  }
  /** The 32-byte digest of an L1 action (for a signer that signs digests, such as Cloud KMS). */
  function l1Digest(action, opts) {
    const t = l1TypedData(action, opts);
    return ethers.TypedDataEncoder.hash(t.domain, t.types, t.message);
  }
  const wireSignature = sig => { const s = ethers.Signature.from(sig); return { r: s.r, s: s.s, v: s.v }; };
  /** Signs an L1 action with an ethers signer (the agent key). Returns { r, s, v }. */
  async function signL1(signer, action, opts) {
    const t = l1TypedData(action, opts);
    return wireSignature(await signer.signTypedData(t.domain, t.types, t.message));
  }
  /** Who signed an L1 action (an agent's address, or the user's). */
  function recoverL1(action, signature, opts) {
    return ethers.recoverAddress(l1Digest(action, opts), signature).toLowerCase();
  }

  /* ── user-signed actions: the user's own wallet signs these ── */

  const USER_TYPES = {
    approveAgent: ['HyperliquidTransaction:ApproveAgent', [
      { name: 'hyperliquidChain', type: 'string' }, { name: 'agentAddress', type: 'address' }, { name: 'agentName', type: 'string' }, { name: 'nonce', type: 'uint64' }]],
    approveBuilderFee: ['HyperliquidTransaction:ApproveBuilderFee', [
      { name: 'hyperliquidChain', type: 'string' }, { name: 'maxFeeRate', type: 'string' }, { name: 'builder', type: 'address' }, { name: 'nonce', type: 'uint64' }]],
  };
  /** The EIP-712 typed data for a user-signed action; its chain id is the action's signatureChainId. */
  function userTypedData(action) {
    const def = USER_TYPES[action.type];
    if (!def) throw new Error(`${action.type} isn't an action this page signs`);
    const [primaryType, fields] = def;
    const message = {};
    for (const f of fields) message[f.name] = action[f.name] === undefined && f.type === 'string' ? '' : action[f.name];
    return { domain: { name: 'HyperliquidSignTransaction', version: '1', chainId: Number(BigInt(action.signatureChainId)), verifyingContract: ZERO }, types: { [primaryType]: fields }, primaryType, message };
  }
  function recoverUser(action, signature) {
    const t = userTypedData(action);
    return ethers.verifyTypedData(t.domain, t.types, t.message, signature).toLowerCase();
  }
  const chainName = mainnet => (mainnet ? 'Mainnet' : 'Testnet');
  const chainHex = id => '0x' + Number(id).toString(16);

  /** An agent's name with its expiry: Hyperliquid reads "valid_until <ms>" from the name (at most 180 days ahead). */
  function agentName(name, validUntilMs) {
    if (!/^[A-Za-z0-9_-]{1,16}$/.test(name)) throw new Error('an agent name is 1 to 16 letters, digits, - or _');
    return validUntilMs ? `${name} valid_until ${Math.floor(validUntilMs)}` : name;
  }
  const MAX_AGENT_DAYS = 180;

  function approveAgentAction({ mainnet, signatureChainId, agentAddress, name, validUntilMs, nonce }) {
    return { type: 'approveAgent', hyperliquidChain: chainName(mainnet), signatureChainId: chainHex(signatureChainId), agentAddress: agentAddress.toLowerCase(), agentName: agentName(name, validUntilMs), nonce };
  }
  /** maxFeeRate as Hyperliquid's percent string from tenths of a basis point: 10 -> "0.01%". */
  function feeRate(tenthsBps) {
    if (!Number.isInteger(tenthsBps) || tenthsBps < 0) throw new Error('the fee is a whole number of tenths of a basis point');
    return `${stripZeros((tenthsBps / 1000).toFixed(3))}%`;
  }
  function approveBuilderFeeAction({ mainnet, signatureChainId, builder, tenthsBps, nonce }) {
    return { type: 'approveBuilderFee', hyperliquidChain: chainName(mainnet), signatureChainId: chainHex(signatureChainId), maxFeeRate: feeRate(tenthsBps), builder: builder.toLowerCase(), nonce };
  }

  /* ── prices and sizes (Hyperliquid's tick and lot size rules) ── */

  function stripZeros(s) {
    s = String(s);
    if (!s.includes('.')) return s;
    s = s.replace(/0+$/, '').replace(/\.$/, '');
    return s === '-0' || s === '' ? '0' : s;
  }
  /** How many decimals a perp price may have: at most 5 significant figures and at most 6 - szDecimals decimals; whole numbers always. */
  function priceDecimals(px, szDecimals) {
    const max = Math.max(0, 6 - szDecimals);
    if (!(px > 0)) return max;
    const magnitude = Math.floor(Math.log10(px)) + 1; // digits before the decimal point (0 or less below 1)
    return Math.max(0, Math.min(max, 5 - magnitude));
  }
  /** A price as Hyperliquid accepts it. round: 'down', 'up' or 'nearest'. */
  function formatPrice(px, szDecimals, round = 'nearest') {
    px = Number(px);
    if (!(px > 0) || !Number.isFinite(px)) throw new Error('a price must be above 0');
    let d = priceDecimals(px, szDecimals);
    const f = 10 ** d;
    const scaled = px * f;
    const near = Math.round(scaled);
    // A value already on a tick (within float error) stays where it is, whichever way we round.
    let n = Math.abs(scaled - near) < 1e-9 * Math.max(1, scaled) ? near : round === 'down' ? Math.floor(scaled) : round === 'up' ? Math.ceil(scaled) : near;
    if (n <= 0) n = 1;
    let out = n / f;
    // Rounding up can add a digit (99999.5 -> 100000): the result is then a whole number, which is always allowed.
    if (priceDecimals(out, szDecimals) < d) { d = priceDecimals(out, szDecimals); out = Number(out.toFixed(d)); }
    return stripZeros(out.toFixed(d));
  }
  /** A size rounded down to the market's szDecimals. */
  function formatSize(sz, szDecimals) {
    sz = Number(sz);
    if (!(sz >= 0) || !Number.isFinite(sz)) throw new Error('a size must be a number');
    const f = 10 ** szDecimals;
    const scaled = sz * f;
    const near = Math.round(scaled);
    const n = Math.abs(scaled - near) < 1e-9 * Math.max(1, scaled) ? near : Math.floor(scaled);
    return stripZeros((n / f).toFixed(szDecimals));
  }
  /** The limit price of a "market" order: an IOC limit this far through the reference price, rounded so it never goes further. */
  function slippagePrice(reference, isBuy, slippage, szDecimals) {
    return formatPrice(Number(reference) * (isBuy ? 1 + slippage : 1 - slippage), szDecimals, isBuy ? 'down' : 'up');
  }

  /* ── actions ── */

  const TIFS = ['Ioc', 'Gtc', 'Alo'];
  /**
   * One order as it's signed. px and sz are strings already formatted for the
   * market. type: { tif } for a limit order, or { triggerPx, isMarket, tpsl }
   * for a take-profit ('tp') or stop-loss ('sl') trigger.
   */
  function orderWire({ asset, isBuy, px, sz, reduceOnly = false, tif, trigger, cloid }) {
    if (!Number.isInteger(asset) || asset < 0) throw new Error('asset must be the market\'s index');
    let t;
    if (trigger) {
      if (!['tp', 'sl'].includes(trigger.tpsl)) throw new Error('a trigger order is a take-profit (tp) or a stop-loss (sl)');
      t = { trigger: { isMarket: !!trigger.isMarket, triggerPx: stripZeros(trigger.triggerPx), tpsl: trigger.tpsl } };
    } else {
      if (!TIFS.includes(tif)) throw new Error(`tif must be one of: ${TIFS.join(', ')}`);
      t = { limit: { tif } };
    }
    const w = { a: asset, b: !!isBuy, p: stripZeros(px), s: stripZeros(sz), r: !!reduceOnly, t };
    if (cloid) w.c = cloid;
    return w;
  }
  /** builder: { b: address, f: tenths of a basis point } or null. With none, the action has no builder field. */
  function orderAction(orders, { grouping = 'na', builder = null } = {}) {
    const action = { type: 'order', orders, grouping };
    if (builder && builder.b && builder.f > 0) action.builder = { b: builder.b.toLowerCase(), f: builder.f };
    return action;
  }
  const cancelAction = cancels => ({ type: 'cancel', cancels: cancels.map(c => ({ a: c.asset, o: c.oid })) });
  const updateLeverageAction = ({ asset, isCross, leverage }) => ({ type: 'updateLeverage', asset, isCross: !!isCross, leverage });
  /** A random 128-bit client order id. */
  const cloid = () => ethers.hexlify(ethers.randomBytes(16));

  return {
    msgpack, actionHash, l1TypedData, l1Digest, signL1, recoverL1, wireSignature,
    userTypedData, recoverUser, approveAgentAction, approveBuilderFeeAction, agentName, feeRate, chainHex, MAX_AGENT_DAYS,
    stripZeros, priceDecimals, formatPrice, formatSize, slippagePrice,
    orderWire, orderAction, cancelAction, updateLeverageAction, cloid, TIFS, L1_DOMAIN, L1_TYPES, USER_TYPES,
  };
});
