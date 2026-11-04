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
  // The session key's PUBLIC address. Its private key is in KMS, used only by the trade service.
  sessionKeyAddress: (process.env.SESSION_KEY_ADDRESS || '').toLowerCase(),
  kmsSessionKeyVersion: process.env.KMS_SESSION_KEY_VERSION || '',
  // Testnets only, never production: a plain private key for the session key, instead of KMS.
  devSessionKey: process.env.DEV_SESSION_KEY || '',
  tradeTickMs: int(process.env.TRADE_TICK_MS, 15000),

  // Claim fees: the share of claimed airdrops and rewards sent to RektBull, in a
  // transfer the user signs next to the claim (receive-only wallet; unset = no fee).
  claimFeeWalletEvm: (process.env.CLAIM_FEE_WALLET_EVM || '').toLowerCase(),
  // The 0.1% yield move fee goes here (defaults to the claim fee wallet).
  yieldFeeWalletEvm: (process.env.YIELD_FEE_WALLET_EVM || '').toLowerCase(),
  // Automatic yield rebalancing (session keys and the Yield Router): built, and off until it's audited and switched on.
  yieldAutoEnabled: process.env.YIELD_AUTO_ENABLED === 'true',
  // {"8453": "0x…"}: the deployed Yield Router on each chain (none yet).
  yieldRouters: json('YIELD_ROUTERS', {}),

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
