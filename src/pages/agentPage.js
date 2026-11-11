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
const agentStates = require('../admin/agentStates');

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
      ['What does it cost?', 'It\'s part of Safety Pro: {{price:pro_30d}} for 30 days or {{price:pro_365d}} for a year, paid in crypto. Nothing renews automatically.'],
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
      ['Is the airdrop checker free?', 'Yes. Checking is free, and claiming on the project\'s own site is free. If you claim through RektBull, {{fee:airdrop_claim}} of what arrives ({{profee:airdrop_claim}} with Safety Pro) goes to RektBull in a separate transfer you sign with the claim.'],
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
      ['What does it cost?', 'It\'s part of Safety Pro ({{price:pro_30d}} for 30 days). A single check without it is {{points:token_quick_check}} free point or {{price:token_quick_check}} on the Safety page.'],
    ],
  },
  meme_watch: {
    title: 'Meme Coin Alerts: Insider Sells and Rugs | RektBull',
    description: 'An AI agent that watches the meme coins you bought for insiders selling, honeypot flags, pulled liquidity and your stop-loss, with a sell ready to sign.',
    lead: 'the alerts that come before a meme coin goes to zero',
    checks: [
      ['Launch-bundle and insider wallets: did they sell what they bought at launch?', 'The bundle check (block explorer transfers), then their balances read onchain every 6 hours'],
      ['Was liquidity pulled from its pools?', 'DexScreener, compared with the last check'],
      ['Did it become a honeypot, add a tax, or gain owner powers?', 'GoPlus token security'],
      ['Is it past your take-profit or stop-loss?', 'DexScreener\'s price against what it cost you, with your Trade desk settings'],
    ],
    faq: [
      ['Does it sell for me?', 'No. Each alert links a sell of the whole position on the Trade desk, already checked, for your wallet to review and sign. RektBull never moves your money.'],
      ['Which tokens does it watch?', 'Up to 10 tokens you bought through RektBull\'s Trade or Launches desk on Base, Ethereum or Arbitrum, newest first. Stablecoins and ETH aren\'t watched.'],
      ['What does it cost?', 'Nothing: it\'s free for any signed-in wallet. Trades carry RektBull\'s 1% fee. Nothing here is financial advice.'],
    ],
  },
  launch_safety: {
    title: 'Rug Pull Detector: Bundled Launch Checks | RektBull',
    description: 'An AI agent that checks new tokens for a bundled launch: early buyers sharing a funder, links to the deployer, and alerts when those wallets start selling.',
    lead: 'was the launch bundled, and are they selling?',
    checks: [
      ['The token\'s largest buyers in its first hour (pools, routers and program accounts set aside)', 'Token transfers from the block explorer (Etherscan V2 or Blockscout); on Solana, the mint\'s first transactions over RPC'],
      ['Where each early buyer\'s first ETH, BNB, POL or SOL came from', 'Each wallet\'s first incoming transfer, from the explorer or Solana RPC'],
      ['Buyers funded from the same wallet, and how much of the supply they bought', 'The same transfers; supply read onchain'],
      ['Whether a funding chain leads back to the deployer, up to 3 steps', 'Contract creation from the explorer; each funder\'s own first funding'],
      ['What those wallets hold now, and whether they\'ve sold', 'Balances read onchain'],
    ],
    faq: [
      ['What is a bundled launch?', 'A token launch where the team, or one person, buys a large share of the supply in the first minutes through many wallets made to look independent, then sells into later buyers. The wallets usually give themselves away by being funded from the same place shortly before the launch.'],
      ['Does a shared funder prove a rug pull?', 'No. It is evidence to weigh, not proof of intent: an exchange paying out withdrawals funds many wallets too, so a funder that has sent thousands of transactions is named as busy and not counted. And a launch with no bundle can still go to zero.'],
      ['Which chains and what does it cost?', 'Ethereum, Base, Arbitrum, Optimism, Polygon, BNB Chain and Solana. The agent is part of Safety Pro; a single launch check is {{points:launch_check}} free points or {{price:launch_check}} on the Safety page.'],
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
      ['What does it cost?', 'It\'s part of Safety Pro ({{price:pro_30d}} for 30 days).'],
    ],
  },
  group_guard: {
    title: 'Telegram Anti-Scam Bot for Crypto Groups | RektBull',
    description: 'A free Telegram bot for crypto groups: removes known phishing links, warns about fake sites and contracts, and flags admin impersonators. Every warning sourced.',
    lead: 'scams caught in your Telegram group',
    checks: [
      ['Every link posted: is it a known phishing site?', 'GoPlus phishing site list'],
      ['A link that looks like your official site but isn\'t', 'Your official sites, set by your admins; the link\'s domain compared letter by letter'],
      ['A contract address that isn\'t your official one, posted as "the contract" or "CA"', 'Your official contracts, set by your admins'],
      ['A token posted on your chains that can\'t be sold, or whose owner can change balances', 'GoPlus token security'],
      ['A member whose name copies an admin\'s, or who calls themselves support or admin', 'Telegram\'s list of the group\'s admins; look-alike letters (0 for o, Cyrillic а for a) matched'],
    ],
    faq: [
      ['How do I add Group Guard to my group?', 'Add RektBull\'s bot to the group as an admin with the "Delete messages" right, then set your official site and contract with /official_site and /official_contract. /guard shows the settings, and only your group\'s admins can change them.'],
      ['Does it read or store our messages?', 'It reads messages posted in the group to check their links and addresses, and stores no message text and no record of who said what: only the group\'s settings and daily counts of what it did.'],
      ['What does it cost?', 'It\'s free. Each group has daily limits on replies and checks, so it can never flood a chat; plans for very large groups may come later, paid in crypto.'],
    ],
  },
  channel_poster: {
    title: 'Telegram Channel Post Drafts for Crypto Projects | RektBull',
    description: 'Free drafts for your crypto project\'s Telegram channel: hacks on your chains, your DAO\'s votes, new reward campaigns. Sourced, and posted only when you approve.',
    lead: 'drafts for your Telegram channel, posted when you say so',
    checks: [
      ['Large hacks on the chains you choose ($1M or more, in the last 3 days)', 'DefiLlama\'s hack record, with the write-up linked'],
      ['New votes in your Snapshot space, and votes closing within a day', 'Snapshot'],
      ['New Merkl reward campaigns on your protocol (stated as facts, never as a rate to earn)', 'Merkl'],
    ],
    faq: [
      ['How do I set up Channel Poster?', 'Start RektBull\'s bot in a private chat (Telegram only lets a bot message people who started it), then add it to your channel as an admin with "Post messages". Choose topics with /poster_topics, and set your chains, Snapshot space and protocol. Drafts then arrive in that private chat.'],
      ['Does it post without asking?', 'No. Every draft waits for an admin of the channel to tap Post; Skip drops it, and a draft left for 3 days expires. Each item is drafted once.'],
      ['What does it cost?', 'It\'s free. Each post ends with the source of its facts; the drafts carry no advice, no prices to buy at and no promised returns.'],
    ],
  },
  contract_audit: {
    title: 'Smart Contract Audit Tool: Slither, First Pass | RektBull',
    description: 'A first-pass smart contract audit: Slither\'s detectors, checklist patterns, known compiler bugs and owner powers, in plain English, every flag sourced.',
    lead: 'a first-pass review of any verified contract',
    checks: [
      ['Reentrancy, unchecked transfers, uninitialized storage, shadowing and ~100 more patterns in the compiled contract', 'Slither, run on the contract compiled with the solc version it was verified with'],
      ['tx.origin checks, chain data used as randomness, delegatecall, unchecked calls, unprotected initializers', 'Pattern checks from an audit checklist, in the contract\'s own code'],
      ['ERC-4626 share inflation, and accounting that breaks with fee-on-transfer tokens', 'Pattern checks in the contract\'s own code'],
      ['Who can mint, pause, blacklist, set fees, upgrade or withdraw', 'Owner-only functions found in the code'],
      ['Known bugs in the compiler version it was built with, and whether their conditions hold', 'The Solidity team\'s bug list'],
      ['Comments written to steer an automated reviewer', 'Pattern check; reported, never followed'],
    ],
    faq: [
      ['Is this a full smart contract audit?', 'No. It\'s a first pass: Slither\'s findings and the checklist patterns are flags for a person to confirm by reading the code at their lines, and some are false positives. It doesn\'t find business-logic flaws, price manipulation or economic attacks, and it never calls a contract safe.'],
      ['Which contracts can it review?', 'Contracts with verified source on Ethereum, Base, Arbitrum, Optimism, Polygon or BNB Chain. A proxy\'s verified implementation is reviewed with it. Unverified code can\'t be reviewed, and that alone is a reason for caution.'],
      ['What does it cost, and what if it fails?', '{{price:contract_audit}} an audit, with a downloadable PDF report, from credits or by x402. If the analyzer can\'t run, the audit is refused and nothing is charged. The plain-English summary is written by AI from the findings only; it never adds or confirms one.'],
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
/** Agents for communities: they run in a group, not for one account. */
const COMMUNITY = {
  group_guard: () => {
    const add = require('../services/groupGuard').addLink();
    return {
      id: 'group_guard', name: 'Group Guard', plan: 'free', price: 'Free', community: true,
      does: 'A Telegram bot for crypto groups. It checks every link and contract address posted, removes known phishing links, warns about look-alike sites and fake contracts, and flags members whose names copy an admin\'s.',
      alerts: 'In the group itself, as a reply to the message, with the source.',
      schedules: [{ label: 'On every message' }],
      desk: add ? { name: 'Telegram', href: add } : { name: 'AI agents', href: '/agents#communities' },
      action: add ? { text: 'Add it to your group', href: add } : { text: 'Opening soon', href: '/agents#communities' },
      where: 'In your Telegram group, as RektBull\'s bot, made an admin with the "Delete messages" right',
    };
  },
};

COMMUNITY.channel_poster = () => {
  const add = require('../services/channelPoster').addLink();
  return {
    id: 'channel_poster', name: 'Channel Poster', plan: 'free', price: 'Free', community: true,
    does: 'Drafts posts for your Telegram channel from RektBull\'s data: large hacks on your chains, votes in your Snapshot space, new reward campaigns on your protocol. Each one is posted only when you tap Post.',
    alerts: 'Drafts arrive in your private chat with the bot, with Post and Skip buttons.',
    schedules: [{ label: 'Checked every 30 minutes' }],
    desk: add ? { name: 'Telegram', href: add } : { name: 'AI agents', href: '/agents#communities' },
    action: add ? { text: 'Add it to your channel', href: add } : { text: 'Opening soon', href: '/agents#communities' },
    where: 'In your Telegram channel, as RektBull\'s bot, made an admin with the "Post messages" right',
  };
};

COMMUNITY.contract_audit = () => ({
  id: 'contract_audit', name: 'Contract Audit', plan: 'paid', price: '{{price:contract_audit}} an audit, with a downloadable PDF report (credits or x402)', offer_usd: '{{usd:contract_audit}}',
  does: 'A first-pass security review of a verified contract, and a proxy\'s implementation with it: Slither\'s ~100 detectors on the contract compiled as it was verified, checks from an audit checklist, the compiler\'s known bugs and who holds power over it, explained in plain English.',
  alerts: 'The review, on the page, when it\'s done (usually under a few minutes).',
  schedules: [{ label: 'When you ask' }],
  desk: { name: 'Safety', href: '/safety#audit-card' },
  action: { text: 'Audit a contract', href: '/safety#audit-card' },
  where: 'On the Safety page; Slither runs in RektBull\'s own analyzer service',
});

const everyPage = () => [
  ...AGENTS.filter(a => PAGES[a.id]).map(a => ({ id: a.id, slug: slugOf(a.id), name: a.name })),
  ...Object.keys(COMMUNITY).filter(id => PAGES[id]).map(id => ({ id, slug: slugOf(id), name: COMMUNITY[id]().name })),
];
/** The agents listed in menus, the sitemap and llms.txt: not the ones an admin hid or switched off. */
const list = () => everyPage().filter(a => agentStates.listed(a.id));
/** An agent's facts: from the agents' catalog, or the community agents above. */
const info = id => (COMMUNITY[id] ? COMMUNITY[id]() : catalog({ all: true }).find(x => x.id === id));
/** Any agent's page, listed or not (a hidden agent still works by its link). */
const bySlug = slug => everyPage().find(a => a.slug === slug) || null;

function page(slug, base) {
  const a = bySlug(slug);
  if (!a) return null;
  const c = info(a.id);
  const p = PAGES[a.id];
  const url = `${base}/agents/${a.slug}`;
  const schedule = c.schedules.map(s => s.label.toLowerCase()).join(' or ');
  const others = list().filter(x => x.id !== a.id);
  const graph = [
    {
      '@type': 'WebPage', '@id': `${url}#page`, name: p.title.replace(/ \| RektBull$/, ''), description: p.description, url,
      isPartOf: { '@type': 'WebSite', name: 'RektBull', url: `${base}/` },
      about: { '@type': 'SoftwareApplication', name: `RektBull ${c.name}`, applicationCategory: c.action ? 'SecurityApplication' : 'FinanceApplication', operatingSystem: c.community ? 'Telegram' : 'Web', description: c.does, offers: { '@type': 'Offer', price: c.offer_usd || (c.plan === 'pro' ? '{{usd:pro_30d}}' : '0'), priceCurrency: 'USD', description: c.price } },
    },
    seo.breadcrumbs(base, [['Home', `${base}/`], ['AI agents', `${base}/agents`], [c.name, url]]),
  ];
  const paused = agentStates.isOff(a.id);
  const body = `<section class="pagehead">
    <div class="wrap wide">
      ${paused ? '<p class="notice" role="status"><strong>Paused for now.</strong> RektBull has paused this agent; it isn\'t running or taking new requests. Settings are kept.</p>' : ''}
      <span class="eyebrow">AI agent · ${esc(c.price)}</span>
      <h1>${esc(c.name)}: <em>${esc(p.lead)}</em></h1>
      <p>${esc(c.does)}</p>
      <p>${c.action ? `<a class="btn primary" href="${esc(c.action.href)}"${/^https:/.test(c.action.href) ? ' rel="noopener" target="_blank"' : ''}>${esc(c.action.text)}</a>` : `<a class="btn primary" href="/agents#agent-${esc(a.id)}">Switch it on</a> <a class="btn" href="${esc(c.desk.href)}">Open ${esc(c.desk.name)}</a>`}</p>
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
        <tr><th scope="row">Alerts</th><td>${esc(c.alerts)}${c.action ? '' : ' By Telegram, email or browser notification.'}</td></tr>
        <tr><th scope="row">Price</th><td>${esc(c.price)}</td></tr>
        <tr><th scope="row">Where it runs</th><td>${c.where ? esc(c.where) : `The same check as the <a href="${esc(c.desk.href)}">${esc(c.desk.name)}</a> page, on a schedule`}</td></tr>
      </tbody></table></div>
    </section>

    <section class="card" id="never">
      <h2>What it never does</h2>
      <ul class="rules">
        <li><strong>It never asks for your seed phrase or private key.</strong> Nobody legitimate ever does.</li>
        <li><strong>It never signs or moves your money${c.community ? ', and never DMs anyone' : ''}.</strong> ${c.community ? 'It only reads what is posted in the group, and stores no message text.' : a.id === 'contract_audit' ? 'It reads published source code; nothing in the contract is run, and nothing is sent from your wallet.' : a.id === 'trading_agent' ? 'It trades only within the limits your wallet signed onchain, and only back to your wallet.' : 'Anything that needs a transaction is prepared for your own wallet to sign.'}</li>
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
  return { head: { title: p.title, description: p.description, url, base, graph, noindex: !agentStates.listed(a.id) }, body };
}

module.exports = { page, list, bySlug, info, PAGES, slugOf };
