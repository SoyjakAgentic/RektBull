/**
 * The checks behind the Trade Router's mainnet deployments (Base, Ethereum,
 * Arbitrum; one router per chain, each with its own config/<chain>.json),
 * shared by scripts/deployRouter.js (before and after deploying),
 * scripts/verifyRouter.js (any time later) and test/routerDeploy.test.js (on a
 * fork of each chain).
 *
 * Each check returns { name, ok, detail } and names where its answer came
 * from: the chain, git, or the compiler output. Nothing here signs anything.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const ROOT = path.join(import.meta.dirname, '..', '..'); // contracts/
export const SEQUENCER_GRACE_PERIOD = 3600;
const GAP_SLACK = 120; // seconds a feed may run past its heartbeat before we call the heartbeat wrong

const FEED_ABI = [
  'function description() view returns (string)',
  'function decimals() view returns (uint8)',
  'function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)',
  'function getRoundData(uint80) view returns (uint80, int256, uint256, uint256, uint80)',
];
const ERC20_ABI = ['function name() view returns (string)', 'function symbol() view returns (string)', 'function decimals() view returns (uint8)'];
const SAFE_ABI = ['function getThreshold() view returns (uint256)', 'function getOwners() view returns (address[])', 'function VERSION() view returns (string)'];

/** The chains the router is deployed on, and the Hardhat networks that reach each. */
export const CHAINS = ['base', 'ethereum', 'arbitrum'];
export const chainOfNetwork = name => CHAINS.find(c => name === c || name === `${c}MainnetFork` || name === `${c}Read`) || null;

/** A chain's parameters (config/<chain>.json), or a file given by path. */
export function loadParams(chain = 'base') {
  const file = String(chain).includes('/') ? chain : path.join(ROOT, 'config', `${chain}.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const ZERO = '0x0000000000000000000000000000000000000000';
/** The sequencer feed's address, or zero where the chain has none (Ethereum). */
const sequencerOf = p => p.sequencerUptimeFeed?.address || ZERO;

/** The router's constructor arguments, in order. */
export function routerArgs(p, feeWallet) {
  return [
    feeWallet, p.feeBps, p.maxSlippageBps, sequencerOf(p), p.spendPermissionManager,
    p.venues.map(v => v.address), p.tokens.map(t => t.address), p.tokens.map(t => t.feed.address), p.tokens.map(t => t.maxAge),
  ];
}

function collector() {
  const results = [];
  const add = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); return !!ok; };
  return { results, add };
}

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const ago = s => (s < 120 ? `${s}s` : s < 7200 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);

/**
 * The audited sources are what will be compiled: unchanged since the audited
 * commit (git), the same OpenZeppelin release, and the audited compiler
 * settings (the compiler's own build record). A source listed in the config's
 * awaitingAudit (changed since the audit, or never covered by it) always
 * fails, with the reason given there, until a new audit moves auditedCommit
 * on and the entry is removed.
 */
export function checkSources(p, artifact) {
  const { results, add } = collector();
  for (const src of p.auditedSources) {
    let detail, ok = false;
    if (p.awaitingAudit?.[src]) { add(`source ${src}`, false, `awaiting audit: ${p.awaitingAudit[src]} (config)`); continue; }
    try {
      execFileSync('git', ['diff', '--quiet', p.auditedCommit, '--', src], { cwd: ROOT, stdio: 'pipe' });
      ok = true; detail = `unchanged since ${p.auditedCommit} (git)`;
    } catch (e) {
      detail = e.status === 1 ? `changed since the audited commit ${p.auditedCommit} (git diff)` : `couldn't compare with ${p.auditedCommit}: ${String(e.stderr || e.message).trim().split('\n')[0]} (fetch the full history)`;
    }
    add(`source ${src}`, ok, detail);
  }
  const oz = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', '@openzeppelin', 'contracts', 'package.json'), 'utf8')).version;
  add('OpenZeppelin Contracts', oz === p.openzeppelin, `${oz} installed, ${p.openzeppelin} audited (node_modules)`);
  const info = JSON.parse(fs.readFileSync(path.join(ROOT, 'artifacts', 'build-info', `${artifact.buildInfoId}.json`), 'utf8'));
  const s = info.input.settings;
  add('compiler settings', info.solcVersion === '0.8.24' && s.optimizer?.enabled && s.optimizer.runs === 200 && s.viaIR === true && s.evmVersion === 'cancun',
    `solc ${info.solcLongVersion}, optimizer ${s.optimizer?.enabled ? `on (${s.optimizer.runs} runs)` : 'off'}, viaIR ${s.viaIR}, evm ${s.evmVersion} (build-info ${artifact.buildInfoId})`);
  return results;
}

/** Every parameter, read back from the chain before anything is deployed. */
export async function preflight(ethers, p, { feeWallet, rehearsal = false, rounds = 12 } = {}) {
  const { results, add } = collector();
  const provider = ethers.provider;
  const chainId = Number((await provider.getNetwork()).chainId);
  add('chain', chainId === p.chainId, `chain id ${chainId}, expected ${p.chainId} (RPC)`);
  const now = (await provider.getBlock('latest')).timestamp;

  add('fee', Number.isInteger(p.feeBps) && p.feeBps >= 0 && p.feeBps <= 100, `${p.feeBps / 100}% (the router allows at most 1%)`);
  add('price bound', Number.isInteger(p.maxSlippageBps) && p.maxSlippageBps > 0 && p.maxSlippageBps <= 500, `${p.maxSlippageBps / 100}% (the router allows 0.01% to 5%)`);

  if (!ethers.isAddress(feeWallet || '')) add('fee wallet', false, 'set FEE_WALLET to the Safe that receives fees');
  else if ((await provider.getCode(feeWallet)) === '0x') add('fee wallet', rehearsal, rehearsal ? `${feeWallet}: a plain address, allowed in a rehearsal only` : `${feeWallet} has no code: the fee wallet must be a Safe, never a hot key`);
  else {
    try {
      const safe = new ethers.Contract(feeWallet, SAFE_ABI, provider);
      const [threshold, owners, version] = await Promise.all([safe.getThreshold(), safe.getOwners(), safe.VERSION()]);
      add('fee wallet', true, `${feeWallet}: Safe ${version}, ${threshold} of ${owners.length} owners must sign (onchain)`);
    } catch {
      add('fee wallet', false, `${feeWallet} has code but doesn't answer as a Safe (getThreshold, getOwners)`);
    }
  }

  // The sequencer feed: up, and up for longer than the router's grace period. Only Ethereum may have none.
  if (!p.sequencerUptimeFeed) add('sequencer feed', p.chainId === 1, p.chainId === 1 ? 'none: Ethereum has no sequencer, so the router skips that check' : 'missing: every L2 needs its sequencer uptime feed');
  else try {
    const seq = new ethers.Contract(p.sequencerUptimeFeed.address, FEED_ABI, provider);
    const [desc, r] = await Promise.all([seq.description(), seq.latestRoundData()]);
    const up = r[1] === 0n, since = now - Number(r[2]);
    add('sequencer feed', desc === p.sequencerUptimeFeed.description && up && Number(r[2]) > 0 && since > SEQUENCER_GRACE_PERIOD,
      `"${desc}": sequencer ${up ? 'up' : 'DOWN'} for ${ago(since)} (onchain)`);
  } catch (e) { add('sequencer feed', false, `couldn't read it: ${e.shortMessage || e.message}`); }

  for (const [name, addr] of [['Spend Permission Manager', p.spendPermissionManager], ...p.venues.map(v => [`venue ${v.name}`, v.address])]) {
    const size = ((await provider.getCode(addr)).length - 2) / 2;
    add(name, size > 0, `${addr}: ${size ? `${size} bytes of code` : 'no code'} (onchain)`);
  }

  for (const t of p.tokens) {
    try {
      const token = new ethers.Contract(t.address, ERC20_ABI, provider);
      const [name, symbol, decimals] = await Promise.all([token.name(), token.symbol(), token.decimals()]);
      add(`token ${t.symbol}`, name === t.name && symbol === t.symbol && Number(decimals) === t.decimals, `${t.address}: "${name}" (${symbol}), ${decimals} decimals (onchain)`);
    } catch (e) { add(`token ${t.symbol}`, false, `${t.address}: couldn't read it: ${e.shortMessage || e.message}`); }

    const f = t.feed;
    try {
      const feed = new ethers.Contract(f.address, FEED_ABI, provider);
      const [desc, decimals, r] = await Promise.all([feed.description(), feed.decimals(), feed.latestRoundData()]);
      const age = now - Number(r[3]);
      add(`feed ${f.description}`, desc === f.description && Number(decimals) === f.decimals && r[1] > 0n && age <= t.maxAge,
        `${f.address}: "${desc}", ${decimals} decimals, ${ethers.formatUnits(r[1], decimals)} USD, updated ${ago(age)} ago (onchain)`);
      // How often it has actually updated: the gaps between its last rounds.
      const gaps = [];
      let id = r[0], prev = Number(r[3]);
      for (let i = 0; i < rounds; i++) {
        id -= 1n;
        const x = await feed.getRoundData(id).catch(() => null);
        if (!x || Number(x[3]) === 0) break;
        gaps.push(prev - Number(x[3]));
        prev = Number(x[3]);
      }
      const maxGap = gaps.length ? Math.max(...gaps) : null;
      add(`heartbeat ${f.description}`, maxGap !== null && maxGap <= f.heartbeat + GAP_SLACK && t.maxAge > f.heartbeat && t.maxAge <= 2 * f.heartbeat && maxGap < t.maxAge,
        maxGap === null ? 'no earlier rounds to measure'
          : `longest gap in the last ${gaps.length} rounds ${ago(maxGap)}; heartbeat ${ago(f.heartbeat)}; the router will refuse prices older than ${ago(t.maxAge)} (onchain round history)`);
    } catch (e) { add(`feed ${f.description}`, false, `${f.address}: couldn't read it: ${e.shortMessage || e.message}`); }
  }
  return results;
}

/** Runtime code with the immutable values zeroed, so code can be compared apart from its constructor arguments. */
export function maskImmutables(hex, refs) {
  const buf = Buffer.from(String(hex).replace(/^0x/, ''), 'hex');
  for (const list of Object.values(refs || {})) for (const { start, length } of list) buf.fill(0, start, start + length);
  return buf;
}

export function sameCode(onchain, artifact) {
  const strip = h => String(h).replace(/^0x/, '').toLowerCase();
  if (!strip(onchain) || strip(onchain).length !== strip(artifact.deployedBytecode).length) return false;
  return maskImmutables(onchain, artifact.immutableReferences).equals(maskImmutables(artifact.deployedBytecode, artifact.immutableReferences));
}

/** A deployed router (and Safe module) read back: code, every setting, and a live price through it. */
export async function verifyDeployment(ethers, p, dep, { router: routerArtifact, module: moduleArtifact }) {
  const { results, add } = collector();
  const provider = ethers.provider;
  const chainId = Number((await provider.getNetwork()).chainId);
  add('chain', chainId === p.chainId && dep.chainId === p.chainId, `chain id ${chainId}; deployment file says ${dep.chainId} (RPC)`);

  const code = await provider.getCode(dep.router);
  add('router code', sameCode(code, routerArtifact), `${dep.router}: ${sameCode(code, routerArtifact) ? 'matches' : 'does NOT match'} the compiled RektBullTradeRouter, apart from its settings (onchain vs artifacts/)`);
  const r = new ethers.Contract(dep.router, routerArtifact.abi, provider);
  const [feeWallet, feeBps, slip, seq, spm, maxFee] = await Promise.all([r.FEE_WALLET(), r.FEE_BPS(), r.MAX_SLIPPAGE_BPS(), r.SEQUENCER_UPTIME_FEED(), r.SPEND_PERMISSION_MANAGER(), r.MAX_FEE_BPS()]);
  add('fee wallet', same(feeWallet, dep.feeWallet), `FEE_WALLET ${feeWallet} (onchain)`);
  add('fee', Number(feeBps) === p.feeBps && Number(maxFee) === 100, `FEE_BPS ${feeBps}, MAX_FEE_BPS ${maxFee} (onchain)`);
  add('price bound', Number(slip) === p.maxSlippageBps, `MAX_SLIPPAGE_BPS ${slip} (onchain)`);
  add('sequencer feed', same(seq, sequencerOf(p)), `SEQUENCER_UPTIME_FEED ${seq}${same(seq, ZERO) ? ' (none: no sequencer on this chain)' : ''} (onchain)`);
  add('Spend Permission Manager', same(spm, p.spendPermissionManager), `SPEND_PERMISSION_MANAGER ${spm} (onchain)`);
  for (const v of p.venues) add(`venue ${v.name}`, await r.isVenue(v.address), `isVenue(${v.address}) (onchain)`);
  for (const t of p.tokens) {
    const [feed, maxAge] = await Promise.all([r.priceFeed(t.address), r.maxPriceAge(t.address)]);
    add(`${t.symbol} feed`, same(feed, t.feed.address) && Number(maxAge) === t.maxAge, `priceFeed ${feed}, maxPriceAge ${maxAge}s (onchain)`);
    try {
      const usd = await r.valueUsd(t.address, 10n ** BigInt(t.decimals));
      add(`${t.symbol} price through the router`, usd > 0n, `1 ${t.symbol} = ${ethers.formatUnits(usd, 8)} USD (router's valueUsd: sequencer up, price fresh)`);
    } catch (e) { add(`${t.symbol} price through the router`, false, `valueUsd refused: ${e.shortMessage || e.message}`); }
  }

  if (dep.safeModule) {
    const mcode = await provider.getCode(dep.safeModule);
    add('Safe module code', sameCode(mcode, moduleArtifact), `${dep.safeModule}: ${sameCode(mcode, moduleArtifact) ? 'matches' : 'does NOT match'} the compiled RektBullSafeModule (onchain vs artifacts/)`);
    const m = new ethers.Contract(dep.safeModule, moduleArtifact.abi, provider);
    add('Safe module router', same(await m.ROUTER(), dep.router), `ROUTER ${await m.ROUTER()} (onchain)`);
  }

  for (const [what, hash, address] of [['router', dep.routerTx, dep.router], ['Safe module', dep.safeModuleTx, dep.safeModule]]) {
    if (!hash) continue;
    const [tx, receipt] = await Promise.all([provider.getTransaction(hash), provider.getTransactionReceipt(hash)]);
    add(`${what} deployment`, tx && receipt?.status === 1 && same(tx.from, dep.deployer) && same(receipt.contractAddress, address),
      tx ? `${hash}: from ${tx.from}, block ${receipt?.blockNumber} (onchain)` : `${hash} not found`);
  }
  return results;
}

/** The server's AUTO_TRADING_NETWORKS entry for this deployment (the shape of src/trade/networks.js). */
export function autoTradingEntry(p, dep) {
  const venue = p.venues[0];
  return {
    [String(p.chainId)]: {
      name: p.chain, label: p.label, router: dep.router,
      venue: { type: '0x', address: venue.address },
      tokens: Object.fromEntries(p.tokens.map(t => [t.key || t.symbol, { address: t.address, decimals: t.decimals }])), // key: what users type (USDT for Arbitrum's USD₮0)
      defaultBase: p.defaultBase, safeModule: dep.safeModule, spendPermissionManager: p.spendPermissionManager,
      explorerTx: `${p.explorer}/tx/`,
      ...(p.sendRpc ? { sendRpc: p.sendRpc } : {}),
    },
  };
}

/** The compiler's standard JSON input, for verifying the source on the chain's explorer. */
export function standardInput(artifact) {
  const info = JSON.parse(fs.readFileSync(path.join(ROOT, 'artifacts', 'build-info', `${artifact.buildInfoId}.json`), 'utf8'));
  return { compiler: `v${info.solcLongVersion}`, contract: `${artifact.inputSourceName}:${artifact.contractName}`, input: info.input };
}

export function print(title, results) {
  console.log(`\n${title}`);
  for (const r of results) console.log(`  ${r.ok ? 'ok  ' : 'FAIL'}  ${r.name.padEnd(30)} ${r.detail}`);
  return results.every(r => r.ok);
}
