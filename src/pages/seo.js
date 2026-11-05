/**
 * What search engines and link previews see: each page's title and
 * description (written for what people search, docs/SEO.md), its canonical
 * address, Open Graph and Twitter tags, structured data, robots.txt and the
 * sitemap. Put into each page's <head> at <!--#meta--> when the app starts.
 *
 * Titles stay within 60 characters and descriptions within 70 to 160, so
 * results show them whole (test/seo.test.js checks).
 */
const PAGES = {
  '/': ['Free Crypto Wallet Checkup: Approvals and Scams | RektBull', 'Paste a wallet: see risky token approvals, unclaimed rewards and open DAO votes on six chains in seconds. Free, every finding with its source.'],
  '/safety': ['Token Scam Checker and Approval Cleanup | RektBull', 'Check a token before you buy: can it be sold, what it taxes, what its owner can do. Find and revoke risky approvals. Every finding sourced.'],
  '/extension': ['Wallet Drainer Check Before You Sign | RektBull Extension', 'A browser extension that simulates what you\'re about to sign, checks every spender and the site, and warns you before your wallet does.'],
  '/discover': ['DeFi Rankings With Hack and Audit Records | RektBull', 'Dapps ranked by money locked, fees and weekly change, each with its hack and audit record, plus trending and new tokens. Free, with sources.'],
  '/agents': ['x402 APIs and AI Agent Protocols, Ranked | RektBull', 'Paid APIs AI agents call with x402, ranked by real payers, with signals for fake usage and flagged payment addresses. Free, with sources.'],
  '/markets': ['DeFi Today: TVL, Stablecoin Pegs and RWA | RektBull', 'DeFi in numbers: money locked, DEX volume, fees, stablecoin supply and how close each is to its peg, real-world assets and largest tokens.'],
  '/opportunities': ['Crypto Rewards and Airdrops to Claim | RektBull', 'Live reward campaigns on six chains with each protocol\'s hack and audit record, plus what your own wallet can claim, earn and vote on.'],
  '/portfolio': ['Crypto Portfolio Tracker on Six Chains | RektBull', 'See what a wallet holds on six chains and what it\'s worth, with the facts on each token: scam airdrops, off-peg stablecoins, risky approvals.'],
  '/research': ['Crypto Hack Tracker and Weekly Digest | RektBull', 'Every recorded crypto hack: what was lost, how, and what came back. Plus a weekly digest written only from sourced facts, free by email.'],
  '/find': ['Find Unclaimed Airdrops and Better Yield | RektBull', 'Find rewards and airdrops your wallet can claim, verified onchain, and where your stablecoins could earn more. Your wallet signs every move.'],
  '/governance': ['DAO Votes Decoded: Snapshot and Onchain | RektBull', 'See the DAO votes open for your wallet, with each proposal\'s actions decoded and flagged, and vote from your own wallet. Never a recommendation.'],
  '/trade': ['Trade Crypto With Limits You Set | RektBull', 'Every token checked before you buy, within limits you set. Your wallet signs each trade, or gives a limited permission you can revoke any time.'],
  '/developers': ['Crypto Safety API and MCP Server for Agents | RektBull', 'Give your app or AI agent RektBull\'s checks: a remote MCP server, a REST API with every fact sourced, and pay-per-call with x402 in USDC.'],
  '/privacy': ['Privacy Policy | RektBull', 'What RektBull collects, why, how long it keeps it, who else sees it, and how to download or delete your data. RektBull never holds your keys.'],
};

// Pages that are served but not listed or indexed.
const UNLISTED = {
  '/404': ['Page not found | RektBull', 'There\'s no page at this address. Check a wallet, a token or a contract from the home page, or pick a desk from the menu.'],
};

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Structured data where it says something true and useful: who RektBull is, on the home page. */
function jsonLd(route, base) {
  if (route !== '/') return '';
  const data = [
    { '@context': 'https://schema.org', '@type': 'Organization', name: 'RektBull', url: `${base}/`, logo: `${base}/icon-512.png`, description: 'Crypto safety checks for people and their AI agents, every fact with its source.' },
    { '@context': 'https://schema.org', '@type': 'WebSite', name: 'RektBull', url: `${base}/` },
  ];
  // JSON in a script tag: "<" escaped so no value can close the tag.
  return `\n  <script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;
}

/** The <head> tags for one page. */
function head(route, base) {
  if (UNLISTED[route]) {
    const [title, description] = UNLISTED[route];
    return [`<title>${esc(title)}</title>`, `<meta name="description" content="${esc(description)}">`, '<meta name="robots" content="noindex">', '<link rel="icon" href="/favicon.svg" type="image/svg+xml">'].join('\n  ');
  }
  const [title, description] = PAGES[route];
  const url = `${base}${route}`;
  return [
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(description)}">`,
    `<link rel="canonical" href="${esc(url)}">`,
    '<link rel="icon" href="/favicon.svg" type="image/svg+xml">',
    '<link rel="icon" href="/favicon-48.png" sizes="48x48" type="image/png">',
    '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
    '<meta name="theme-color" content="#2346d6">',
    '<meta property="og:type" content="website">',
    '<meta property="og:site_name" content="RektBull">',
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(description)}">`,
    `<meta property="og:url" content="${esc(url)}">`,
    `<meta property="og:image" content="${esc(base)}/og.png">`,
    '<meta property="og:image:width" content="1200">',
    '<meta property="og:image:height" content="630">',
    '<meta property="og:image:alt" content="RektBull: Don\'t get rekt. Crypto safety checks, every fact with its source.">',
    '<meta name="twitter:card" content="summary_large_image">',
  ].join('\n  ') + jsonLd(route, base);
}

/** Everything may be crawled: the pages fetch their data from /v1 as they render, so it stays open. */
const robots = base => `User-agent: *\nAllow: /\n\nSitemap: ${base}/sitemap.xml\n`;

function sitemap(base) {
  const urls = Object.keys(PAGES).map(route => `  <url><loc>${esc(base + route)}</loc></url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}

module.exports = { PAGES, UNLISTED, head, robots, sitemap };
