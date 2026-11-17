/**
 * Polymarket's contracts on Polygon (chain 137), from docs.polymarket.com/resources/contracts
 * and trading/wallets-auth ("Set Up Trading Approvals"), read 16 November 2026.
 */
const CHAIN_ID = 137;
const C = {
  pUSD: '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB',
  USDCe: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
  conditionalTokens: '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045',
  positionManager: '0x006F54F7f9A22e0000CC2AB60031000000ae9fEF',
  exchangeV2: '0xe3333700cA9d93003F00f0F71f8515005F6c00Aa',
  exchangeCtf: '0xE111180000d2663C0091e4f400237545B87B996B',
  exchangeNegRisk: '0xe2222d279d744050d28e00520010520000310F59',
  negRiskAdapter: '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296',
  router: '0x12121212006e4CD160D18e3f00711DA5c3372600',
  ctfCollateralAdapter: '0xAdA100Db00Ca00073811820692005400218FcE1f',
  negRiskCtfCollateralAdapter: '0xadA2005600Dec949baf300f4C6120000bDB6eAab',
  collateralOnramp: '0x93070a847efEf7F70739046A929D47a521F5B8ee',
  collateralOfframp: '0x2957922Eb93258b93368531d39fAcCA3B4dC5854',
  depositWalletFactory: '0x00000000000Fb5C9ADea0298D729A0CB3823Cc07',
  depositWalletBeacon: '0x7A18EDfe055488A3128f01F563e5B479D92ffc3a',
};

/**
 * The eight trading approvals Polymarket's CLOB needs, each said plainly.
 * They let Polymarket's exchange contracts settle orders the user signs; they
 * are not billing and give RektBull nothing.
 */
const APPROVALS = [
  { id: 'pusd-v2', kind: 'erc20', token: C.pUSD, spender: C.exchangeV2, token_name: 'pUSD', spender_name: 'Polymarket V2 Exchange', what: 'Lets Polymarket\'s V2 exchange take pUSD from your Polymarket wallet to pay for buy orders you sign.' },
  { id: 'pusd-ctf', kind: 'erc20', token: C.pUSD, spender: C.exchangeCtf, token_name: 'pUSD', spender_name: 'Polymarket CTF Exchange', what: 'Lets Polymarket\'s standard exchange take pUSD to pay for buy orders you sign.' },
  { id: 'pusd-negrisk', kind: 'erc20', token: C.pUSD, spender: C.exchangeNegRisk, token_name: 'pUSD', spender_name: 'Polymarket Neg Risk Exchange', what: 'Lets Polymarket\'s exchange for multi-outcome events take pUSD to pay for buy orders you sign.' },
  { id: 'pusd-adapter', kind: 'erc20', token: C.pUSD, spender: C.negRiskAdapter, token_name: 'pUSD', spender_name: 'Polymarket Neg Risk Adapter', what: 'Polymarket rejects buy orders in multi-outcome events without this pUSD approval.' },
  { id: 'shares-v2', kind: 'erc1155', token: C.positionManager, spender: C.exchangeV2, token_name: 'outcome shares (PositionManager)', spender_name: 'Polymarket V2 Exchange', what: 'Lets Polymarket\'s V2 exchange move your outcome shares when a sell order you signed fills.' },
  { id: 'shares-ctf', kind: 'erc1155', token: C.conditionalTokens, spender: C.exchangeCtf, token_name: 'outcome shares (Conditional Tokens)', spender_name: 'Polymarket CTF Exchange', what: 'Lets Polymarket\'s standard exchange move your outcome shares when a sell order you signed fills.' },
  { id: 'shares-negrisk', kind: 'erc1155', token: C.conditionalTokens, spender: C.exchangeNegRisk, token_name: 'outcome shares (Conditional Tokens)', spender_name: 'Polymarket Neg Risk Exchange', what: 'Lets Polymarket\'s exchange for multi-outcome events move your outcome shares when a sell order you signed fills.' },
  { id: 'shares-adapter', kind: 'erc1155', token: C.conditionalTokens, spender: C.negRiskAdapter, token_name: 'outcome shares (Conditional Tokens)', spender_name: 'Polymarket Neg Risk Adapter', what: 'Polymarket rejects sell orders in multi-outcome events without this approval.' },
];

/**
 * How each kind of Polymarket wallet signs an order (docs: trading/place-orders, "Create the Order Typed Data").
 * `signer_is_wallet`: the order's `signer` field is the wallet itself (else the account's own key).
 */
const WALLET_TYPES = {
  deposit: { signature_type: 3, label: 'Deposit Wallet', signer_is_wallet: true, relayer: true, about: 'Polymarket\'s default smart wallet since 4 May 2026: one per signing key, gas paid by Polymarket\'s relayer.' },
  proxy: { signature_type: 1, label: 'Proxy Wallet (existing email or Google account)', signer_is_wallet: false, relayer: false, about: 'A legacy Polymarket wallet. RektBull can prepare its orders; set-up and redemptions stay on polymarket.com.' },
  safe: { signature_type: 2, label: 'Safe Wallet (existing account made with a browser wallet)', signer_is_wallet: false, relayer: false, about: 'A legacy Polymarket wallet. RektBull can prepare its orders; set-up and redemptions stay on polymarket.com.' },
  eoa: { signature_type: 0, label: 'Your wallet itself (EOA)', signer_is_wallet: true, relayer: false, about: 'Only for addresses Polymarket has allowlisted for EOA trading. Every approval and redemption is your own Polygon transaction and needs POL for gas.' },
};

/** The exchange an order is signed for, from the outcome's order book (version "v2", or CTF with neg_risk). */
function exchangeFor({ position_system: system, neg_risk: negRisk }) {
  if (system === 'v2') return { version: '3', verifyingContract: C.exchangeV2 };
  return { version: '2', verifyingContract: negRisk ? C.exchangeNegRisk : C.exchangeCtf };
}

module.exports = { CHAIN_ID, C, APPROVALS, WALLET_TYPES, exchangeFor };
