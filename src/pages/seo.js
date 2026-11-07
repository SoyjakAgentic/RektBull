/**
 * What search engines, AI assistants and link previews see (docs/SEO.md):
 *
 * - each page's title and description, written for what people search
 *   (titles within 60 characters, descriptions within 70 to 160);
 * - its canonical address, Open Graph and Twitter tags, and icons;
 * - structured data: who RektBull is (home and About), each page's place in
 *   the site (breadcrumbs), and its questions and answers (FAQPage), built
 *   from the questions shown on the page itself, so the two always match;
 * - each page's "Questions" section (visible, in plain words: AI answers quote
 *   pages that answer questions directly);
 * - robots.txt (every crawler welcome, AI search and assistants included),
 *   the sitemap, and llms.txt (a plain-text map of the site for AI tools).
 *
 * Put into each page at <!--#meta--> and before </main> when the app starts.
 */
const PAGES = {
  '/': ['Crypto Safety and AI Agents: Free Wallet Checkup | RektBull', 'Paste a wallet for a free checkup, then let AI agents watch it: risky approvals, scam tokens, unclaimed rewards and DAO votes, every fact with its source.'],
  '/safety': ['Token Scam Checker and Approval Cleanup | RektBull', 'Check a token before you buy: can it be sold, what it taxes, what its owner can do. Find and revoke risky approvals. Every finding sourced.'],
  '/extension': ['Wallet Drainer Check Before You Sign | RektBull Extension', 'A browser extension that simulates what you\'re about to sign, checks every spender and the site, and warns you before your wallet does.'],
  '/discover': ['DeFi Rankings With Hack and Audit Records | RektBull', 'Dapps ranked by money locked, fees and weekly change, each with its hack and audit record, plus trending and new tokens. Free, with sources.'],
  '/agents': ['AI Agents for Crypto Safety, and x402 APIs | RektBull', 'Agents that watch your wallets, tokens, claims and DAO votes and alert you with sources; plus the x402 APIs agents pay for, ranked by real payers.'],
  '/markets': ['DeFi Today: TVL, Stablecoin Pegs and RWA | RektBull', 'DeFi in numbers: money locked, DEX volume, fees, stablecoin supply and how close each is to its peg, real-world assets and largest tokens.'],
  '/opportunities': ['Crypto Rewards and Airdrops to Claim | RektBull', 'Live reward campaigns on six chains with each protocol\'s hack and audit record, plus what your own wallet can claim, earn and vote on.'],
  '/portfolio': ['Crypto Portfolio Tracker on Six Chains | RektBull', 'See what a wallet holds on six chains and what it\'s worth, with the facts on each token: scam airdrops, off-peg stablecoins, risky approvals.'],
  '/research': ['Crypto Hack Tracker and Weekly Digest | RektBull', 'Every recorded crypto hack: what was lost, how, and what came back. Plus a weekly digest written only from sourced facts, free by email.'],
  '/find': ['Find Unclaimed Airdrops and Better Yield | RektBull', 'Find rewards and airdrops your wallet can claim, verified onchain, and where your stablecoins could earn more. Your wallet signs every move.'],
  '/governance': ['DAO Votes Decoded: Snapshot and Onchain | RektBull', 'See the DAO votes open for your wallet, with each proposal\'s actions decoded and flagged, and vote from your own wallet. Never a recommendation.'],
  '/trade': ['Trade Crypto With Limits You Set | RektBull', 'Every token checked before you buy, within limits you set. Your wallet signs each trade, or gives a limited permission you can revoke any time.'],
  '/developers': ['Crypto Safety API and MCP Server for Agents | RektBull', 'Give your app or AI agent RektBull\'s checks: a remote MCP server, a REST API with every fact sourced, and pay-per-call with x402 in USDC.'],
  '/about': ['About RektBull: How the Checks Work and Our Sources', 'Who runs RektBull, how each check works, every data source it uses, how the weekly digest is written and reviewed, and what RektBull never does.'],
  '/privacy': ['Privacy Policy | RektBull', 'What RektBull collects, why, how long it keeps it, who else sees it, and how to download or delete your data. RektBull never holds your keys.'],
};

/** Short names for breadcrumbs and llms.txt. */
const NAMES = {
  '/': 'Home', '/safety': 'Safety', '/extension': 'Extension', '/discover': 'Discover', '/agents': 'AI agents', '/markets': 'Markets',
  '/opportunities': 'Opportunities', '/portfolio': 'Portfolio', '/research': 'Research', '/find': 'Find money', '/governance': 'Governance',
  '/trade': 'Trade', '/developers': 'Developers', '/about': 'About', '/privacy': 'Privacy',
};
/** Pages that sit under another in the menu, for breadcrumbs. */
const PARENT = { '/find': '/opportunities', '/governance': '/opportunities' };

// Pages that are served but not listed or indexed.
const UNLISTED = {
  '/404': ['Page not found | RektBull', 'There\'s no page at this address. Check a wallet, a token or a contract from the home page, or pick a desk from the menu.'],
};

/**
 * Each page's questions, answered plainly (HTML allowed in answers: links to
 * other pages). The home page keeps its own FAQ section; its structured data
 * is read from it the same way. Facts here must match the product: prices
 * from the catalog, limits from src/payments/freeLimits.js.
 */
const FAQ = {
  '/safety': [
    ['What does the token check look at?', 'Whether the token can be sold after you buy it, what it taxes on buys and sells, what its owner can still change (minting, pausing, blocking wallets, changing taxes), how concentrated its holders are, and, in the full report, its liquidity, volume and age. Each finding names its source, such as GoPlus, the block explorer or the chain itself.'],
    ['How much does it cost?', 'The quick check is 1 free point or $0.25; the full report, written in plain English, is $3. Safety Pro ($9 for 30 days, $79 for a year) includes unlimited quick checks within fair use and an AI allowance every 30 days for full reports and proposal summaries (about 20 reports). Bots and AI agents can pay per call with x402, in USDC on Base.'],
    ['What is a token approval, and why revoke it?', 'An approval lets a contract spend a token from your wallet, often with no limit, until you take it back. Drainers use old or unlimited approvals to empty wallets long after you\'ve forgotten them. The free preview shows how many you have open on six chains and how much they put at risk; the cleanup ($1 or 5 points) rates each one with its sources and prepares the revokes for your wallet to sign.'],
    ['Does a clean result mean a token is safe?', 'No. A check finds known patterns; it can\'t prove that a token or its team is honest, or that nothing will change later. Treat a clean result as "nothing known was found", never as a guarantee.'],
  ],
  '/extension': [
    ['What does the extension check?', 'Before your wallet shows a transaction or a signature, it simulates what would leave your wallet, rates every spender and recipient, decodes permits, NFT listings and sign-in requests, and checks the site against phishing lists. A risky request stops with a warning that says why and where each fact came from.'],
    ['What does it see and keep?', 'It reads a request only when a site asks your wallet to sign something. RektBull keeps the kind of request and the chain, never what you were signing or which site asked. See the <a href="/privacy">privacy page</a>.'],
    ['Does it cost anything?', 'Each check is 1 free point or $0.10, and checks are included in Safety Pro. A safe-looking request goes straight to your wallet; RektBull never signs anything for you.'],
  ],
  '/discover': [
    ['Where do the rankings come from?', 'Money locked (TVL), weekly change and fees come from DefiLlama; recorded hacks come from DefiLlama\'s hack record; trending and new tokens come from GeckoTerminal. Each row names its source.'],
    ['Does "no hack recorded" mean a dapp is safe?', 'No. It means no hack is in the public record. Audits listed and years without an incident lower some risks; none removes them. A ranking shows how much is in a dapp, not whether it is safe.'],
    ['Can I check a token from the lists?', 'Yes. Free flags show for any token, and the <a href="/safety">token check</a> goes further: sellability, taxes, owner powers and holders.'],
  ],
  '/agents': [
    ['What do RektBull\'s AI agents do?', 'Each one runs a check a RektBull desk already has, on a schedule you pick, and sends what it finds by Telegram, email or browser notification, with the source of every fact. The Wallet Checkup and Claim Assistant are free; Wallet Guardian, Token Watch, DAO Votes and Yield Watch are part of Safety Pro.'],
    ['Can an agent move my money?', 'No. The agents check and tell you; anything that moves money is prepared for your own wallet to sign. The one exception is the Trading Agent, which trades only inside limits your wallet signed onchain (a session key you can revoke), and can only send the result back to your wallet.'],
    ['What is x402?', 'An open way for software, including AI agents, to pay for an API per request in stablecoins: the API answers "402 Payment Required" with its price, the client pays (usually in USDC on Base) and retries. No account or card is needed.'],
    ['How are the x402 services ranked?', 'By how many different wallets paid each one in the last 30 days, from Coinbase\'s x402 Bazaar. Services with fewer than 5 payers and testnet-only endpoints are left out; most of the 100,000+ listed endpoints are never called.'],
    ['What do the warnings mean?', '"Usage that looks generated" means about one call per payer, which is how fake traffic usually looks. Others flag few users, no calls in 14 days, plain http, or a payment address that GoPlus flags. RektBull hasn\'t tested these services: check before your agent pays one.'],
    ['Can my AI agent use RektBull itself?', 'Yes: add the <a href="/developers#mcp">MCP server</a> for free checks, or call the paid runs over HTTP with x402.'],
  ],
  '/markets': [
    ['Where do these numbers come from?', 'Money locked, DEX volume and fees come from DefiLlama; stablecoin supply and prices from DefiLlama\'s stablecoin data; the largest tokens from CoinGecko. Each figure names its source and when it was read.'],
    ['When is a stablecoin flagged?', 'When its price is more than 0.5% from its peg, or its supply fell 10% or more in a week (holders redeeming or leaving). Holding the peg today says nothing about the reserves behind it.'],
    ['Is any of this advice?', 'No. These are facts with their sources, for context. RektBull never tells you what to buy or sell.'],
  ],
  '/opportunities': [
    ['Where do the reward campaigns come from?', 'Merkl, for live campaigns with $50,000 or more in them on Ethereum, Base, Arbitrum, Optimism, Polygon and BNB Chain. Each one shows the protocol\'s hack and audit record from DefiLlama and what taking part involves.'],
    ['How do I see what my own wallet can claim?', 'Paste or connect a wallet: RektBull checks rewards and airdrops it can claim, each verified onchain, plus where its stablecoins could earn more and which DAO votes are open for it.'],
    ['Does RektBull recommend campaigns?', 'No. A higher rate often means more risk. Campaigns are listed as facts, with the risks the facts show.'],
  ],
  '/portfolio': [
    ['Which chains does the portfolio read?', 'Ethereum, Base, Arbitrum, Optimism, Polygon and BNB Chain.'],
    ['Why are some tokens left out of the total?', 'Tokens with no reliable price stay out of the total, and tokens that look like scam airdrops are marked: they are often sent to lure you to a phishing site. Never interact with a token you didn\'t expect.'],
    ['Is it free?', 'Yes: 5 reads a day without signing in, 30 when you sign in with your wallet. Signing in is free and moves nothing.'],
  ],
  '/research': [
    ['Where does the hack tracker get its data?', 'From DefiLlama\'s public record of hacks and exploits: the date, what was lost, how it was done, what was returned, and the chains, with a link to the source write-up where there is one. A hack with no recorded amount is shown as "not recorded", never as zero.'],
    ['How is the weekly digest written?', 'Every Monday RektBull gathers the week\'s facts from its own data, each with its source. An AI writer drafts the digest from those facts only, a fact-check removes any sentence the facts don\'t support or that predicts or recommends, and a person reviews and edits it before it\'s published. See <a href="/about#digest">how it\'s made</a>.'],
    ['How do I get it by email?', 'Subscribe on this page: one email to confirm, then the digest each week it\'s published. Every email has a one-click unsubscribe that deletes your address.'],
  ],
  '/find': [
    ['How are unclaimed rewards found?', 'RektBull checks Merkl rewards on six chains and airdrops it has verified, then confirms each claim onchain before showing it. Claims are prepared for your wallet to sign; the fee is 5% of what\'s claimed (3% with Safety Pro), and claiming on the project\'s own site is always free.'],
    ['Where could my stablecoins earn more?', 'RektBull reads supply rates directly from Aave, Compound and Spark on Ethereum, Base and Arbitrum. A move is proposed only when it passes the rules (enough gain after costs, a venue not under strain), and costs 0.1% of what\'s moved. Rates change with demand.'],
    ['Will a site that asks me to "check eligibility" with my wallet pay out?', 'Be careful: connecting a wallet to an unknown "eligibility checker" is a common way to get drained. RektBull only needs your address to check, never a signature.'],
  ],
  '/governance': [
    ['Which DAOs does it cover?', 'Snapshot spaces you follow, and onchain governors: Uniswap, Compound, ENS, Gitcoin, Hop and Arbitrum, plus any OpenZeppelin or Compound-style governor you add.'],
    ['What does the proposal summary do?', 'It explains a proposal in plain English from its own text: what would change, what money and powers it moves, what each choice does, and what the text doesn\'t say. It costs 1 point or $0.10 and never recommends a vote.'],
    ['Who sends my vote?', 'Your wallet. RektBull prepares the vote; Snapshot votes are signed messages, and onchain votes are transactions your wallet sends.'],
  ],
  '/trade': [
    ['Can RektBull move my money?', 'No. Your wallet signs each trade, or gives a limited permission written onchain: a most-per-trade and most-per-day, for up to 30 days, that only lets trades go back into your own wallet. RektBull can never withdraw, and you can revoke the permission at any time.'],
    ['What is checked before a trade?', 'The token you\'re buying (sellability, taxes, owner powers, holders) and the trade against your limits, such as the most slippage you accept.'],
    ['What does a trade cost?', 'A fee that can never exceed 1% of the trade, a cap enforced by the Trade Router contract itself, plus the network\'s own fee.'],
  ],
  '/developers': [
    ['How do I add RektBull to Claude or another MCP client?', 'Add the MCP server address shown on this page (it ends in /mcp). In Claude Code: <code>claude mcp add --transport http rektbull https://rektbull.com/mcp</code>. No key is needed for the free tools.'],
    ['What can an agent do with it?', 'Read-only checks: what an address is, a wallet checkup, open approvals, a portfolio, unclaimed rewards, DAO votes, token flags, dapp rankings, market and stablecoin data, rates, campaigns, hacks, the weekly digest, x402 services and AI-agent protocols. No tool signs, sends or prepares a transaction.'],
    ['How do paid calls work without an account?', 'With x402: call a paid endpoint, receive a 402 answer with the price, pay in USDC on Base with any x402 client and retry. You\'re charged only when the run succeeds.'],
  ],
};

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const text = html => String(html).replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
// JSON in a script tag: "<" escaped so no value can close the tag.
const ldTag = data => `\n  <script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;

const organization = base => ({ '@type': 'Organization', '@id': `${base}/#org`, name: 'RektBull', url: `${base}/`, logo: `${base}/icon-512.png`, description: 'Crypto safety checks and AI agents that watch your wallet, every fact with its source. Checks other AI agents can call too.', ...(SAME_AS().length ? { sameAs: SAME_AS() } : {}) });
// Official profiles (e.g. the X account), from SAME_AS: they tie the brand together for search engines and AI answers.
const SAME_AS = () => (process.env.SAME_AS || '').split(',').map(s => s.trim()).filter(s => /^https:\/\//.test(s));

function breadcrumbs(base, trail) {
  return { '@type': 'BreadcrumbList', itemListElement: trail.map(([name, url], i) => ({ '@type': 'ListItem', position: i + 1, name, item: url })) };
}

/** The <head> tags for any page: the listed pages and the digest's own pages share it. */
function headFor({ title, description, url, base, type = 'website', graph = [], noindex = false }) {
  const tags = [
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(description)}">`,
    noindex ? '<meta name="robots" content="noindex">' : `<link rel="canonical" href="${esc(url)}">`,
    // The heading and body fonts, fetched early so the first view doesn't shift when they arrive.
    '<link rel="preload" href="/fonts/bricolage.woff2" as="font" type="font/woff2" crossorigin>',
    '<link rel="preload" href="/fonts/plex-sans-400.woff2" as="font" type="font/woff2" crossorigin>',
    '<link rel="icon" href="/favicon.svg" type="image/svg+xml">',
    '<link rel="icon" href="/favicon-48.png" sizes="48x48" type="image/png">',
    '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
    '<meta name="theme-color" content="#2346d6">',
  ];
  if (!noindex) {
    tags.push(
      `<meta property="og:type" content="${type}">`,
      '<meta property="og:site_name" content="RektBull">',
      `<meta property="og:title" content="${esc(title)}">`,
      `<meta property="og:description" content="${esc(description)}">`,
      `<meta property="og:url" content="${esc(url)}">`,
      `<meta property="og:image" content="${esc(base)}/og.png">`,
      '<meta property="og:image:width" content="1200">',
      '<meta property="og:image:height" content="630">',
      '<meta property="og:image:alt" content="RektBull: Don\'t get rekt. Crypto safety checks, every fact with its source.">',
      '<meta name="twitter:card" content="summary_large_image">',
    );
  }
  return tags.join('\n  ') + (graph.length ? ldTag({ '@context': 'https://schema.org', '@graph': graph }) : '');
}

/** The structured data for a listed page; its FAQ is added from the finished page by withFaqData(). */
function graphFor(route, base) {
  const url = `${base}${route}`;
  const [title, description] = PAGES[route];
  if (route === '/') return [organization(base), { '@type': 'WebSite', '@id': `${base}/#site`, name: 'RektBull', url: `${base}/`, publisher: { '@id': `${base}/#org` } }];
  const trail = [['Home', `${base}/`], ...(PARENT[route] ? [[NAMES[PARENT[route]], `${base}${PARENT[route]}`]] : []), [NAMES[route], url]];
  return [
    { '@type': route === '/about' ? 'AboutPage' : 'WebPage', '@id': `${url}#page`, name: title, description, url, isPartOf: { '@type': 'WebSite', name: 'RektBull', url: `${base}/` }, publisher: route === '/about' ? organization(base) : { '@type': 'Organization', name: 'RektBull', url: `${base}/` } },
    breadcrumbs(base, trail),
  ];
}

/** The <head> tags for one listed page (or the unlisted 404). */
function head(route, base) {
  if (UNLISTED[route]) {
    const [title, description] = UNLISTED[route];
    return headFor({ title, description, url: null, base, noindex: true });
  }
  const [title, description] = PAGES[route];
  return headFor({ title, description, url: `${base}${route}`, base, graph: graphFor(route, base) });
}

/** A page's "Questions" section, shown before the end of <main>. */
function faqSection(route) {
  const qs = FAQ[route];
  if (!qs) return '';
  return `<section class="card" id="questions">
      <h2>Questions</h2>
      <div class="qs">
        ${qs.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${a}</p></details>`).join('\n        ')}
      </div>
    </section>
  `;
}

/** Adds FAQPage structured data built from the questions the finished page shows (in .qs details). */
function withFaqData(html) {
  const block = html.match(/<div class="qs">([\s\S]*?)<\/div>/);
  if (!block) return html;
  const pairs = [...block[1].matchAll(/<details[^>]*><summary>([\s\S]*?)<\/summary><p>([\s\S]*?)<\/p><\/details>/g)].map(m => [text(m[1]), text(m[2])]);
  if (!pairs.length) return html;
  const faq = { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: pairs.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) };
  return html.replace('</head>', `${ldTag(faq).trimStart()}\n</head>`);
}

/** Search engines and AI crawlers are all welcome: the pages fetch their data from /v1 as they render, so nothing is blocked. */
const AI_CRAWLERS = ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-SearchBot', 'Claude-User', 'PerplexityBot', 'Perplexity-User', 'Google-Extended', 'Applebot-Extended', 'Bingbot'];
const robots = base => [
  '# Every crawler is welcome: search engines, and AI search and assistants (Bing also feeds several). Nothing here is private:',
  '# accounts, keys and wallet data are never in a page.',
  'User-agent: *',
  ...AI_CRAWLERS.map(a => `User-agent: ${a}`),
  'Allow: /',
  '',
  `Sitemap: ${base}/sitemap.xml`,
  '',
].join('\n');

/** The listed pages, plus any extra entries (the published digests) with their dates. */
function sitemap(base, extra = []) {
  const urls = [
    ...Object.keys(PAGES).map(route => `  <url><loc>${esc(base + route)}</loc></url>`),
    ...extra.map(e => `  <url><loc>${esc(e.loc)}</loc>${e.lastmod ? `<lastmod>${esc(e.lastmod)}</lastmod>` : ''}</url>`),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}

/** llms.txt: a plain-text map of the site for AI assistants and agents (llmstxt.org). */
function llms(base, digests = []) {
  const line = route => `- [${NAMES[route]}](${base}${route}): ${PAGES[route][1]}`;
  return [
    '# RektBull',
    '',
    '> Crypto safety and AI agents: free checks of what a wallet, token, approval, dapp or x402 service is and what is risky about it, and AI agents that watch your wallets, tokens, claims and DAO votes and alert you, with the source of every fact. The same checks are open to other people\'s AI agents (MCP, x402). RektBull never holds funds or keys; it prepares transactions for the user\'s own wallet to sign. Nothing here is financial advice, and a clean check is never proof that something is safe.',
    '',
    'Key facts:',
    '- Free wallet checkup on Ethereum, Base, Arbitrum, Optimism, Polygon and BNB Chain: risky token approvals, unclaimed rewards, idle stablecoins and open DAO votes.',
    '- Paid runs (token quick check $0.25, full token report $3, approval cleanup $1, pre-sign check $0.10, proposal summary $0.10) take x402 (USDC on Base, no account), points, credits or Safety Pro ($9 for 30 days). Charged only when the run succeeds.',
    '- AI agents (sign in with a wallet, switch one on, alerts by Telegram, email or browser): Wallet Checkup and Claim Assistant are free; Wallet Guardian, Token Watch, DAO Votes and Yield Watch are part of Safety Pro. They never sign or move money, and AI never decides a fact.',
    '- Data sources include GoPlus, Etherscan and Blockscout, DefiLlama, Merkl, Snapshot, GeckoTerminal, CoinGecko, Coinbase\'s x402 Bazaar and the chains themselves.',
    '',
    '## Checks and tools',
    ...['/', '/safety', '/extension', '/portfolio', '/find', '/governance', '/trade'].map(line),
    '',
    '## Data and research',
    ...['/research', '/discover', '/markets', '/opportunities', '/agents'].map(line),
    '',
    '## AI agents',
    ...require('./agentPage').list().map(a => `- [${a.name}](${base}/agents/${a.slug}): ${require('./agentPage').PAGES[a.id].description}`),
    '',
    '## Records',
    `- [Protocol records](${base}/dapps): every DeFi protocol with $10M or more locked: its recorded hacks, audits listed, money locked and age, each fact with its source.`,
    ...(digests.length ? ['', '## Weekly digests', ...digests.slice(0, 12).map(d => `- [The week of ${d.week_start}](${base}/research/${d.week_start})`)] : []),
    '',
    '## For AI agents and developers',
    `- [MCP server](${base}/mcp): remote MCP (Streamable HTTP), 18 read-only tools, free within daily allowances.`,
    `- [Developers](${base}/developers): setup, x402 prices and the API reference.`,
    `- [OpenAPI](${base}/v1/openapi.json): the REST API, machine-readable.`,
    '',
    '## About',
    line('/about'),
    line('/privacy'),
    '',
  ].join('\n');
}

module.exports = { PAGES, NAMES, UNLISTED, FAQ, head, headFor, graphFor, breadcrumbs, organization, faqSection, withFaqData, robots, sitemap, llms, esc, AI_CRAWLERS };
