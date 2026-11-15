/**
 * Base58 (Bitcoin's alphabet), the way Solana writes addresses and
 * signatures. Small enough to keep here rather than add a dependency.
 */
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const INDEX = Object.fromEntries([...ALPHABET].map((c, i) => [c, BigInt(i)]));

/** Bytes from base58 text; throws on a character outside the alphabet. */
function decode(text) {
  const s = String(text);
  let n = 0n;
  for (const c of s) {
    if (!(c in INDEX)) throw new Error('not base58');
    n = n * 58n + INDEX[c];
  }
  const out = [];
  while (n > 0n) { out.unshift(Number(n & 0xffn)); n >>= 8n; }
  let zeros = 0;
  while (zeros < s.length && s[zeros] === '1') zeros++;
  return Buffer.from([...new Array(zeros).fill(0), ...out]);
}

function encode(bytes) {
  const b = Buffer.from(bytes);
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  let out = '';
  while (n > 0n) { out = ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  let zeros = 0;
  while (zeros < b.length && b[zeros] === 0) zeros++;
  return '1'.repeat(zeros) + out;
}

/** True when text is a Solana address: base58 for exactly 32 bytes, written the canonical way. */
function isSolanaAddress(text) {
  if (typeof text !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text)) return false;
  try {
    const b = decode(text);
    return b.length === 32 && encode(b) === text;
  } catch {
    return false;
  }
}

module.exports = { decode, encode, isSolanaAddress };
