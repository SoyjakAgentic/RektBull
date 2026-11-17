/**
 * Building a Polymarket order for the user's wallet to sign, exactly as
 * docs.polymarket.com/trading/place-orders describes it (read 16 November
 * 2026). Pure functions: nothing here signs, and nothing here talks to
 * Polymarket.
 *
 * The signed struct (EIP-712, domain "Polymarket CTF Exchange", chain 137):
 *   Order(uint256 salt,address maker,address signer,uint256 tokenId,uint256 makerAmount,
 *         uint256 takerAmount,uint8 side,uint8 signatureType,uint256 timestamp,bytes32 metadata,bytes32 builder)
 * `builder` is RektBull's builder code: Polymarket charges the builder fee
 * only on fills and pays it to the builder profile (programs/builders/fees).
 * A Deposit Wallet signs it wrapped as ERC-7739 TypedDataSign; a Session Key
 * adds its envelope on top (trading/session-keys).
 */
const crypto = require('crypto');
const { ethers } = require('ethers');
const { CHAIN_ID, WALLET_TYPES, exchangeFor } = require('./contracts');

const ZERO32 = '0x' + '00'.repeat(32);
const ORDER_TYPE = 'Order(uint256 salt,address maker,address signer,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint8 side,uint8 signatureType,uint256 timestamp,bytes32 metadata,bytes32 builder)';
const TYPES = {
  Order: [
    { name: 'salt', type: 'uint256' }, { name: 'maker', type: 'address' }, { name: 'signer', type: 'address' }, { name: 'tokenId', type: 'uint256' },
    { name: 'makerAmount', type: 'uint256' }, { name: 'takerAmount', type: 'uint256' }, { name: 'side', type: 'uint8' }, { name: 'signatureType', type: 'uint8' },
    { name: 'timestamp', type: 'uint256' }, { name: 'metadata', type: 'bytes32' }, { name: 'builder', type: 'bytes32' },
  ],
  TypedDataSign: [
    { name: 'contents', type: 'Order' }, { name: 'name', type: 'string' }, { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }, { name: 'salt', type: 'bytes32' },
  ],
};
const DOMAIN_TYPE = [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }];
const SESSION_MAGIC = '0x6492649264926492649264926492649264926492649264926492649264926492';

/** Tick size -> decimals for price, size and USD amount (the docs' table). */
const PRECISION = {
  '0.1': { price: 1, size: 2, amount: 3 }, '0.01': { price: 2, size: 2, amount: 4 }, '0.005': { price: 3, size: 2, amount: 5 },
  '0.0025': { price: 4, size: 2, amount: 6 }, '0.001': { price: 3, size: 2, amount: 5 }, '0.0001': { price: 4, size: 2, amount: 6 },
};
const ORDER_TYPES = { GTC: 'limit', GTD: 'limit', FOK: 'market', FAK: 'market' };

class OrderRefused extends Error {
  constructor(message, code = 'order_refused') { super(message); this.status = 422; this.code = code; this.isOrderRefused = true; }
}

/** A decimal string as an integer with `decimals` places, refusing more precision than that. */
function scaled(value, decimals, name) {
  const s = String(value ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new OrderRefused(`${name} must be a positive number`);
  const [whole, frac = ''] = s.split('.');
  if (frac.length > decimals && /[1-9]/.test(frac.slice(decimals))) throw new OrderRefused(`${name} can have at most ${decimals} decimal places here`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0');
}
/** As above, but rounding extra decimals down. */
function scaledDown(value, decimals, name) {
  const s = String(value ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new OrderRefused(`${name} must be a positive number`);
  const [whole, frac = ''] = s.split('.');
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0');
}
const unscale = (v, decimals) => { const s = v.toString().padStart(decimals + 1, '0'); const f = s.slice(-decimals).replace(/0+$/, ''); return s.slice(0, -decimals) + (f ? '.' + f : ''); };
const E6 = 6;

function precisionFor(tick) {
  const p = PRECISION[String(Number(tick))];
  if (!p) throw new OrderRefused(`Polymarket reports a tick size of ${tick} for this market, which RektBull doesn't know how to round for: no order is prepared`);
  return p;
}

/** The price as an integer in 1e6, checked against the market's tick size. */
function checkedPrice(price, tick) {
  const p = precisionFor(tick);
  const v = scaled(price, p.price, 'The price') * 10n ** BigInt(E6 - p.price);
  const t = scaled(String(Number(tick)), E6, 'tick size');
  if (v % t !== 0n) throw new OrderRefused(`The price must be a multiple of this market's tick size (${tick})`);
  if (v < t || v > 1000000n - t) throw new OrderRefused(`The price must be between ${tick} and ${unscale(1000000n - t, E6)}`);
  return v;
}

/**
 * A limit order's amounts (6-decimal integers): BUY pays price × size USD for
 * `size` shares; SELL gives `size` shares for price × size USD.
 */
function limitAmounts({ side, price, size, tick, minSize }) {
  const p = precisionFor(tick);
  const priceE6 = checkedPrice(price, tick);
  const sizeE6 = scaledDown(size, p.size, 'The number of shares') * 10n ** BigInt(E6 - p.size);
  if (sizeE6 < scaled(String(minSize), E6, 'minimum size')) throw new OrderRefused(`This market's smallest order is ${minSize} shares`);
  // price has at most (amount − 2) decimals and size 2, so the product is exact at the table's amount decimals.
  const usdE6 = priceE6 * sizeE6 / 1000000n;
  return side === 'BUY'
    ? { makerAmount: usdE6.toString(), takerAmount: sizeE6.toString(), price: unscale(priceE6, E6), shares: unscale(sizeE6, E6), notional_usd: Number(usdE6) / 1e6 }
    : { makerAmount: sizeE6.toString(), takerAmount: usdE6.toString(), price: unscale(priceE6, E6), shares: unscale(sizeE6, E6), notional_usd: Number(usdE6) / 1e6 };
}

/**
 * The worst price a market order would reach in this book: for a BUY of
 * `usd`, walk the asks up; for a SELL of `shares`, walk the bids down.
 * { price, filled: whether the book covers it all, best }.
 */
function marketPrice(book, side, { usd, shares }) {
  const levels = side === 'BUY' ? book.asks : book.bids; // presentBook sorted them best first
  if (!levels?.length) throw new OrderRefused(`There are no ${side === 'BUY' ? 'sellers' : 'buyers'} in this market's book right now`);
  let acc = 0; let last = levels[0].price;
  for (const l of levels) {
    last = l.price;
    acc += side === 'BUY' ? l.price * l.size : l.size;
    if (acc >= (side === 'BUY' ? usd : shares)) return { price: last, filled: true, best: levels[0].price };
  }
  return { price: last, filled: false, best: levels[0].price };
}

/**
 * A market order's amounts. BUY: makerAmount is the USD to spend and
 * takerAmount = makerAmount ÷ the maximum price, rounded down. SELL:
 * makerAmount is the shares and takerAmount = shares × the minimum price.
 */
function marketAmounts({ side, usd, shares, limitPrice, tick, minSize }) {
  const p = precisionFor(tick);
  const priceE6 = checkedPrice(limitPrice, tick);
  const min = scaled(String(minSize), E6, 'minimum size');
  if (side === 'BUY') {
    const usdE6 = scaledDown(usd, p.size, 'The amount') * 10n ** BigInt(E6 - p.size);
    if (usdE6 <= 0n) throw new OrderRefused('The amount is too small');
    const unit = 10n ** BigInt(E6 - p.amount);
    const sharesE6 = (usdE6 * 1000000n / priceE6) / unit * unit;
    if (sharesE6 < min) throw new OrderRefused(`This market's smallest order is ${minSize} shares: at ${unscale(priceE6, E6)} that is about $${(Number(min) / 1e6 * Number(priceE6) / 1e6).toFixed(2)}`);
    // The order's own price must stay under the maximum plus the finest tick, or it could cross a higher ask.
    if (usdE6 * 1000000n >= (priceE6 + 100n) * sharesE6) throw new OrderRefused('At this amount the rounding would push the order past your maximum price: use a larger amount or a limit order');
    return { makerAmount: usdE6.toString(), takerAmount: sharesE6.toString(), price: unscale(priceE6, E6), shares: unscale(sharesE6, E6), notional_usd: Number(usdE6) / 1e6 };
  }
  const sharesE6 = scaledDown(shares, p.size, 'The number of shares') * 10n ** BigInt(E6 - p.size);
  if (sharesE6 < min) throw new OrderRefused(`This market's smallest order is ${minSize} shares`);
  const usdE6 = sharesE6 * priceE6 / 1000000n;
  return { makerAmount: sharesE6.toString(), takerAmount: usdE6.toString(), price: unscale(priceE6, E6), shares: unscale(sharesE6, E6), notional_usd: Number(usdE6) / 1e6 };
}

/**
 * The fees on an order of `notional` USD at `price`, if all of it fills:
 * Polymarket's own taker fee (shares × rate × p × (1 − p)) and RektBull's
 * builder fee (notional × bps / 10000). Both are charged by Polymarket, on
 * fills only. A resting limit order pays the maker rates instead.
 */
function fees({ notionalUsd, price, platformFee, takerBps, makerBps }) {
  const r5 = x => Math.round(x * 1e5) / 1e5;
  const rate = platformFee?.rate || 0; const exp = platformFee?.exponent || 1;
  const shares = price > 0 ? notionalUsd / price : 0;
  return {
    as_taker: { polymarket_usd: r5(shares * rate * (price * (1 - price)) ** exp), rektbull_usd: r5(notionalUsd * takerBps / 10000), rektbull_bps: takerBps },
    as_maker: { polymarket_usd: platformFee && platformFee.taker_only === false ? null : 0, rektbull_usd: r5(notionalUsd * makerBps / 10000), rektbull_bps: makerBps },
  };
}

/** The most USD notional a market buy may carry so that notional plus taker fees stays within `budget`. */
function notionalWithin(budget, { price, platformFee, takerBps }) {
  const rate = platformFee?.rate || 0; const exp = platformFee?.exponent || 1;
  const perUsd = (price > 0 ? rate * (price * (1 - price)) ** exp / price : 0) + takerBps / 10000;
  return Math.floor(budget / (1 + perUsd) * 100) / 100;
}

const salt = () => String(crypto.randomInt(1, 2 ** 48 - 1)); // within Number.MAX_SAFE_INTEGER: the request body carries it as a JSON number

/** The order struct for a wallet of `walletType` (maker), signed by `signer` (the account's key). */
function orderStruct({ walletType, wallet, signer, assetId, side, makerAmount, takerAmount, builder, now = Date.now() }) {
  const type = WALLET_TYPES[walletType];
  if (!type) throw new OrderRefused(`wallet_type must be one of: ${Object.keys(WALLET_TYPES).join(', ')}`);
  return {
    salt: salt(), maker: ethers.getAddress(wallet), signer: ethers.getAddress(type.signer_is_wallet ? wallet : signer), tokenId: String(assetId),
    makerAmount: String(makerAmount), takerAmount: String(takerAmount), side: side === 'BUY' ? 0 : 1, signatureType: type.signature_type,
    timestamp: String(now), metadata: ZERO32, builder: builder || ZERO32,
  };
}

/** The EIP-712 payload a wallet signs for this order (eth_signTypedData_v4). */
function typedData(order, book) {
  const domain = { name: 'Polymarket CTF Exchange', ...exchangeFor(book), chainId: CHAIN_ID };
  if (order.signatureType === 3) {
    return {
      domain, primaryType: 'TypedDataSign', types: { EIP712Domain: DOMAIN_TYPE, Order: TYPES.Order, TypedDataSign: TYPES.TypedDataSign },
      message: { contents: order, name: 'DepositWallet', version: '1', chainId: CHAIN_ID, verifyingContract: order.maker, salt: ZERO32 },
    };
  }
  return { domain, primaryType: 'Order', types: { EIP712Domain: DOMAIN_TYPE, Order: TYPES.Order }, message: order };
}

/** The digest a key signs for `td` (what eth_signTypedData_v4 hashes). */
function digest(td) {
  const { EIP712Domain, ...types } = td.types;
  if (td.primaryType === 'Order') delete types.TypedDataSign;
  return ethers.TypedDataEncoder.hash(td.domain, types, td.message);
}

/**
 * What a Deposit Wallet's order signature carries after the key's own 65
 * bytes (ERC-7739): the exchange's domain separator, the order's struct
 * hash, the Order type string and its length. Hex without 0x, to append.
 */
function depositWalletSuffix(td) {
  const appDomainSeparator = ethers.TypedDataEncoder.hashDomain(td.domain);
  const contentsHash = ethers.TypedDataEncoder.hashStruct('Order', { Order: TYPES.Order }, td.message.contents);
  return ethers.concat([appDomainSeparator, contentsHash, ethers.toUtf8Bytes(ORDER_TYPE), ethers.toBeHex(ORDER_TYPE.length, 2)]).slice(2);
}
const wrapDepositWalletSignature = (td, innerSignature) => innerSignature + depositWalletSuffix(td);

/** A Session Key's envelope around a Deposit Wallet order signature (trading/session-keys, step 5). */
function sessionEnvelope(sessionSigner, depositWalletSignature) {
  const payload = ethers.AbiCoder.defaultAbiCoder().encode(['bytes32', 'bytes32', 'bytes'], [ethers.zeroPadValue(sessionSigner, 32), ZERO32, depositWalletSignature]);
  return ethers.concat([payload, SESSION_MAGIC]);
}

/**
 * The body of POST https://clob.polymarket.com/order. `signature` and `owner`
 * (the CLOB API key) are filled in where the order is sent: the user's
 * browser, or the trade service for a Session Key.
 */
function requestBody(order, { orderType, expiration = '0', postOnly = false, signature = '', owner = '' }) {
  return {
    deferExec: false,
    order: {
      builder: order.builder, expiration: String(expiration), maker: order.maker, makerAmount: order.makerAmount, metadata: order.metadata,
      salt: Number(order.salt), side: order.side === 0 ? 'BUY' : 'SELL', signature, signatureType: order.signatureType, signer: order.signer,
      takerAmount: order.takerAmount, timestamp: order.timestamp, tokenId: order.tokenId,
    },
    orderType, owner, ...(postOnly ? { postOnly: true } : {}),
  };
}

/**
 * Everything for one order from what the user asked: checked against the
 * book's tick size and minimum, priced for a market order, with its fees.
 *   limit (GTC, GTD): { side, price, size }, GTD with expires_in_seconds
 *   market (FAK, FOK): BUY { amount_usd } (all-in: fees fit inside it), SELL { size }
 */
function build(input, { book, platformFee = null, builder, takerBps, makerBps, walletType, wallet, signer, now = Date.now() }) {
  const side = String(input.side || '').toUpperCase();
  if (side !== 'BUY' && side !== 'SELL') throw new OrderRefused('side must be BUY or SELL');
  const orderType = String(input.order_type || 'GTC').toUpperCase();
  const kind = ORDER_TYPES[orderType];
  if (!kind) throw new OrderRefused(`order_type must be one of: ${Object.keys(ORDER_TYPES).join(', ')}`);
  const tick = book.tick_size; const minSize = book.min_order_size;
  let amounts; let expiration = '0'; let market = null;
  if (kind === 'limit') {
    amounts = limitAmounts({ side, price: input.price, size: input.size, tick, minSize });
    if (orderType === 'GTD') {
      const secs = Math.floor(Number(input.expires_in_seconds));
      // Polymarket expires a GTD order a minute early and refuses one expiring within 3 minutes.
      if (!(secs >= 120 && secs <= 365 * 86400)) throw new OrderRefused('A Good Till Date order must stay open for at least 2 minutes');
      expiration = String(Math.floor(now / 1000) + 60 + secs);
    }
  } else {
    const slip = Math.min(50, Math.max(0, input.max_slippage_pct === undefined ? 3 : Number(input.max_slippage_pct)));
    const p = precisionFor(tick);
    let usd;
    if (side === 'BUY') {
      const budget = Number(input.amount_usd);
      if (!(budget > 0)) throw new OrderRefused('amount_usd must be above 0');
      const first = marketPrice(book, side, { usd: budget });
      usd = notionalWithin(budget, { price: first.price, platformFee, takerBps });
    } else if (!(Number(input.size) > 0)) throw new OrderRefused('size (shares to sell) must be above 0');
    market = marketPrice(book, side, side === 'BUY' ? { usd } : { shares: Number(input.size) });
    if (!market.filled && orderType === 'FOK') throw new OrderRefused('The book can\'t fill all of this right now, so a Fill or Kill order would be cancelled. Use Fill and Kill to take what is there, or a limit order.', 'not_enough_liquidity');
    const moved = Math.abs(market.price - market.best) / market.best * 100;
    if (moved > slip) throw new OrderRefused(`Filling this would move the price ${moved.toFixed(1)}% past the best ${side === 'BUY' ? 'ask' : 'bid'} (${market.best}), more than your ${slip}% limit. Use a smaller amount or a limit order.`, 'price_impact');
    amounts = marketAmounts({ side, usd: usd?.toFixed(p.size), shares: input.size, limitPrice: market.price.toFixed(p.price), tick, minSize });
  }
  const order = orderStruct({ walletType, wallet, signer, assetId: book.asset_id, side, makerAmount: amounts.makerAmount, takerAmount: amounts.takerAmount, builder, now });
  const td = typedData(order, book);
  const price = Number(amounts.price);
  return {
    order, typed_data: td, signature_suffix: order.signatureType === 3 ? depositWalletSuffix(td) : '',
    body: requestBody(order, { orderType, expiration, postOnly: kind === 'limit' && !!input.post_only }),
    summary: {
      side, order_type: orderType, kind, price, shares: Number(amounts.shares), notional_usd: amounts.notional_usd, expiration: expiration === '0' ? null : Number(expiration),
      ...(market ? { worst_price: market.price, best_price: market.best, book_covers_it: market.filled } : {}),
      fees: fees({ notionalUsd: amounts.notional_usd, price, platformFee, takerBps, makerBps }),
    },
  };
}

module.exports = {
  ORDER_TYPE, TYPES, PRECISION, ORDER_TYPES, ZERO32, SESSION_MAGIC, OrderRefused,
  limitAmounts, marketAmounts, marketPrice, fees, notionalWithin, orderStruct, typedData, digest,
  depositWalletSuffix, wrapDepositWalletSignature, sessionEnvelope, requestBody, build, checkedPrice,
};
