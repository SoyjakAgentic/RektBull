/**
 * Token contract risk scan, ported from soyjak-agentic
 * (backend/src/services/tokenRisk.js, ADMIN_SETUP.md §655 and §664 there).
 *
 * What changed in the port: providers come from src/providers (RPC with
 * fallback, Etherscan then Blockscout, every call counted against its free
 * plan), keys come from env, and Robinhood Chain is not covered yet.
 *
 * The checks, each from a source it names:
 *   EVM (ethereum, base, arbitrum, optimism, polygon, bsc):
 *     - source: verified on the explorer, its name, whether it's a proxy;
 *     - owner: owner(), and whether ownership is renounced (RPC);
 *     - who holds the powers: the owner, a pending owner, and each
 *       AccessControl role's holders (the explorer's RoleGranted and
 *       RoleRevoked logs, each confirmed with hasRole), each read as a plain
 *       wallet, a Safe and its threshold, a timelock and its delay, or
 *       another contract;
 *     - upgradeable: the ERC-1967 implementation slot (RPC);
 *     - powers: owner functions in the verified ABI (mint, pause, blacklist,
 *       fees, limits, a trading switch);
 *     - trading: buy and sell tax, and a sell straight back after a small
 *       buy (0x quotes; needs ZEROEX_API_KEY, which has a free plan);
 *     - GoPlus: its honeypot, tax and owner-power flags, holders and LP
 *       holders, as a second source; where it disagrees with ours, both
 *       are reported.
 *   Solana:
 *     - mint and freeze authority; Token-2022 extensions (transfer fee,
 *       permanent delegate, transfer hook, frozen-by-default accounts);
 *     - the 20 largest holders;
 *     - a sell straight back after a small buy (Jupiter).
 * A check that couldn't run says why (no key, chain not covered). Every flag
 * carries a severity and its source; the verdict is the worst flag, and is
 * "incomplete" when the checks that decide sellability didn't run.
 */
const axios = require('axios');
const { ethers } = require('ethers');
const env = require('../config/env');
const { explorerGet } = require('../providers/explorer');
const rpc = require('../providers/rpc');
const { EVM } = require('../providers/chains');
const { track } = require('../providers/usage');

const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const DEAD = new Set(['0x0000000000000000000000000000000000000000', '0x000000000000000000000000000000000000dead']);
const IMPLEMENTATION_SLOT = ethers.toBeHex(BigInt(ethers.id('eip1967.proxy.implementation')) - 1n, 32);

/** The EVM chains: 0x and GoPlus chain ids, and the size of the probe buy. */
const EVM_CHAINS = EVM;
const SCAN_CHAINS = [...Object.keys(EVM_CHAINS), 'solana'];

const WSOL = 'So11111111111111111111111111111111111111112';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const SOL_PROBE_LAMPORTS = 100_000_000n; // 0.1 SOL

/**
 * Owner powers, by function name in the verified ABI. A function that exists
 * is a power someone may hold; the source says who. Views don't count.
 */
const POWERS = {
  mint:      /^(mint|_?mintTo|mintFor|issue|increaseSupply)$/i,
  pause:     /^(pause|unpause|setPaused|pauseTrading|setPause)$/i,
  blacklist: /(black|block|deny)list|^(set|add|remove)Bots?$|^setBot|blacklisted|^ban/i,
  fees:      /^(set|update|change)\w*(fee|tax)/i,
  limits:    /^(set|update|change)\w*(maxTx|maxWallet|maxTransaction|maxSell|maxBuy|limit)/i,
  trading:   /^(enable|open|start|set|toggle)\w*trading/i,
};

const pct = bps => (bps === null || bps === undefined ? null : Math.round(Number(bps)) / 100);
const isAddr = a => /^0x[0-9a-fA-F]{40}$/.test(String(a || ''));

const evmRpc = (chain, method, params) => rpc.evmRpc(chain, method, params);

async function zeroExKey() {
  return env.zeroExApiKey || null;
}

async function zeroExPrice(key, params) {
  return track('0x', async () => (await axios.get('https://api.0x.org/swap/allowance-holder/price', {
    params, headers: { '0x-api-key': key, '0x-version': 'v2' }, timeout: 15000,
  })).data);
}

/** Buy with the probe, sell straight back: taxes, and whether it can be sold at all. */
async function evmTrading(chain, token) {
  const key = await zeroExKey();
  if (!key) return { not_checked: 'no 0x API key (ZEROEX_API_KEY)' };
  const c = EVM_CHAINS[chain];
  try {
    const buy = await zeroExPrice(key, { chainId: c.chainId, sellToken: NATIVE, buyToken: token, sellAmount: c.probe });
    if (buy.liquidityAvailable === false || !buy.buyAmount) return { source: '0x quote', probe: c.probeLabel, buyable: false, sellable: null, note: '0x found no liquidity to buy it' };
    const meta = buy.tokenMetadata?.buyToken || {};
    let back = null;
    try {
      const sell = await zeroExPrice(key, { chainId: c.chainId, sellToken: token, buyToken: NATIVE, sellAmount: String(buy.buyAmount) });
      back = sell.liquidityAvailable === false || !sell.buyAmount ? null : BigInt(sell.buyAmount);
    } catch { back = null; }
    const loss = back === null ? null : Number((BigInt(c.probe) - back) * 10000n / BigInt(c.probe)) / 100;
    return {
      source: '0x quote', probe: c.probeLabel, buyable: true, sellable: back !== null,
      buy_tax_pct: pct(meta.buyTaxBps), sell_tax_pct: pct(meta.sellTaxBps), round_trip_loss_pct: loss,
    };
  } catch (err) {
    return { not_checked: `0x: ${err.response?.data?.message || err.message}` };
  }
}

/** The verified ABI (and the implementation's, for a proxy), or null. */
async function verifiedSource(chain, address) {
  const data = await explorerGet(chain, { module: 'contract', action: 'getsourcecode', address });
  const row = Array.isArray(data?.result) ? data.result[0] : null;
  if (!row || !row.SourceCode || !row.ABI || /not verified/i.test(row.ABI)) return null;
  return row;
}

function powersFromAbi(abi) {
  const out = Object.fromEntries(Object.keys(POWERS).map(k => [k, []]));
  for (const f of abi) {
    if (f.type !== 'function' || f.stateMutability === 'view' || f.stateMutability === 'pure') continue;
    for (const [k, re] of Object.entries(POWERS)) if (re.test(f.name)) out[k].push(f.name);
  }
  for (const k of Object.keys(out)) out[k] = [...new Set(out[k])];
  return out;
}

async function evmSource(chain, token) {
  try {
    const row = await verifiedSource(chain, token);
    if (!row) return { verified: false };
    const abi = JSON.parse(row.ABI);
    let implementation = null;
    let implAbi = [];
    if (row.Proxy === '1' && isAddr(row.Implementation)) {
      implementation = row.Implementation.toLowerCase();
      const impl = await verifiedSource(chain, implementation).catch(() => null);
      if (impl) implAbi = JSON.parse(impl.ABI);
    }
    const all = [...abi, ...implAbi];
    const fn = name => all.some(f => f.type === 'function' && f.name === name);
    return {
      verified: true, contract_name: row.ContractName || null, proxy: row.Proxy === '1', implementation, powers: powersFromAbi(all),
      access_control: fn('hasRole'), enumerable: fn('getRoleMemberCount') && fn('getRoleMember'), two_step: fn('pendingOwner'),
      role_getters: [...new Set(all.filter(f => f.type === 'function' && !(f.inputs || []).length && (f.outputs || []).length === 1 && f.outputs[0].type === 'bytes32' && /_ROLE$|^ROLE_/.test(f.name)).map(f => f.name))],
    };
  } catch (err) {
    return { not_checked: `explorer: ${err.message}` };
  }
}

async function evmOwnerAndProxy(chain, token) {
  try {
    const ownerRaw = await evmRpc(chain, 'eth_call', [{ to: token, data: '0x8da5cb5b' }, 'latest']).catch(() => null);
    if (ownerRaw === undefined) return { not_checked: 'no RPC for this chain' };
    const slot = await evmRpc(chain, 'eth_getStorageAt', [token, IMPLEMENTATION_SLOT, 'latest']).catch(() => null);
    const owner = ownerRaw && ownerRaw.length >= 66 ? ('0x' + ownerRaw.slice(-40)).toLowerCase() : null;
    const impl = slot && !/^0x0*$/.test(slot) ? ('0x' + slot.slice(-40)).toLowerCase() : null;
    return { owner, renounced: owner ? DEAD.has(owner) : null, upgradeable: !!impl, implementation: impl, source: 'RPC' };
  } catch (err) {
    return { not_checked: `RPC: ${err.message}` };
  }
}

const flag = v => (v === '1' ? true : v === '0' ? false : null);
const num = v => (v === undefined || v === null || v === '' ? null : Number(v));

/** GoPlus's token security report, cut to what the scan uses. */
async function goplus(chain, token) {
  const id = EVM_CHAINS[chain].goplus;
  if (!id) return { not_checked: 'GoPlus does not cover this chain' };
  try {
    const data = await track('goplus', async () => (await axios.get(`https://api.gopluslabs.io/api/v1/token_security/${id}`, { params: { contract_addresses: token }, timeout: 12000 })).data);
    const r = data?.result?.[token.toLowerCase()];
    if (!r) return { not_checked: `GoPlus has no report for it${data?.message ? ` (${data.message})` : ''}` };
    const supply = num(r.total_supply);
    const share = h => {
      const bal = num(h.balance);
      if (supply && bal !== null) return bal / supply;
      const p = num(h.percent);
      return p !== null && p <= 1 ? p : null;
    };
    const holders = (r.holders || []).map(h => ({ address: h.address, tag: h.tag || null, is_contract: flag(h.is_contract), is_locked: flag(h.is_locked), share: share(h) }));
    // Pools, lockers and burn addresses aren't holders who can sell.
    const people = holders.filter(h => !h.is_contract && !h.is_locked && !DEAD.has(String(h.address).toLowerCase()));
    const lpSupply = num(r.lp_total_supply);
    const lp = (r.lp_holders || []).map(h => {
      const bal = num(h.balance);
      const p = lpSupply && bal !== null ? bal / lpSupply : (num(h.percent) !== null && num(h.percent) <= 1 ? num(h.percent) : null);
      return { address: h.address, tag: h.tag || null, locked: flag(h.is_locked) || DEAD.has(String(h.address).toLowerCase()), share: p };
    });
    const lpKnown = lp.filter(h => h.share !== null);
    return {
      source: 'GoPlus',
      honeypot: flag(r.is_honeypot),
      cannot_sell_all: flag(r.cannot_sell_all),
      buy_tax_pct: num(r.buy_tax) === null ? null : Math.round(num(r.buy_tax) * 10000) / 100,
      sell_tax_pct: num(r.sell_tax) === null ? null : Math.round(num(r.sell_tax) * 10000) / 100,
      mintable: flag(r.is_mintable),
      owner_change_balance: flag(r.owner_change_balance),
      hidden_owner: flag(r.hidden_owner),
      take_back_ownership: flag(r.can_take_back_ownership),
      pausable: flag(r.transfer_pausable),
      blacklist: flag(r.is_blacklisted),
      slippage_modifiable: flag(r.slippage_modifiable),
      selfdestruct: flag(r.selfdestruct),
      proxy: flag(r.is_proxy),
      holder_count: num(r.holder_count),
      top10_people_pct: people.length ? Math.round(people.reduce((s, h) => s + (h.share || 0), 0) * 10000) / 100 : null,
      lp_locked_pct: lpKnown.length ? Math.round(lpKnown.filter(h => h.locked).reduce((s, h) => s + h.share, 0) * 10000) / 100 : null,
      top_holders: holders.slice(0, 10),
    };
  } catch (err) {
    return { not_checked: `GoPlus: ${err.message}` };
  }
}

/** The flags from an EVM scan's checks. */
function evmFlags({ source, ownership, trading, gp, holders }) {
  const flags = [];
  const add = (severity, id, title, evidence, from) => flags.push({ id, severity, title, evidence, source: from });
  const ownerLive = ownership.renounced === false;

  if (trading.buyable === false) add('medium', 'no_liquidity', 'No liquidity was found to trade it', `0x found no route to buy it with ${trading.probe}.`, '0x quote');
  if (trading.sellable === false) add('critical', 'unsellable', 'It could not be sold back after a buy', `0x quoted a buy of ${trading.probe}, and no sell back.`, '0x quote');
  if (gp.honeypot) add('critical', 'honeypot', 'GoPlus reports a honeypot', 'is_honeypot = 1', 'GoPlus');
  if (gp.cannot_sell_all) add('high', 'cannot_sell_all', 'Holders can\'t sell their whole balance', 'cannot_sell_all = 1', 'GoPlus');
  if (gp.owner_change_balance) add('critical', 'owner_change_balance', 'The owner can change holders\' balances', 'owner_change_balance = 1', 'GoPlus');
  if (trading.round_trip_loss_pct !== null && trading.round_trip_loss_pct !== undefined) {
    const l = trading.round_trip_loss_pct;
    if (l > 50) add('critical', 'round_trip', `Selling straight back loses ${l}%`, `A buy of ${trading.probe} sold straight back.`, '0x quote');
    else if (l > 20) add('high', 'round_trip', `Selling straight back loses ${l}%`, `A buy of ${trading.probe} sold straight back: a sell tax, or a thin pool.`, '0x quote');
  }
  const sellTax = Math.max(trading.sell_tax_pct ?? 0, gp.sell_tax_pct ?? 0);
  const buyTax = Math.max(trading.buy_tax_pct ?? 0, gp.buy_tax_pct ?? 0);
  const tax = Math.max(sellTax, buyTax);
  if (tax > 10) add('high', 'tax', `It taxes trades: ${buyTax}% to buy, ${sellTax}% to sell`, 'The higher of 0x\'s and GoPlus\'s figures.', '0x quote / GoPlus');
  else if (tax > 5) add('medium', 'tax', `It taxes trades: ${buyTax}% to buy, ${sellTax}% to sell`, 'The higher of 0x\'s and GoPlus\'s figures.', '0x quote / GoPlus');

  if (source.verified === false) add('high', 'unverified', 'Its source code isn\'t verified', 'Nothing it can do can be read.', 'explorer');
  if (ownership.upgradeable || source.proxy || gp.proxy) add('high', 'upgradeable', 'Its code can be replaced (a proxy)', ownership.implementation ? `Implementation now: ${ownership.implementation}` : 'Reported as a proxy.', ownership.upgradeable ? 'RPC' : source.proxy ? 'explorer' : 'GoPlus');
  if (gp.hidden_owner) add('high', 'hidden_owner', 'It has a hidden owner', 'hidden_owner = 1', 'GoPlus');
  if (gp.take_back_ownership) add('high', 'take_back_ownership', 'Ownership can be taken back after renouncing', 'can_take_back_ownership = 1', 'GoPlus');
  if (gp.selfdestruct) add('high', 'selfdestruct', 'It can self-destruct', 'selfdestruct = 1', 'GoPlus');

  const p = source.powers || {};
  const powerSev = { mint: 'high', blacklist: 'high', fees: 'medium', pause: 'medium', limits: 'medium', trading: 'medium' };
  const powerTitle = { mint: 'New tokens can be minted', blacklist: 'Holders can be blacklisted', fees: 'Its fees or taxes can be changed', pause: 'Transfers can be paused', limits: 'Transaction or wallet limits can be changed', trading: 'Trading can be switched on or off' };
  // GoPlus's reading of the same power, where it has one.
  const goplusSays = { mint: gp.mintable, blacklist: gp.blacklist, pause: gp.pausable };
  // Who holds each power through a role: its own role, or the admin role that grants it.
  const roleList = holders?.roles?.list || null;
  const heldBy = k => (roleList || []).filter(r => (r.power === k || r.power === 'admin') && r.holders.length);
  for (const [k, fns] of Object.entries(p)) {
    if (!fns.length) continue;
    // Renounced ownership makes an onlyOwner power dead code, but a role or
    // a proxy can still hold it. With the roles read, that is known; without
    // them, lowered to medium when GoPlus still reports the power, to info
    // when nothing does.
    const roles = heldBy(k);
    let sev, why;
    if (ownership.renounced && roles.length) {
      sev = powerSev[k];
      why = ` Ownership is renounced, but roles hold it: ${roles.map(r => `${r.role} (${r.holders.length})`).join(', ')}.`;
    } else if (ownership.renounced && roleList) {
      sev = goplusSays[k] ? 'medium' : 'info';
      why = ' Ownership is renounced and no role holds it.';
    } else {
      sev = ownerLive || ownership.renounced === null ? powerSev[k] : goplusSays[k] ? 'medium' : 'info';
      why = ownership.renounced
        ? goplusSays[k] ? ' Ownership is renounced, but GoPlus still reports this power: a role may hold it.' : ' Ownership is renounced, so an owner-only power is dead; check whether a role holds it.'
        : holders?.owner ? ` The owner is ${holders.owner.label}.` : '';
    }
    add(sev, `power_${k}`, powerTitle[k], `Functions in the verified source: ${fns.join(', ')}.${why}`, 'verified ABI');
  }
  holderFlags(holders, add);
  if (gp.mintable && !(p.mint || []).length) add(ownerLive ? 'high' : 'medium', 'mintable', 'GoPlus reports it mintable', 'is_mintable = 1', 'GoPlus');
  if (gp.blacklist && !(p.blacklist || []).length) add('high', 'blacklist', 'GoPlus reports a blacklist', 'is_blacklisted = 1', 'GoPlus');
  if (gp.pausable && !(p.pause || []).length) add('medium', 'pausable', 'GoPlus reports transfers pausable', 'transfer_pausable = 1', 'GoPlus');
  if (gp.slippage_modifiable) add('high', 'slippage_modifiable', 'The owner can change the tax at will', 'slippage_modifiable = 1', 'GoPlus');

  if (gp.top10_people_pct !== null && gp.top10_people_pct !== undefined) {
    if (gp.top10_people_pct > 50) add('high', 'concentration', `The top holders (excluding pools, lockers and burns) hold ${gp.top10_people_pct}%`, 'Of the ten largest holders GoPlus lists.', 'GoPlus');
    else if (gp.top10_people_pct > 30) add('medium', 'concentration', `The top holders (excluding pools, lockers and burns) hold ${gp.top10_people_pct}%`, 'Of the ten largest holders GoPlus lists.', 'GoPlus');
  }
  if (gp.lp_locked_pct !== null && gp.lp_locked_pct !== undefined && gp.lp_locked_pct < 50) {
    add(gp.lp_locked_pct < 10 ? 'high' : 'medium', 'lp_unlocked', `Only ${gp.lp_locked_pct}% of its liquidity is locked or burned`, 'Of the liquidity-pool tokens GoPlus lists.', 'GoPlus');
  }
  if (ownership.renounced) add('info', 'renounced', 'Ownership is renounced', `owner() is ${ownership.owner}.`, 'RPC');
  return flags;
}

/** Where our checks and GoPlus disagree, both are said. */
function disagreements(trading, gp) {
  const out = [];
  if (trading.sellable === true && gp.honeypot === true) out.push('0x could sell it straight back, but GoPlus calls it a honeypot: it may block sells only for some holders or after a delay.');
  if (trading.sellable === false && gp.honeypot === false) out.push('GoPlus doesn\'t call it a honeypot, but 0x found no way to sell it back: the pool may be too thin.');
  for (const side of ['buy', 'sell']) {
    const a = trading[`${side}_tax_pct`], b = gp[`${side}_tax_pct`];
    if (a !== null && a !== undefined && b !== null && b !== undefined && Math.abs(a - b) > 2) out.push(`The ${side} tax differs: ${a}% by 0x, ${b}% by GoPlus.`);
  }
  return out;
}

// ── Who holds the powers ────────────────────────────────────────────

const ROLE_GRANTED = ethers.id('RoleGranted(bytes32,address,address)');
const ROLE_REVOKED = ethers.id('RoleRevoked(bytes32,address,address)');
const ACCESS = new ethers.Interface([
  'function hasRole(bytes32,address) view returns (bool)',
  'function getRoleMemberCount(bytes32) view returns (uint256)',
  'function getRoleMember(bytes32,uint256) view returns (address)',
  'function pendingOwner() view returns (address)',
  'function getThreshold() view returns (uint256)',
  'function getOwners() view returns (address[])',
  'function getMinDelay() view returns (uint256)',
]);
const MAX_ROLE_LOG_PAGES = 3;
const MAX_HOLDERS = 25;
/** Roles by hash: OpenZeppelin's admin role, and common names; a contract's own *_ROLE() getters add to these. */
const KNOWN_ROLES = {
  [ethers.ZeroHash]: 'DEFAULT_ADMIN_ROLE',
  ...Object.fromEntries(['MINTER_ROLE', 'PAUSER_ROLE', 'BURNER_ROLE', 'UPGRADER_ROLE', 'BLACKLISTER_ROLE', 'BLOCKLISTER_ROLE', 'FREEZER_ROLE', 'ADMIN_ROLE', 'MANAGER_ROLE', 'OPERATOR_ROLE', 'GOVERNOR_ROLE', 'RESCUER_ROLE', 'FEE_MANAGER_ROLE'].map(n => [ethers.id(n), n])),
};
/** What a role's name says it can do. */
function rolePower(name) {
  if (/DEFAULT_ADMIN|^ADMIN|OWNER|GOVERNOR/i.test(name)) return 'admin';
  if (/MINT/i.test(name)) return 'mint';
  if (/BLACK|BLOCK|DENY|FREEZ|BAN/i.test(name)) return 'blacklist';
  if (/PAUS/i.test(name)) return 'pause';
  if (/UPGRAD/i.test(name)) return 'upgrade';
  if (/FEE|TAX/i.test(name)) return 'fees';
  return null;
}

async function viewCall(chain, to, fn, args = []) {
  try {
    const r = await evmRpc(chain, 'eth_call', [{ to, data: ACCESS.encodeFunctionData(fn, args) }, 'latest']);
    return r && r !== '0x' ? ACCESS.decodeFunctionResult(fn, r) : null;
  } catch { return null; }
}

/** What an address is: one key, a Safe and its threshold, a timelock and its delay, or another contract. */
async function whoIs(chain, address) {
  const code = await evmRpc(chain, 'eth_getCode', [address, 'latest']);
  if (typeof code !== 'string') return { is: 'unknown', one_key: false, label: 'not read (no code returned)' };
  if (code === '0x') return { is: 'wallet', one_key: true, label: 'a plain wallet (one key)' };
  if (/^0xef0100/i.test(code)) return { is: 'wallet', one_key: true, label: 'a wallet with delegated code (EIP-7702): one key' };
  const t = await viewCall(chain, address, 'getThreshold');
  const o = t && await viewCall(chain, address, 'getOwners');
  if (t && o) return { is: 'safe', threshold: Number(t[0]), signers: o[0].length, one_key: Number(t[0]) <= 1, label: `a Safe, ${t[0]} of ${o[0].length}` };
  const d = await viewCall(chain, address, 'getMinDelay');
  if (d) return { is: 'timelock', delay_seconds: Number(d[0]), one_key: false, label: `a timelock with a ${Number(d[0])}-second delay` };
  return { is: 'contract', one_key: false, label: 'a contract whose rules aren\'t read here' };
}

/** Accounts holding each role now: from the logs, each confirmed with hasRole. */
async function rolesFromLogs(chain, token) {
  const events = [];
  let incomplete = false;
  for (const topic0 of [ROLE_GRANTED, ROLE_REVOKED]) {
    for (let page = 1; page <= MAX_ROLE_LOG_PAGES; page++) {
      const data = await explorerGet(chain, { module: 'logs', action: 'getLogs', address: token, topic0, fromBlock: 0, toBlock: 'latest', page, offset: 1000 });
      const rows = Array.isArray(data?.result) ? data.result : [];
      if (data?.status !== '1' && rows.length === 0) {
        if (/no records/i.test(String(data?.message || ''))) break;
        throw new Error(`the explorer said: ${typeof data?.result === 'string' ? data.result : data?.message || 'no logs'}`);
      }
      for (const l of rows) events.push({ granted: topic0 === ROLE_GRANTED, role: String(l.topics?.[1] || '').toLowerCase(), account: ('0x' + String(l.topics?.[2] || '').slice(-40)).toLowerCase(), block: Number(l.blockNumber) || 0, index: Number(l.logIndex) || 0 }); // the explorer writes a zero index as "0x"
      if (rows.length < 1000) break;
      if (page === MAX_ROLE_LOG_PAGES) incomplete = true;
    }
  }
  // The latest event per role and account decides; hasRole has the last word.
  events.sort((a, b) => a.block - b.block || a.index - b.index);
  const state = new Map();
  for (const e of events) state.set(`${e.role}|${e.account}`, e.granted);
  const out = new Map();
  for (const [k, granted] of state) {
    if (!granted) continue;
    const [role, account] = k.split('|');
    const live = await viewCall(chain, token, 'hasRole', [role, account]);
    if (live && live[0] === true) (out.get(role) || out.set(role, []).get(role)).push(account);
  }
  return { holders: out, incomplete, source: 'the explorer\'s RoleGranted and RoleRevoked logs, each confirmed with hasRole (RPC)' };
}

/** Accounts holding each named role, from a contract that lists them. */
async function rolesFromEnumeration(chain, token, names) {
  const out = new Map();
  for (const role of Object.keys(names)) {
    const n = await viewCall(chain, token, 'getRoleMemberCount', [role]);
    const count = n ? Math.min(Number(n[0]), MAX_HOLDERS) : 0;
    for (let i = 0; i < count; i++) {
      const m = await viewCall(chain, token, 'getRoleMember', [role, i]);
      if (m) (out.get(role) || out.set(role, []).get(role)).push(String(m[0]).toLowerCase());
    }
  }
  return { holders: out, incomplete: false, source: 'RPC: the contract\'s own list of role members (named roles only)' };
}

/** Who holds the owner's and the roles' powers. */
async function evmHolders(chain, token, source, ownership) {
  if (ownership.not_checked) return { not_checked: ownership.not_checked };
  const cache = new Map();
  const who = async a => { if (!cache.has(a)) cache.set(a, await whoIs(chain, a).catch(err => ({ is: 'unknown', one_key: false, label: `not read (${err.message})` }))); return cache.get(a); };
  const out = { source: 'RPC' };
  if (ownership.owner && !ownership.renounced) out.owner = { address: ownership.owner, ...(await who(ownership.owner)) };
  if (source.two_step) {
    const p = await viewCall(chain, token, 'pendingOwner');
    const pending = p ? String(p[0]).toLowerCase() : null;
    if (pending && !DEAD.has(pending)) out.pending_owner = { address: pending, ...(await who(pending)) };
  }
  if (!source.access_control) return out;
  const names = { ...KNOWN_ROLES };
  for (const fn of source.role_getters || []) {
    try {
      const r = await evmRpc(chain, 'eth_call', [{ to: token, data: ethers.id(`${fn}()`).slice(0, 10) }, 'latest']);
      if (r && r.length >= 66) names[r.slice(0, 66).toLowerCase()] = fn;
    } catch { /* a getter that fails names nothing */ }
  }
  let read;
  try {
    read = await rolesFromLogs(chain, token);
  } catch (err) {
    if (!source.enumerable) { out.roles = { not_checked: `Role holders: ${err.message}` }; return out; }
    read = await rolesFromEnumeration(chain, token, names);
    read.note = `The logs couldn't be read (${err.message}); roles were read from the contract's own list.`;
  }
  const roles = [];
  for (const [hash, accounts] of read.holders) {
    const name = names[hash] || `unnamed role ${hash.slice(0, 10)}…`;
    const holders = [];
    for (const a of accounts.slice(0, MAX_HOLDERS)) holders.push({ address: a, ...(await who(a)) });
    roles.push({ role: name, hash, power: rolePower(name), holders, ...(accounts.length > MAX_HOLDERS ? { more: accounts.length - MAX_HOLDERS } : {}) });
  }
  out.roles = { source: read.source, list: roles, ...(read.incomplete ? { incomplete: `More than ${MAX_ROLE_LOG_PAGES * 1000} role logs of one kind: the oldest are read.` } : {}), ...(read.note ? { note: read.note } : {}) };
  return out;
}

/** The flags that say who holds the powers. */
function holderFlags(holders, add) {
  if (!holders || holders.not_checked) return;
  if (holders.owner) add(holders.owner.one_key ? 'medium' : 'info', 'owner_is', `The owner is ${holders.owner.label}`, `owner() is ${holders.owner.address}.`, 'RPC');
  if (holders.pending_owner) add('medium', 'pending_owner', `Ownership is being handed to ${holders.pending_owner.label}`, `pendingOwner() is ${holders.pending_owner.address}: it takes over when it accepts.`, 'RPC');
  const sev = { admin: 'high', mint: 'high', blacklist: 'high', upgrade: 'high', pause: 'medium', fees: 'medium' };
  const does = { admin: 'can grant and revoke every role', mint: 'can mint', blacklist: 'can blacklist or freeze holders', upgrade: 'can replace the code', pause: 'can pause transfers', fees: 'can change fees' };
  for (const r of holders.roles?.list || []) {
    for (const h of r.holders) {
      const what = r.power ? `: it ${does[r.power]}` : '';
      if (h.one_key) add(r.power ? sev[r.power] : 'info', `role_${r.power || 'other'}`, `One key holds ${r.role}${what}`, `${h.address} is ${h.label}.`, 'explorer logs / RPC');
      else if (h.is === 'contract' || h.is === 'unknown') add(r.power ? 'medium' : 'info', `role_${r.power || 'other'}`, `${r.role} is held by a contract whose rules aren't read${what}`, `${h.address}.`, 'explorer logs / RPC');
      else add('info', `role_${r.power || 'other'}`, `${r.role} is held by ${h.label}`, `${h.address}.`, 'explorer logs / RPC');
    }
  }
}

async function scanEvm(chain, token) {
  const [source, ownership, trading, gp] = await Promise.all([evmSource(chain, token), evmOwnerAndProxy(chain, token), evmTrading(chain, token), goplus(chain, token)]);
  const holders = source.verified ? await evmHolders(chain, token, source, ownership).catch(err => ({ not_checked: `Holders of the powers: ${err.message}` })) : null;
  const flags = evmFlags({ source, ownership, trading, gp, holders });
  return { checks: { source, ownership, trading, goplus: gp, ...(holders ? { holders } : {}) }, flags, disagreements: disagreements(trading, gp), incomplete: !!(trading.not_checked && gp.not_checked) };
}

// ── Solana ─────────────────────────────────────────────────────────────────

const solanaRpc = (method, params) => rpc.solanaRpc(method, params);

async function jupiterOut(inputMint, outputMint, amount) {
  const key = env.jupiterApiKey;
  const url = key ? 'https://api.jup.ag/swap/v1' : 'https://lite-api.jup.ag/swap/v1';
  const data = await track('jupiter', async () => (await axios.get(`${url}/quote`, { params: { inputMint, outputMint, amount: String(amount), slippageBps: 300 }, headers: key ? { 'x-api-key': key } : {}, timeout: 15000 })).data);
  return data?.outAmount ? BigInt(data.outAmount) : null;
}

async function scanSolana(mint) {
  const flags = [];
  const add = (severity, id, title, evidence, source) => flags.push({ id, severity, title, evidence, source });
  const checks = {};

  try {
    const acct = await solanaRpc('getAccountInfo', [mint, { encoding: 'jsonParsed' }]);
    const v = acct?.value;
    const info = v?.data?.parsed?.info;
    if (!info) {
      checks.mint = { not_checked: 'not a token mint' };
    } else {
      const exts = Array.isArray(info.extensions) ? info.extensions : [];
      const ext = name => exts.find(e => e.extension === name)?.state || null;
      const fee = ext('transferFeeConfig');
      const feeBps = fee ? Number(fee.newerTransferFee?.transferFeeBasisPoints ?? fee.olderTransferFee?.transferFeeBasisPoints ?? 0) : 0;
      const delegate = ext('permanentDelegate')?.delegate || null;
      const hook = ext('transferHook')?.programId || null;
      const frozenByDefault = ext('defaultAccountState')?.accountState === 'frozen';
      checks.mint = {
        source: 'Solana RPC', program: v.owner === TOKEN_2022 ? 'Token-2022' : 'SPL Token',
        supply: String(info.supply ?? ''), decimals: info.decimals,
        mint_authority: info.mintAuthority || null, freeze_authority: info.freezeAuthority || null,
        extensions: exts.map(e => e.extension), transfer_fee_pct: pct(feeBps), permanent_delegate: delegate, transfer_hook: hook, frozen_by_default: frozenByDefault,
      };
      if (info.freezeAuthority) add('critical', 'freeze_authority', 'Its issuer can freeze any holder\'s tokens', `Freeze authority: ${info.freezeAuthority}.`, 'Solana RPC');
      if (delegate) add('critical', 'permanent_delegate', 'Someone can move or burn any holder\'s tokens', `Permanent delegate: ${delegate}.`, 'Solana RPC');
      if (frozenByDefault) add('critical', 'frozen_by_default', 'New token accounts start frozen', 'defaultAccountState = frozen.', 'Solana RPC');
      if (info.mintAuthority) add('high', 'mint_authority', 'New tokens can still be minted', `Mint authority: ${info.mintAuthority}.`, 'Solana RPC');
      if (hook) add('high', 'transfer_hook', 'Every transfer runs another program, which can block it', `Transfer hook program: ${hook}.`, 'Solana RPC');
      if (feeBps > 1000) add('high', 'transfer_fee', `It takes ${pct(feeBps)}% of every transfer`, 'Token-2022 transfer fee.', 'Solana RPC');
      else if (feeBps > 500) add('medium', 'transfer_fee', `It takes ${pct(feeBps)}% of every transfer`, 'Token-2022 transfer fee.', 'Solana RPC');

      try {
        const largest = await solanaRpc('getTokenLargestAccounts', [mint]);
        const top = (largest?.value || []).slice(0, 10);
        const supply = Number(info.supply) || 0;
        const owners = top.length ? await solanaRpc('getMultipleAccounts', [top.map(t => t.address), { encoding: 'jsonParsed' }]) : { value: [] };
        const rows = top.map((t, i) => ({ account: t.address, owner: owners?.value?.[i]?.data?.parsed?.info?.owner || null, share: supply ? Number(t.amount) / supply : null }));
        const top10 = supply ? Math.round(rows.reduce((s, r) => s + (r.share || 0), 0) * 10000) / 100 : null;
        checks.holders = { source: 'Solana RPC', top10_pct: top10, top_holders: rows, note: 'Pools and lockers aren\'t told apart here: the largest holder is often the liquidity pool.' };
        if (top10 !== null && top10 > 80) add('high', 'concentration', `The ten largest accounts hold ${top10}%`, 'Including any pools.', 'Solana RPC');
        else if (top10 !== null && top10 > 50) add('medium', 'concentration', `The ten largest accounts hold ${top10}%`, 'Including any pools.', 'Solana RPC');
      } catch (err) {
        checks.holders = { not_checked: `Solana RPC: ${err.message}` };
      }
    }
  } catch (err) {
    checks.mint = { not_checked: err.message };
  }

  try {
    const got = await jupiterOut(WSOL, mint, SOL_PROBE_LAMPORTS);
    if (!got) {
      checks.trading = { source: 'Jupiter quote', buyable: false, note: 'Jupiter found no route to buy it' };
      add('medium', 'no_liquidity', 'No liquidity was found to trade it', 'Jupiter found no route to buy it with 0.1 SOL.', 'Jupiter quote');
    } else {
      const back = await jupiterOut(mint, WSOL, got).catch(() => null);
      const loss = back === null ? null : Number((SOL_PROBE_LAMPORTS - back) * 10000n / SOL_PROBE_LAMPORTS) / 100;
      checks.trading = { source: 'Jupiter quote', probe: '0.1 SOL', buyable: true, sellable: back !== null, round_trip_loss_pct: loss };
      if (back === null) add('critical', 'unsellable', 'It could not be sold back after a buy', 'Jupiter quoted a buy of 0.1 SOL, and no sell back.', 'Jupiter quote');
      else if (loss > 50) add('critical', 'round_trip', `Selling straight back loses ${loss}%`, 'A buy of 0.1 SOL sold straight back.', 'Jupiter quote');
      else if (loss > 20) add('high', 'round_trip', `Selling straight back loses ${loss}%`, 'A buy of 0.1 SOL sold straight back: a transfer fee, or a thin pool.', 'Jupiter quote');
    }
  } catch (err) {
    checks.trading = { not_checked: `Jupiter: ${err.response?.data?.error || err.message}` };
  }
  return { checks, flags, disagreements: [], incomplete: !!(checks.mint?.not_checked || checks.trading?.not_checked) };
}

const RANK = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

/** The full scan of one token. Never throws for a check that fails; it says so. */
async function scanToken({ chain, token_address }) {
  chain = String(chain || '').toLowerCase();
  if (!SCAN_CHAINS.includes(chain)) return { error: `chain must be one of: ${SCAN_CHAINS.join(', ')}.` };
  const token = String(token_address || '').trim();
  if (chain === 'solana' ? !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(token) : !isAddr(token)) {
    return { error: chain === 'solana' ? 'token_address must be a Solana mint address.' : 'token_address must be a contract address (0x and 40 hex characters).' };
  }
  const out = chain === 'solana' ? await scanSolana(token) : await scanEvm(chain, token.toLowerCase());
  out.flags.sort((a, b) => RANK[b.severity] - RANK[a.severity]);
  const worst = out.flags.find(f => f.severity !== 'info');
  const verdict = worst ? worst.severity : (out.incomplete ? 'incomplete' : 'low');
  return {
    chain, token, checked_at: new Date().toISOString(),
    verdict,
    ...(out.incomplete ? { incomplete: 'The checks that decide whether it can be sold didn\'t run; don\'t rate it low on what is here.' } : {}),
    flags: out.flags,
    disagreements: out.disagreements,
    checks: out.checks,
    note: 'Each flag names its source. A clean scan is not proof of safety: it checks known patterns, not intent.',
  };
}

module.exports = { scanToken, goplus, SCAN_CHAINS, EVM_CHAINS, POWERS, powersFromAbi, evmFlags, disagreements, rolePower, KNOWN_ROLES, ROLE_GRANTED, ROLE_REVOKED };
