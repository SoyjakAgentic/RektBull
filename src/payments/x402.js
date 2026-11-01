/**
 * x402: pay per call in USDC on Base, with no account.
 *
 * An unpaid request gets HTTP 402 and the payment terms (`accepts`). The
 * client's wallet signs a USDC transfer authorization and retries with it,
 * base64-encoded, in the X-PAYMENT header. RektBull verifies it with the
 * facilitator, does the work, and only then settles it; a run that fails is
 * never settled, so the payer is not charged. The settled transaction comes
 * back in the X-PAYMENT-RESPONSE header.
 */
const env = require('../config/env');
const { X402_ASSET, centsToRaw } = require('./stablecoins');
const facilitator = require('./facilitator');

const X402_VERSION = 1;
const TIMEOUT_SECONDS = 120;

const enabled = () => !!(env.x402PayTo && env.cdpApiKeyId && env.cdpApiKeySecret);

/** The payment terms for one call to resource at price_cents. */
function requirements(p, resource) {
  return {
    scheme: 'exact',
    network: env.x402Network,
    maxAmountRequired: centsToRaw(p.price_cents, X402_ASSET.decimals).toString(),
    resource,
    description: `RektBull: ${p.title}`,
    mimeType: 'application/json',
    payTo: env.x402PayTo,
    maxTimeoutSeconds: TIMEOUT_SECONDS,
    asset: X402_ASSET.address,
    extra: { name: X402_ASSET.name, version: X402_ASSET.version },
  };
}

/** The X-PAYMENT header as an object, or throws a 402-worthy error. */
function decodeHeader(header) {
  try {
    const payload = JSON.parse(Buffer.from(String(header), 'base64').toString('utf8'));
    if (!payload || typeof payload !== 'object' || !payload.payload) throw new Error('no payload');
    return payload;
  } catch {
    throw Object.assign(new Error('X-PAYMENT is not a valid base64-encoded x402 payment'), { status: 402, isPaymentInvalid: true });
  }
}

const encodeResponse = obj => Buffer.from(JSON.stringify(obj)).toString('base64');

/** The payer's address, from an EIP-3009 authorization payload. */
const payerOf = payload => String(payload?.payload?.authorization?.from || '').toLowerCase() || null;

/**
 * Verifies the payment now; returns { payer, settle } where settle() moves
 * the USDC and returns the X-PAYMENT-RESPONSE header value.
 */
async function accept(header, reqs) {
  const paymentPayload = decodeHeader(header);
  await facilitator.verifyX402Payment({ paymentPayload, paymentRequirements: reqs });
  return {
    payer: payerOf(paymentPayload),
    settle: async () => {
      const { txHash } = await facilitator.settleX402Payment({ paymentPayload, paymentRequirements: reqs });
      return { txHash, header: encodeResponse({ success: true, transaction: txHash, network: reqs.network, payer: payerOf(paymentPayload) }) };
    },
  };
}

module.exports = { X402_VERSION, enabled, requirements, decodeHeader, encodeResponse, payerOf, accept };
