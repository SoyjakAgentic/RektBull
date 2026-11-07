/**
 * Protocol record pages: /dapps/<slug> for every DeFi protocol with $10M or
 * more locked (about 560), and /dapps, the index of them. Rendered on the
 * server, for the searches people make before they deposit ("is Aave safe?",
 * "has X been hacked?"): the question is asked, and answered with the record
 * and its sources, never with "yes" (docs/POSITIONING.md, docs/SEO.md).
 *
 * All data is what Discover already reads and caches (DefiLlama's protocols,
 * fees and hacks, Merkl's campaigns): no extra calls per page.
 */
const seo = require('./seo');

const MIN_TVL = 10e6;
const DAY = 86400000;
const esc = seo.esc;
const usd = v => {
  if (v === null || v === undefined || Number.isNaN(v)) return 'not recorded';
  const a = Math.abs(v);
  const [d, s] = a >= 1e9 ? [1e9, 'B'] : a >= 1e6 ? [1e6, 'M'] : a >= 1e3 ? [1e3, 'K'] : [1, ''];
  return `$${(v / d).toLocaleString('en-US', { maximumFractionDigits: d === 1 ? 0 : 1 })}${s}`;
};
const longDay = iso => new Date(`${String(iso).slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const plural = (n, one, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const list = items => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);
const pct = v => (v === null || v === undefined ? null : `${v >= 0 ? 'up' : 'down'} ${Math.abs(Math.round(v * 10) / 10)}%`);

/** The protocols that get a record page: $10M or more locked, largest first, with their rank. */
function eligible(protocols) {
  return protocols.filter(p => p.tvl >= MIN_TVL && /^[a-z0-9-]{1,80}$/.test(p.slug || '')).sort((a, b) => b.tvl - a.tvl).map((p, i) => ({ ...p, rank: i + 1 }));
}

/** Everything one page shows: the protocol, its hacks (with sources), fees, related protocols, live campaigns. */
async function gather(slug) {
  const llama = require('../providers/llama');
  const discover = require('../services/discover');
  const all = eligible(await llama.protocols());
  const p = all.find(x => x.slug === slug);
  if (!p) return null;
  const [feesR, hacksR, campR] = await Promise.allSettled([
    llama.fees(),
    llama.hackList(),
    require('../services/opportunities').campaigns({ limit: 100 }),
  ]);
  const notChecked = [];
  if (feesR.status === 'rejected') notChecked.push({ check: 'fees in the last 24 hours', reason: feesR.reason.message });
  if (hacksR.status === 'rejected') notChecked.push({ check: 'recorded hacks', reason: hacksR.reason.message });
  const hacks = hacksR.status === 'fulfilled' ? hacksR.value.filter(h => h.defillama_id === p.id) : [];
  const campaigns = campR.status === 'fulfilled' ? campR.value.campaigns.filter(c => c.protocol?.defillama_slug === slug) : [];
  return {
    p, all, notChecked, hacks, campaigns,
    fees: feesR.status === 'fulfilled' ? feesR.value.protocols[p.id]?.total ?? null : undefined,
    signals: discover.dappSignals(p, hacks.map(h => ({ date: h.date, amount_usd: h.amount_usd, technique: h.technique || h.classification, returned_usd: h.returned_usd }))),
    related: all.filter(x => x.category === p.category && x.slug !== slug).slice(0, 6),
    hacksRead: hacksR.status === 'fulfilled',
  };
}

/** The opening answer: what the record says, in sentences that can be quoted, each fact with its source. */
function summary({ p, hacks, hacksRead }, now) {
  const shown = p.chains.map(c => require('../services/discover').CHAIN_NAMES[c] || c).slice(0, 4);
  const more = Math.max(0, p.chain_count - shown.length);
  const chains = shown.length ? `${shown.join(', ')}${more ? ` and ${plural(more, 'more chain')}` : ''}` : null;
  const lost = hacks.reduce((t, h) => t + (h.amount_usd || 0), 0);
  const hackLine = !hacksRead ? 'The hack record couldn\'t be read just now.'
    : hacks.length ? `DefiLlama records ${plural(hacks.length, 'hack')} affecting ${p.name}${lost ? `, with ${usd(lost)} lost in all` : ''}; the most recent was on ${longDay(hacks[0].date)}.`
      : `DefiLlama records no hack affecting ${p.name}.`;
  const age = p.listed_at ? Math.floor((now - p.listed_at * 1000) / (365.25 * DAY)) : null;
  return [
    `${p.name} is a ${p.category} protocol${chains ? ` on ${chains}` : p.chain_count ? ` on ${plural(p.chain_count, 'chain')}` : ''}, with ${usd(p.tvl)} locked${pct(p.change_7d) ? ` (${pct(p.change_7d)} on the week)` : ''}${p.listed_at ? `, listed on DefiLlama since ${longDay(new Date(p.listed_at * 1000).toISOString())}${age >= 1 ? ` (${plural(age, 'year')})` : ''}` : ''}.`,
    hackLine,
    p.audit_links.length ? `${plural(p.audit_links.length, 'audit link')} ${p.audit_links.length === 1 ? 'is' : 'are'} listed for it.` : 'No audit is listed for it.',
  ];
}

function title(name) {
  const full = `Is ${name} Safe? Hacks, Audits and Record | RektBull`;
  if (full.length <= 60) return full;
  const short = `${name}: Hacks, Audits, Record | RektBull`;
  return short.length <= 60 ? short : `${name.slice(0, 60 - 24).trim()}…: Record | RektBull`;
}

function description({ p, hacks, hacksRead }) {
  const d = `${p.name}'s record: ${usd(p.tvl)} locked, ${hacksRead ? (hacks.length ? plural(hacks.length, 'hack') + ' recorded' : 'no hack recorded') : 'hacks not read'}, ${p.audit_links.length ? plural(p.audit_links.length, 'audit') + ' listed' : 'no audit listed'}. Every fact with its source; not advice.`;
  return d.length <= 160 ? d : `${d.slice(0, 157).replace(/\s+\S*$/, '')}…`;
}

const sig = s => `<span class="sig ${esc(s.level)}" title="Source: ${esc(s.source)}">${esc(s.text)}</span>`;
const safeLink = u => (typeof u === 'string' && /^https:\/\//.test(u) ? u : null);

/** The page's <head> options and body. */
function page(d, base, now = Date.now()) {
  const { p } = d;
  const url = `${base}/dapps/${p.slug}`;
  const names = require('../services/discover').CHAIN_NAMES;
  const chainText = p.chains.map(c => names[c] || c).join(', ') + (p.chain_count > p.chains.length ? ` and ${p.chain_count - p.chains.length} more` : '');
  const site = safeLink(p.url);
  const lines = summary(d, now);
  const facts = [
    ['Money locked (TVL)', usd(p.tvl), 'DefiLlama'],
    ['Change over 7 days', pct(p.change_7d) || 'not recorded', 'DefiLlama'],
    ['Fees in the last 24 hours', d.fees === undefined ? 'couldn\'t be read just now' : usd(d.fees), 'DefiLlama fees'],
    ['Category', p.category, 'DefiLlama'],
    ['Chains', chainText || 'not recorded', 'DefiLlama'],
    ['Listed since', p.listed_at ? longDay(new Date(p.listed_at * 1000).toISOString()) : 'not recorded', 'DefiLlama'],
    ['Audits listed', p.audit_links.length ? p.audit_links.map((a, i) => (safeLink(a) ? `<a href="${esc(a)}" rel="nofollow noopener" target="_blank">Audit ${i + 1}</a>` : '')).filter(Boolean).join(' · ') || plural(p.audit_links.length, 'link') : 'none listed', 'DefiLlama'],
    ['Rank by money locked', `#${p.rank} of the ${d.all.length} protocols with $10M or more`, 'DefiLlama'],
  ];
  const hackRows = d.hacks.map(h => `<tr><td class="mono small">${esc(h.date || 'not recorded')}</td><td class="num">${esc(usd(h.amount_usd))}</td><td class="small">${esc(h.technique || h.classification || 'not recorded')}</td><td class="num">${h.returned_usd ? esc(usd(h.returned_usd)) : '–'}</td><td class="small">${safeLink(h.source) ? `<a href="${esc(h.source)}" rel="nofollow noopener" target="_blank">Write-up</a>` : 'DefiLlama hacks'}</td></tr>`).join('');
  const qs = [
    [`Is ${p.name} safe?`, `No check can say a protocol is safe. What the record shows: ${lines.join(' ')} Audits and years without an incident lower some risks; none removes them, and this page can't see its admin keys or upgradeable contracts.`],
    [`Has ${p.name} been hacked?`, !d.hacksRead ? 'The hack record couldn\'t be read just now; try again shortly.' : d.hacks.length ? `Yes: DefiLlama records ${plural(d.hacks.length, 'hack')}: ${d.hacks.slice(0, 3).map(h => `${h.date || 'date not recorded'}, ${usd(h.amount_usd)} lost${h.technique ? ` (${h.technique})` : ''}`).join('; ')}.` : `DefiLlama's record shows no hack affecting ${p.name}. That is the public record, not a guarantee.`],
    [`How much is locked in ${p.name}?`, `${usd(p.tvl)}${pct(p.change_7d) ? `, ${pct(p.change_7d)} over the last 7 days` : ''}, according to DefiLlama.`],
    [`Has ${p.name} been audited?`, p.audit_links.length ? `DefiLlama lists ${plural(p.audit_links.length, 'audit link')} for it, linked above. An audit checks the code at one point in time; it doesn't cover later changes or how the protocol is run.` : 'DefiLlama lists no audit for it. That doesn\'t mean none exists: check the protocol\'s own documentation.'],
  ];
  const graph = [
    { '@type': 'WebPage', '@id': `${url}#page`, name: `${p.name}: its record`, url, description: description(d), about: { '@type': 'Thing', name: p.name, ...(site ? { url: site } : {}), sameAs: [`https://defillama.com/protocol/${p.slug}`] }, isPartOf: { '@type': 'WebSite', name: 'RektBull', url: `${base}/` }, dateModified: new Date(now).toISOString() },
    seo.breadcrumbs(base, [['Home', `${base}/`], ['Discover', `${base}/discover`], ['Protocol records', `${base}/dapps`], [p.name, url]]),
  ];
  const when = `${longDay(new Date(now).toISOString())}, ${new Date(now).toISOString().slice(11, 16)} UTC`;
  const body = `<section class="pagehead">
    <div class="wrap wide">
      <span class="eyebrow">${esc(p.category)} · protocol record</span>
      <h1>${esc(p.name)}: <em>its record</em></h1>
      <p>${esc(lines.join(' '))}</p>
      <div class="sigs">${d.signals.map(sig).join('')}</div>
      <nav class="jump" aria-label="On this page"><a href="#facts">The facts</a><a href="#hacks">Hacks</a><a href="#before">Before you use it</a><a href="#questions">Questions</a></nav>
    </div>
  </section>

  <main class="tool wide">
    <section class="card" id="facts">
      <h2>The facts, with their sources</h2>
      <div class="tablewrap"><table class="rank"><tbody>
        ${facts.map(([k, v, s]) => `<tr><th scope="row">${esc(k)}</th><td>${k === 'Audits listed' ? v : esc(v)}</td><td class="source">${esc(s)}</td></tr>`).join('\n        ')}
      </tbody></table></div>
      <p class="source">As of ${esc(when)}. ${site ? `Its site: <a href="${esc(site)}" rel="nofollow noopener" target="_blank">${esc(new URL(site).hostname)}</a> (check the address before you connect a wallet). ` : ''}<a href="https://defillama.com/protocol/${esc(p.slug)}" rel="noopener" target="_blank">Its page on DefiLlama</a>.${d.notChecked.length ? ` Not checked: ${esc(d.notChecked.map(n => `${n.check} (${n.reason})`).join('; '))}.` : ''}</p>
    </section>

    <section class="card" id="hacks">
      <h2>Hacks on record</h2>
      ${!d.hacksRead ? '<p class="msg bad">The hack record couldn\'t be read just now; try again shortly.</p>'
        : d.hacks.length ? `<div class="tablewrap"><table class="rank"><thead><tr><th>Date</th><th class="num">Lost</th><th>How</th><th class="num">Returned</th><th>Source</th></tr></thead><tbody>${hackRows}</tbody></table></div>`
          : `<p>DefiLlama's record shows no hack affecting ${esc(p.name)}. That's the public record, not a guarantee: most hacks hit protocols with none before.</p>`}
      <p class="source">Source: DefiLlama hacks. <a href="/research">Every recorded hack</a>, in the hack tracker.</p>
    </section>

    <section class="card" id="before">
      <h2>Before you use it</h2>
      <ul class="rules">
        <li><strong>Check what you've already approved.</strong> Paste your wallet into the <a href="/">free checkup</a>: it lists every contract that can spend your tokens, ${esc(p.name)}'s included.</li>
        ${p.token ? `<li><strong>Check its token</strong> before buying: <a href="${esc(p.token.check || `/safety?chain=${p.token.chain}&token=${p.token.address}`)}">sellability, taxes, owner powers and holders</a>.</li>` : ''}
        <li><strong>Check before you sign.</strong> The <a href="/extension">RektBull extension</a> shows what a transaction or signature would do, before your wallet does.</li>
        <li><strong>Use the real site.</strong> Fake copies of popular protocols are common: type the address yourself or use a bookmark.</li>
      </ul>
      ${d.campaigns.length ? `<p>${plural(d.campaigns.length, 'live reward campaign')} on ${esc(p.name)} right now, with what taking part involves: <a href="/opportunities">Opportunities</a>.</p>` : ''}
    </section>

    ${d.related.length ? `<section class="card">
      <h2>Other ${esc(p.category)} protocols</h2>
      <p>${d.related.map(r => `<a href="/dapps/${esc(r.slug)}">${esc(r.name)}</a> (${esc(usd(r.tvl))})`).join(' · ')} · <a href="/dapps">All protocol records</a></p>
    </section>` : ''}

    <section class="card" id="questions">
      <h2>Questions</h2>
      <div class="qs">
        ${qs.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('\n        ')}
      </div>
    </section>
  </main>`;
  return { head: { title: title(p.name), description: description(d), url, base, graph }, body };
}

/** /dapps: every record, by category, largest first. */
function index(all, base, now = Date.now()) {
  const url = `${base}/dapps`;
  const byCat = {};
  for (const p of all) (byCat[p.category] ||= []).push(p);
  const cats = Object.entries(byCat).sort((a, b) => b[1].reduce((t, p) => t + p.tvl, 0) - a[1].reduce((t, p) => t + p.tvl, 0));
  const body = `<section class="pagehead">
    <div class="wrap wide">
      <span class="eyebrow">Protocol records</span>
      <h1>Before you deposit, <em>read the record</em></h1>
      <p>Every DeFi protocol with $10M or more locked (${all.length.toLocaleString('en-US')} of them): what's locked, its recorded hacks, the audits listed and how long it's been around, each fact with its source. None of it says a protocol is safe; it shows what's known.</p>
    </div>
  </section>

  <main class="tool wide">
    ${cats.map(([cat, ps]) => `<section class="card">
      <h2>${esc(cat)} <span class="muted small">(${ps.length})</span></h2>
      <p class="dapp-index">${ps.map(p => `<a href="/dapps/${esc(p.slug)}">${esc(p.name)}</a> <span class="muted small">${esc(usd(p.tvl))}</span>`).join(' · ')}</p>
    </section>`).join('\n    ')}
    <p class="source">Source: DefiLlama, as of ${esc(longDay(new Date(now).toISOString()))}. Rankings, live: <a href="/discover">Discover</a>.</p>
  </main>`;
  return {
    head: {
      title: 'DeFi Protocol Records: Hacks, Audits, TVL | RektBull',
      description: `The record of ${all.length} DeFi protocols with $10M+ locked: recorded hacks, audits listed, money locked and age, each fact with its source.`,
      url, base,
      graph: [{ '@type': 'CollectionPage', '@id': `${url}#page`, name: 'DeFi protocol records', url, isPartOf: { '@type': 'WebSite', name: 'RektBull', url: `${base}/` } }, seo.breadcrumbs(base, [['Home', `${base}/`], ['Discover', `${base}/discover`], ['Protocol records', url]])],
    },
    body,
  };
}

module.exports = { eligible, gather, page, index, summary, title, description, MIN_TVL };
