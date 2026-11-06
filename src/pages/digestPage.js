/**
 * Each published weekly digest at its own address, /research/<Monday>,
 * rendered on the server: a dated article with its byline, the text the owner
 * published, the facts it was written from with their sources, and any
 * sponsored posts, labelled. Search engines and AI answers can read and cite
 * it without running a script; it's in the sitemap with its publish date.
 */
const seo = require('./seo');

const esc = seo.esc;
const longDay = iso => new Date(`${String(iso).slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const shortDay = iso => new Date(`${String(iso).slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** The digest's Markdown as escaped HTML: ## sections as h2, lists, bold. Nothing in it is read as markup. */
function markdown(md) {
  const out = [];
  let list = false;
  const inline = s => esc(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  for (const raw of String(md || '').split('\n')) {
    const line = raw.trim();
    const item = line.match(/^[-*]\s+(.*)/);
    if (!item && list) { out.push('</ul>'); list = false; }
    if (!line) continue;
    const h = line.match(/^(#{1,4})\s+(.*)/);
    const level = h ? Math.max(2, h[1].length) : 0; // the page's h1 is its title, so sections start at h2
    if (h) out.push(`<h${level}>${inline(h[2])}</h${level}>`);
    else if (item) { if (!list) { out.push('<ul>'); list = true; } out.push(`<li>${inline(item[1])}</li>`); } else out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push('</ul>');
  return out.join('\n');
}

/** A short description from the digest's first sentences, without Markdown or source brackets. */
function summary(d) {
  const plain = String(d.text || '').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
    .map(l => l.replace(/^[-*]\s+/, '')).join(' ')
    .replace(/\*\*/g, '').replace(/\s*\[[^\]]+\]/g, '').replace(/\s+/g, ' ').trim();
  const fallback = `Hacks, stablecoins, money flows and opportunities for the week of ${shortDay(d.week_start)}, each fact with its source. Not advice.`;
  if (plain.length < 70) return fallback;
  if (plain.length <= 155) return plain;
  const cut = plain.slice(0, 154);
  return `${cut.slice(0, cut.lastIndexOf(' '))}…`;
}

const sponsoredBox = s => `<aside class="sponsored" aria-label="Sponsored">
        <p class="sp-label">${esc(s.label)} · ${esc(s.sponsor)}</p>
        <p class="sp-head"><a href="${esc(s.url)}" rel="sponsored noopener" target="_blank">${esc(s.headline)}</a></p>
        <p>${esc(s.body)}</p>
        <p class="sp-foot"><a href="${esc(s.url)}" rel="sponsored noopener" target="_blank">${esc(s.site)}</a> · ${esc(s.disclosure)}</p>
      </aside>`;

function factList(d) {
  const sections = [...new Set(d.facts.map(f => f.section))];
  return sections.map(s => `<div class="fact-group"><h3>${esc(s)}</h3><ul>${d.facts.filter(f => f.section === s).map(f => `<li>${esc(f.text)} <span class="source">[${esc(f.source)}]</span></li>`).join('')}</ul></div>`).join('\n')
    + (d.not_checked.length ? `\n<p class="small muted">Not checked that week: ${esc(d.not_checked.map(n => `${n.check} (${n.reason})`).join('; '))}</p>` : '');
}

/**
 * The page's <head> options and its body, for a published digest `d` and the
 * list of published weeks (newest first), for the links to the weeks around it.
 */
function page(d, list, base) {
  const url = `${base}/research/${d.week_start}`;
  const title = `Crypto Weekly Digest: Week of ${shortDay(d.week_start)} | RektBull`;
  const description = summary(d);
  const published = d.published_at ? new Date(d.published_at).toISOString() : `${d.week_end}T06:00:00.000Z`;
  const sources = [...new Set(d.facts.map(f => f.source))];
  const graph = [
    {
      '@type': 'Article', '@id': `${url}#article`, headline: `RektBull Research: the week of ${longDay(d.week_start)}`, description,
      datePublished: published, dateModified: published, url, mainEntityOfPage: url, image: `${base}/og.png`, inLanguage: 'en',
      isAccessibleForFree: true, author: { '@type': 'Organization', name: 'RektBull Research', url: `${base}/about#digest` }, publisher: seo.organization(base),
      citation: sources,
    },
    seo.breadcrumbs(base, [['Home', `${base}/`], ['Research', `${base}/research`], [`The week of ${shortDay(d.week_start)}`, url]]),
  ];
  const i = list.findIndex(w => w.week_start === d.week_start);
  const newer = i > 0 ? list[i - 1] : null;
  const older = i >= 0 && i < list.length - 1 ? list[i + 1] : null;
  const top = d.sponsored.filter(s => s.placement === 'top').map(sponsoredBox).join('');
  const bottom = d.sponsored.filter(s => s.placement === 'bottom').map(sponsoredBox).join('');
  const body = `<section class="pagehead">
    <div class="wrap wide">
      <span class="eyebrow">Weekly digest</span>
      <h1>The week of <em>${esc(longDay(d.week_start))}</em></h1>
      <p class="byline">${esc(d.byline)} · published <time datetime="${esc(published)}">${esc(longDay(published))}</time> · covers ${esc(longDay(d.week_start))} to ${esc(longDay(d.week_end))} (UTC)</p>
      <nav class="jump" aria-label="On this page"><a href="#digest">The digest</a><a href="#facts">The facts and sources</a><a href="/research#newsletter">Get it by email</a></nav>
    </div>
  </section>

  <main class="tool wide">
    <article class="card" id="digest">
      ${top}
      ${d.text ? `<div class="report">${markdown(d.text)}</div>` : '<p>This week was published as its facts alone, below.</p>'}
      ${bottom}
      <p class="source">Written only from the facts below, each with its source: an AI writer drafts from them, a fact-check removes what they don't support, and a person reviews it before it's published (<a href="/about#digest">how it's made</a>). Not advice.</p>
    </article>

    <section class="card" id="facts">
      <h2>The facts it was written from</h2>
      ${factList(d)}
    </section>

    <section class="card">
      <h2>More weeks</h2>
      <p>${older ? `<a href="/research/${esc(older.week_start)}" rel="prev">← The week of ${esc(shortDay(older.week_start))}</a>` : ''}${older && newer ? ' · ' : ''}${newer ? `<a href="/research/${esc(newer.week_start)}" rel="next">The week of ${esc(shortDay(newer.week_start))} →</a>` : ''}${older || newer ? ' · ' : ''}<a href="/research">The hack tracker and every week</a> · <a href="/research#newsletter">Get the digest by email, free</a></p>
    </section>
  </main>`;
  return { head: { title, description, url, base, type: 'article', graph }, body };
}

module.exports = { page, markdown, summary };
