/**
 * Every setting RektBull reads, in one place, with its default.
 * See .env.example for what each one means.
 */
const list = v => String(v || '').split(',').map(s => s.trim()).filter(Boolean);
const int = (v, d) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));

function json(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { throw new Error(`${name} is not valid JSON`); }
}

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: int(process.env.PORT, 8080),
  serviceRole: process.env.SERVICE_ROLE || 'all', // web | worker | trade | all
  databaseUrl: process.env.DATABASE_URL || '',

  // Sign in with your wallet
  jwtSecret: process.env.JWT_SECRET || '',
  siweDomain: process.env.SIWE_DOMAIN || 'rektbull.com',
  siweUri: process.env.SIWE_URI || 'https://rektbull.com',
  // Alerts: where links in alerts point, and the delivery channels (each optional).
  // Who runs RektBull and how to reach them about privacy (shown on /privacy).
  operatorName: process.env.OPERATOR_NAME || 'the RektBull team',
  privacyContact: process.env.PRIVACY_CONTACT || 'privacy@rektbull.com',
  // The postal address every newsletter email carries (CAN-SPAM); the newsletter sends nothing without it.
  operatorPostalAddress: process.env.OPERATOR_POSTAL_ADDRESS || '',
  newsletterPerTick: int(process.env.NEWSLETTER_PER_TICK, 50), // newsletter emails per 5-minute worker tick
  // IndexNow (docs/SEO.md): tells Bing and others when a digest is published. A random 32-character hex string; public by design.
  indexNowKey: process.env.INDEXNOW_KEY || '',
  publicUrl: (process.env.PUBLIC_URL || process.env.SIWE_URI || 'https://rektbull.com').replace(/\/$/, ''),
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramBotUsername: process.env.TELEGRAM_BOT_USERNAME || '',
  telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || '',
  resendApiKey: process.env.RESEND_API_KEY || '',
  emailFrom: process.env.EMAIL_FROM || 'RektBull <alerts@rektbull.com>',
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY || '',
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY || '',
  vapidSubject: process.env.VAPID_SUBJECT || 'mailto:alerts@rektbull.com',
  adminWallets: list(process.env.ADMIN_WALLETS).map(a => a.toLowerCase()),

  // AI. The model is a setting, so changing it never needs a code change.
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  reportModel: process.env.REPORT_MODEL || 'claude-opus-5-5',
  reportEffort: process.env.REPORT_EFFORT || 'medium',
  // AI forecasts (src/forecasts/): a cheap model screens every market, a stronger one researches the few it flags.
  forecastScreenModel: process.env.FORECAST_SCREEN_MODEL || 'claude-haiku-5-5',
  forecastModel: process.env.FORECAST_MODEL || 'claude-sonnet-5-5',

  // Data providers (all have free plans; see docs/FREE_TIER.md)
  etherscanApiKey: process.env.ETHERSCAN_API_KEY || '',
  blockscoutApiKey: process.env.BLOCKSCOUT_API_KEY || '',
  zeroExApiKey: process.env.ZEROEX_API_KEY || '',
  jupiterApiKey: process.env.JUPITER_API_KEY || '',
  // {"goplus": 2000, "etherscan": 90000, ...}: calls per UTC day before a provider is skipped.
  providerDailyLimits: json('PROVIDER_DAILY_LIMITS', {}),

  // Trading (approve-each now; automatic trading with session keys in milestone 2)
  tradingEnabled: process.env.TRADING_ENABLED === 'true',
  swapFeeBps: int(process.env.SWAP_FEE_BPS, 100), // 1%; the Trade Router caps it at 1% onchain
  swapFeeWalletEvm: (process.env.SWAP_FEE_WALLET_EVM || '').toLowerCase(),
  // RektBull's Solana fee wallet (a public address; Solana addresses are case-sensitive). Unset: Solana trades carry no fee.
  swapFeeWalletSolana: (process.env.SWAP_FEE_WALLET_SOLANA || '').trim(),
  // The session key's PUBLIC address. Its private key is in KMS, used only by the trade service.
  sessionKeyAddress: (process.env.SESSION_KEY_ADDRESS || '').toLowerCase(),
  kmsSessionKeyVersion: process.env.KMS_SESSION_KEY_VERSION || '',
  // Testnets only, never production: a plain private key for the session key, instead of KMS.
  devSessionKey: process.env.DEV_SESSION_KEY || '',
  tradeTickMs: int(process.env.TRADE_TICK_MS, 15000),

  // Region blocks (src/compliance/regions.js): the ONE request header the load balancer sets to the
  // client's two-letter country, e.g. X-Client-Geo-Location (Google Cloud) or CF-IPCountry (Cloudflare).
  // Unset: no country is known, so a venue with blocked countries is blocked for everyone.
  geoCountryHeader: /^[A-Za-z0-9-]{1,64}$/.test(process.env.GEO_COUNTRY_HEADER || '') ? process.env.GEO_COUNTRY_HEADER : '',
  // And the region within the country (for blocks such as CA-ON, Ontario): e.g. X-Client-Geo-Subdivision set to
  // Google Cloud's {client_region_subdivision}, or Cloudflare's CF-Region-Code. Unset: a list naming regions of a
  // country blocks that whole country.
  geoSubdivisionHeader: /^[A-Za-z0-9-]{1,64}$/.test(process.env.GEO_SUBDIVISION_HEADER || '') ? process.env.GEO_SUBDIVISION_HEADER : '',

  // Hyperliquid perps (docs/HYPERLIQUID.md). Off until switched on.
  hlEnabled: process.env.HL_ENABLED === 'true',
  hlNetwork: process.env.HL_NETWORK === 'testnet' ? 'testnet' : 'mainnet',
  // RektBull's share of Hyperliquid's 1,200 weight a minute per IP; reads are refused past it.
  hlWeightPerMinute: int(process.env.HL_WEIGHT_PER_MINUTE, 1000),
  // The builder code: RektBull's PUBLIC address that Hyperliquid pays the fee to on each fill, and the fee in
  // tenths of a basis point (10 = 0.01%). Unset address: orders carry no builder field and no RektBull fee.
  hlBuilderAddress: /^0x[0-9a-fA-F]{40}$/.test(process.env.HL_BUILDER_ADDRESS || '') ? process.env.HL_BUILDER_ADDRESS.toLowerCase() : '',
  hlBuilderFeeTenthsBps: Math.min(100, Math.max(0, int(process.env.HL_BUILDER_FEE_TENTHS_BPS, 10))), // Hyperliquid's cap on perps is 0.1% (100)
  // Automatic trading only opens positions in markets at least this deep (both must hold).
  hlAutoMinOpenInterestUsd: int(process.env.HL_AUTO_MIN_OPEN_INTEREST_USD, 5000000),
  hlAutoMinDayVolumeUsd: int(process.env.HL_AUTO_MIN_DAY_VOLUME_USD, 5000000),
  // Automatic trading (src/hyperliquid/auto.js): off until switched on. RektBull's agent wallet key lives in
  // Cloud KMS (KMS_HL_AGENT_KEY_VERSION); HL_AGENT_ADDRESS is its PUBLIC address, which users approve.
  // DEV_HL_AGENT_KEY is a throwaway key for Hyperliquid's testnet only, refused in production and on mainnet.
  hlAutoEnabled: process.env.HL_AUTO_ENABLED === 'true',
  hlAgentAddress: /^0x[0-9a-fA-F]{40}$/.test(process.env.HL_AGENT_ADDRESS || '') ? process.env.HL_AGENT_ADDRESS.toLowerCase() : '',
  kmsHlAgentKeyVersion: process.env.KMS_HL_AGENT_KEY_VERSION || '',
  devHlAgentKey: process.env.DEV_HL_AGENT_KEY || '',
  // The most leverage an automatic position may use (and the user may allow), and how far from Hyperliquid's
  // mark price an automatic order may fill, in basis points (also the most mark and oracle may differ).
  hlAutoMaxLeverage: Math.min(50, Math.max(1, int(process.env.HL_AUTO_MAX_LEVERAGE, 10))),
  hlAutoPriceBandBps: Math.min(500, Math.max(5, int(process.env.HL_AUTO_PRICE_BAND_BPS, 50))),

  // Claim fees: the share of claimed airdrops and rewards sent to RektBull, in a
  // transfer the user signs next to the claim (receive-only wallet; unset = no fee).
  claimFeeWalletEvm: (process.env.CLAIM_FEE_WALLET_EVM || '').toLowerCase(),
  // The 0.1% yield move fee goes here (defaults to the claim fee wallet).
  yieldFeeWalletEvm: (process.env.YIELD_FEE_WALLET_EVM || '').toLowerCase(),
  // Automatic yield rebalancing (session keys and the Yield Router): built, and off until it's audited and switched on.
  yieldAutoEnabled: process.env.YIELD_AUTO_ENABLED === 'true',
  // {"8453": "0x…"}: the deployed Yield Router on each chain (none yet).
  yieldRouters: json('YIELD_ROUTERS', {}),

  // Polymarket (docs/POLYMARKET.md). Off until switched on; orders are signed by the user's wallet and sent from their browser.
  polymarketEnabled: process.env.POLYMARKET_ENABLED === 'true',
  // RektBull's builder code: a PUBLIC 32-byte id from polymarket.com > Settings > Builders, signed into every order.
  // Polymarket pays the builder fee on fills only. Without it no order is prepared (an unpaid desk isn't offered).
  polymarketBuilderCode: /^0x[0-9a-fA-F]{64}$/.test(process.env.POLYMARKET_BUILDER_CODE || '') ? process.env.POLYMARKET_BUILDER_CODE.toLowerCase() : '',
  // The fee rates set on that builder profile, in basis points (1 = 0.01%). Polymarket charges what the PROFILE says
  // (taker at most 100, maker at most 50, whole basis points); these must say the same, since users are shown them.
  polymarketTakerFeeBps: Math.min(100, Math.max(0, int(process.env.POLYMARKET_BUILDER_TAKER_FEE_BPS, 1))),
  polymarketMakerFeeBps: Math.min(50, Math.max(0, int(process.env.POLYMARKET_BUILDER_MAKER_FEE_BPS, 1))),
  // Where the profit share on redemptions goes (catalog: polymarket_profit): a PUBLIC address only. Unset: no profit share.
  polymarketFeeWallet: /^0x[0-9a-fA-F]{40}$/.test(process.env.POLYMARKET_FEE_WALLET || '') ? process.env.POLYMARKET_FEE_WALLET : '',
  // RektBull's own Builder API key, for Polymarket's gasless relayer (wallet set-up, redemptions). RektBull's secret, never a user's.
  polymarketBuilderApiKey: process.env.POLYMARKET_BUILDER_API_KEY || '',
  polymarketBuilderApiSecret: process.env.POLYMARKET_BUILDER_API_SECRET || '',
  polymarketBuilderApiPassphrase: process.env.POLYMARKET_BUILDER_API_PASSPHRASE || '',
  // Automatic Polymarket trading (src/polymarket/auto.js): RektBull's Session Key, KMS in production (trade service only);
  // POLYMARKET_SESSION_ADDRESS is its PUBLIC address users authorize. DEV_POLYMARKET_SESSION_KEY: tests only, never production.
  polymarketSessionAddress: /^0x[0-9a-fA-F]{40}$/.test(process.env.POLYMARKET_SESSION_ADDRESS || '') ? process.env.POLYMARKET_SESSION_ADDRESS.toLowerCase() : '',
  kmsPolymarketSessionKeyVersion: process.env.KMS_POLYMARKET_SESSION_KEY_VERSION || '',
  devPolymarketSessionKey: process.env.DEV_POLYMARKET_SESSION_KEY || '',
  polymarketAutoEnabled: process.env.POLYMARKET_AUTO_ENABLED === 'true',

  // Payments: x402 (pay per call in USDC on Base)
  x402PayTo: (process.env.X402_PAY_TO || '').toLowerCase(),
  x402Network: process.env.X402_NETWORK || 'base',
  cdpApiKeyId: process.env.CDP_API_KEY_ID || '',
  cdpApiKeySecret: process.env.CDP_API_KEY_SECRET || '',

  // Payments: NOWPayments, a hosted checkout in many coins, forwarded to the payout wallet set in its dashboard.
  nowpaymentsEnabled: process.env.NOWPAYMENTS_ENABLED === 'true',
  nowpaymentsApiKey: process.env.NOWPAYMENTS_API_KEY || '',
  nowpaymentsIpnSecret: process.env.NOWPAYMENTS_IPN_SECRET || '',
  nowpaymentsApiBase: process.env.NOWPAYMENTS_API_BASE || 'https://api.nowpayments.io/v1',

  // Payments: stablecoin deposits (credits top-ups)
  depositXpub: process.env.CRYPTO_DEPOSIT_XPUB || '',
  paymentChains: list(process.env.PAYMENT_CHAINS || 'ethereum,bsc,base'),
  // Chains approval cleanup scans (default: every EVM chain RektBull reads).
  approvalChains: process.env.APPROVAL_CHAINS ? list(process.env.APPROVAL_CHAINS) : null,
  invoiceExpiryMinutes: int(process.env.INVOICE_EXPIRY_MINUTES, 60),
  minTopUpCents: int(process.env.MIN_TOP_UP_CENTS, 500),
  watcherIntervalMs: int(process.env.WATCHER_INTERVAL_MS, 20000),
  watcherMaxBlockRange: int(process.env.WATCHER_MAX_BLOCK_RANGE, 500),
  // How long after an invoice a deposit address keeps being watched.
  watchAddressDays: int(process.env.WATCH_ADDRESS_DAYS, 30),
};

module.exports = env;
