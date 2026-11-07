/**
 * One page per AI agent, at /agents/<slug>, rendered on the server: what it
 * checks and where each fact comes from, its schedule, alerts and price, what
 * it never does, and questions people ask. Each page is written for a search
 * people actually make ("wallet monitoring bot", "airdrop checker", "token
 * rug alert"); the agent's own facts (what it does, schedule, price) come from
 * src/services/myAgents.js so the two never disagree.
 *
 * The rules (POSITIONING.md): never "safe", never a promise of returns, and
 * every check names its source.
 */
const seo = require('./seo');
const { AGENTS, catalog } = require('../services/myAgents');

const esc = seo.esc;
const slugOf = id => id.replace(/_/g, '-');

const PAGES = {
  wallet_checkup: {
    title: 'Free Crypto Wallet Checkup Agent, Every Week | RektBull',
    description: 'An AI agent that checks your wallet every week for free: risky approvals, unclaimed rewards, idle stablecoins and DAO votes, each with its source.',
    lead: 'your wallet, checked every week',
    checks: [
      ['Approvals worth revoking, on six chains, and how much each could take', 'Chain explorers (GoPlus when they can\'t give the whole history); each approval\'s current state read onchain'],
      ['Airdrops and rewards you haven\'t claimed', 'Merkl, and the airdrops RektBull adds; each verified onchain'],
      ['Stablecoins and ETH sitting idle, and what lending venues pay', 'Aave v3, Compound v3 and Spark contracts, read onchain'],
      ['DAO votes your wallet can cast', 'Snapshot, and onchain governors'],
    ],
    faq: [
      ['Is the wallet checkup agent free?', 'Yes. Sign in with your wallet (free, and it moves nothing), switch the agent on, and it runs every week, or every day if you prefer. The result goes to Telegram, email or your browser.'],
      ['Does it need my seed phrase or private key?', 'No, never. It reads public onchain data for your wallet address. Anything that needs a transaction, like revoking an approval, is prepared for your own wallet to sign. Anyone asking for a seed phrase is a scammer.'],
      ['What does "nothing found" mean?', 'Nothing in the sources checked, not nothing anywhere. A part that couldn\'t be checked is named in the alert, with the reason.'],
    ],
  },
  wallet_guardian: {
    title: 'Crypto Wallet Monitoring Agent: Approval Alerts | RektBull',
    description: 'An AI agent that watches up to 3 wallets for new risky approvals, flagged or upgraded spenders and stablecoin depegs, and alerts you with each source.',
    lead: 'alerts the day your wallet is at risk',
    checks: [
      ['A new token or NFT approval rated medium risk or worse', 'Chain explorers and GoPlus; ratings from RektBull\'s approval checks'],
      ['A contract you approved gets flagged', 'GoPlus address and contract checks'],
      ['A contract you approved had its code replaced', 'The contract\'s EIP-1967 implementation slot, read onchain'],
      ['A stablecoin you hold goes off its peg', 'DefiLlama prices; your balance read onchain'],
    ],
    faq: [
      ['How often does it check my wallet?', 'Every 12 or 24 hours, as you choose, for up to 3 wallets. Each new risk is alerted once, with the reasons and their sources.'],
      ['Can it stop a drainer?', 'It can\'t sign or move anything, so it can\'t stop a transaction. It tells you about risky approvals so you can revoke them from your own wallet, ideally before a drainer uses them. To check a transaction before you sign it, use the RektBull extension.'],
      ['What does it cost?', 'It\'s part of Safety Pro: $9 for 30 days or $79 for a year, paid in crypto. Nothing renews automatically.'],
    ],
  },
  claim_assistant: {
    title: 'Airdrop Checker Agent: Unclaimed Reward Alerts | RektBull',
    description: 'An AI agent that re-checks your wallet for unclaimed airdrops and Merkl rewards, each verified onchain, and tells you when something new can be claimed.',
    lead: 'money you\'re owed, found for you',
    checks: [
      ['Rewards from Merkl incentive campaigns (Uniswap, Aave, Morpho, Euler and many more)', 'Merkl\'s API; each proof checked against the distributor\'s root onchain'],
      ['Airdrops RektBull has added', 'Each airdrop\'s published Merkle tree, verified onchain'],
      ['Whether a reward token is worth claiming', 'GoPlus token flags; DefiLlama prices'],
    ],
    faq: [
      ['Is the airdrop checker free?', 'Yes. Checking is free, and claiming on the project\'s own site is free. If you claim through RektBull, 5% of what arrives (3% with Safety Pro) goes to RektBull in a separate transfer you sign with the claim.'],
      ['Will it claim for me?', 'No. It tells you what can be claimed and prepares the claim for your own wallet to sign. Nothing moves without your signature.'],
      ['Someone sent me a link to claim an airdrop. Is it real?', 'Treat it as a scam until proven otherwise: fake claim pages are the most common way wallets are drained. RektBull never sends claim links in DMs; check from rektbull.com or the project\'s own site, typed in yourself.'],
    ],
  },
  token_watch: {
    title: 'Token Rug Alert Agent: Daily Honeypot Checks | RektBull',
    description: 'An AI agent that re-checks up to 10 tokens every day: can it still be sold, did its tax or owner powers change, did GoPlus flag it. Alerts with sources.',
    lead: 'a rug check that runs every day',
    checks: [
      ['Can it still be sold after a buy?', 'A buy-then-sell quote from 0x (Jupiter on Solana)'],
      ['Did its buy or sell tax change?', '0x quotes and GoPlus'],
      ['What can its owner do (mint, pause, blacklist, change balances), and is it upgradeable?', 'Its verified source (Etherscan), read onchain'],
      ['Is it reported as a honeypot, or are holders unable to sell everything?', 'GoPlus'],
      ['How concentrated are its holders?', 'GoPlus and the chain explorer'],
    ],
    faq: [
      ['Does a clean result mean a token is safe?', 'No. The checks look for known patterns (unsellable, taxed, owner powers, flags), not intent. A token can pass every check and still be dumped by its team.'],
      ['Which chains does it cover?', 'Ethereum, Base, Arbitrum, Optimism, Polygon, BNB Chain and Solana.'],
      ['What does it cost?', 'It\'s part of Safety Pro ($9 for 30 days). A single check without it is 1 free point or $0.25 on the Safety page.'],
    ],
  },
  dao_votes: {
    title: 'DAO Vote Alert Agent: Snapshot and Onchain | RektBull',
    description: 'An AI agent that alerts you when a DAO vote opens that your wallet can cast, and a day before it closes, on Snapshot and onchain governors.',
    lead: 'never miss a vote you can cast',
    checks: [
      ['Proposals open in the DAOs your wallets can vote in', 'Snapshot\'s hub, and OpenZeppelin and Compound governors read onchain'],
      ['Your voting power, and whether you\'ve voted', 'Snapshot, and the governor contracts'],
      ['Tokens counting for nobody because they aren\'t delegated', 'The token contracts, read onchain'],
    ],
    faq: [
      ['Does it vote for me?', 'No. It tells you when a vote opens and before it closes. You vote from your own wallet, and RektBull never recommends a choice.'],
      ['Can it explain a proposal?', 'Yes: a plain-English summary written from the proposal\'s own text, with what it would change and what money and powers it moves. With Safety Pro it comes out of your AI allowance.'],
      ['What does it cost?', 'The alerts are part of Safety Pro. Checking your votes and voting are free on the Governance page.'],
    ],
  },
  yield_watch: {
    title: 'DeFi Exploit Alert Agent for Lending Positions | RektBull',
    description: 'An AI agent that watches your Aave v3, Compound v3 and Spark positions every 5 minutes for exploits, runs, paused withdrawals and depegs, and alerts you.',
    lead: 'your lending positions, watched every 5 minutes',
    checks: [
      ['Money leaving a market fast: a sign of an exploit or a run', 'Each venue\'s own contracts, read onchain every 5 minutes'],
      ['A market so borrowed that withdrawals may stop', 'Each venue\'s contracts'],
      ['Withdrawals paused by the protocol', 'Each venue\'s contracts'],
      ['What a deposit is worth falling, which shouldn\'t happen', 'Each venue\'s contracts'],
      ['A stablecoin trading below its peg', 'Each chain\'s Aave oracle'],
    ],
    faq: [
      ['Will it withdraw my money for me?', 'No. It alerts you, with "withdraw now" when it\'s critical, and the withdrawal is prepared for your own wallet to sign.'],
      ['Which lending venues does it watch?', 'Aave v3, Compound v3 and Spark, on Ethereum, Base and Arbitrum, for the wallets you watch.'],
      ['What does it cost?', 'It\'s part of Safety Pro ($9 for 30 days).'],
    ],
  },
  trading_agent: {
    title: 'Crypto Trading Agent With Onchain Limits | RektBull',
    description: 'A crypto trading agent that buys and sells only within limits your wallet signs onchain, checks each token first, and exits at your stop-loss or take-profit.',
    lead: 'trades only within limits your wallet signed',
    checks: [
      ['Every token is checked before it\'s bought', 'RektBull\'s token check (0x, GoPlus, verified source)'],
      ['Spend per trade and per day, and when the permission expires', 'A session key your wallet signs; the limits are enforced onchain'],
      ['Where the result goes', 'The Trade Router contract, which can only return what it buys to your wallet in the same transaction'],
      ['Your stop-loss and take-profit', 'The position\'s value, read from the Trade Router onchain'],
    ],
    faq: [
      ['Can the trading agent take my funds?', 'No. Its permission is limited, expiring and revocable, and enforced onchain: it can only trade within your limits and send the result back to your wallet. You can revoke it any time.'],
      ['Will it make money?', 'No one can promise that, and RektBull doesn\'t. It follows the rules you set; trading can lose money.'],
      ['What does it cost?', 'A 1% fee on each trade, taken inside the swap. The alerts are free.'],
    ],
  },
};

/** The agents that have a page, with their slug. */
const list = () => AGENTS.filter(a => PAGES[a.id]).map(a => ({ id: a.id, slug: slugOf(a.id), name: a.name }));
const bySlug = slug => list().find(a => a.slug === slug) || null;

function page(slug, base) {
  const a = bySlug(slug);
  if (!a) return null;
  const c = catalog().find(x => x.id === a.id);
  const p = PAGES[a.id];
  const url = `${base}/agents/${a.slug}`;
  const schedule = c.schedules.map(s => s.label.toLowerCase()).join(' or ');
  const others = list().filter(x => x.id !== a.id);
  const graph = [
    {
      '@type': 'WebPage', '@id': `${url}#page`, name: p.title.replace(/ \| RektBull$/, ''), description: p.description, url,
      isPartOf: { '@type': 'WebSite', name: 'RektBull', url: `${base}/` },
      about: { '@type': 'SoftwareApplication', name: `RektBull ${c.name}`, applicationCategory: 'FinanceApplication', operatingSystem: 'Web', description: c.does, offers: { '@type': 'Offer', price: c.plan === 'free' ? '0' : c.plan === 'pro' ? '9' : '0', priceCurrency: 'USD', description: c.price } },
    },
    seo.breadcrumbs(base, [['Home', `${base}/`], ['AI agents', `${base}/agents`], [c.name, url]]),
  ];
  const body = `<section class="pagehead">
    <div class="wrap wide">
      <span class="eyebrow">AI agent · ${esc(c.price)}</span>
      <h1>${esc(c.name)}: <em>${esc(p.lead)}</em></h1>
      <p>${esc(c.does)}</p>
      <p><a class="btn primary" href="/agents#agent-${esc(a.id)}">Switch it on</a> <a class="btn" href="${esc(c.desk.href)}">Open ${esc(c.desk.name)}</a></p>
      <nav class="jump" aria-label="On this page"><a href="#checks">What it checks</a><a href="#how">How it runs</a><a href="#never">What it never does</a><a href="#questions">Questions</a></nav>
    </div>
  </section>

  <main class="tool wide">
    <section class="card" id="checks">
      <h2>What it checks, and where each fact comes from</h2>
      <div class="tablewrap"><table class="rank"><thead><tr><th>Check</th><th>Source</th></tr></thead><tbody>
        ${p.checks.map(([what, src]) => `<tr><td>${esc(what)}</td><td class="source">${esc(src)}</td></tr>`).join('\n        ')}
      </tbody></table></div>
      <p class="source">A check that couldn't run says so, with the reason. Nothing found means nothing in these sources, not nothing anywhere.</p>
    </section>

    <section class="card" id="how">
      <h2>How it runs</h2>
      <div class="tablewrap"><table class="rank"><tbody>
        <tr><th scope="row">Schedule</th><td>${esc(schedule.charAt(0).toUpperCase() + schedule.slice(1))}</td></tr>
        <tr><th scope="row">Alerts</th><td>${esc(c.alerts)} By Telegram, email or browser notification.</td></tr>
        <tr><th scope="row">Price</th><td>${esc(c.price)}</td></tr>
        <tr><th scope="row">Where it runs</th><td>The same check as the <a href="${esc(c.desk.href)}">${esc(c.desk.name)}</a> page, on a schedule</td></tr>
      </tbody></table></div>
    </section>

    <section class="card" id="never">
      <h2>What it never does</h2>
      <ul class="rules">
        <li><strong>It never asks for your seed phrase or private key.</strong> Nobody legitimate ever does.</li>
        <li><strong>It never signs or moves your money.</strong> ${a.id === 'trading_agent' ? 'It trades only within the limits your wallet signed onchain, and only back to your wallet.' : 'Anything that needs a transaction is prepared for your own wallet to sign.'}</li>
        <li><strong>It never makes facts up.</strong> AI may write a summary, but only from facts that name their source; it never fills a gap with a guess.</li>
        <li><strong>It never calls anything safe.</strong> A clean result means nothing was found in the sources checked.</li>
      </ul>
    </section>

    <section class="card">
      <h2>The other agents</h2>
      <p>${others.map(o => `<a href="/agents/${esc(o.slug)}">${esc(o.name)}</a>`).join(' · ')} · <a href="/agents">All AI agents</a></p>
    </section>

    <section class="card" id="questions">
      <h2>Questions</h2>
      <div class="qs">
        ${p.faq.map(([q, ans]) => `<details><summary>${esc(q)}</summary><p>${esc(ans)}</p></details>`).join('\n        ')}
      </div>
    </section>
  </main>`;
  return { head: { title: p.title, description: p.description, url, base, graph }, body };
}

module.exports = { page, list, bySlug, PAGES, slugOf };
