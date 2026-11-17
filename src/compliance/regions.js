/**
 * Region blocks per trading venue, set in the admin panel (docs/ADMIN.md).
 *
 * Each venue starts with no blocked countries. An admin can list countries
 * (ISO 3166-1 alpha-2 codes, such as US) for a venue, with a reason, and the
 * change is logged like every other admin change (admin_settings key
 * `regions:<venue>`). A block applies to opening trades and to approvals,
 * never to reading data, and never to closing a position or cancelling an
 * order: a user can always get out.
 *
 * The country comes from ONE request header, named by GEO_COUNTRY_HEADER and
 * set by the load balancer in front of the app (for example Google Cloud's
 * `X-Client-Geo-Location: {client_region}`, or Cloudflare's `CF-IPCountry`).
 * No header is trusted unless it's named there, since a browser can send any
 * header it likes. When a venue has blocks and the country can't be told,
 * the request is refused: the block fails closed.
 */
const env = require('../config/env');
const settings = require('../admin/settings');

const VENUES = {
  hyperliquid: { name: 'Hyperliquid perps' },
  polymarket: { name: 'Polymarket' },
};

const key = venue => `regions:${venue}`;
const CODE = /^[A-Z]{2}$/;

/** The country the load balancer says the request comes from (two capital letters), or null. */
function countryOf(req) {
  const name = env.geoCountryHeader;
  if (!name) return null;
  const v = String(req.get?.(name) ?? req.headers?.[name.toLowerCase()] ?? '').trim().toUpperCase();
  return CODE.test(v) && v !== 'XX' && v !== 'T1' ? v : null; // XX: unknown; T1: Tor (Cloudflare)
}

/** The countries blocked for a venue (may be up to a minute old, like every admin setting). */
function countries(venue) {
  if (!VENUES[venue]) throw new Error(`unknown venue ${venue}`);
  const v = settings.get(key(venue));
  return Array.isArray(v?.countries) ? v.countries : [];
}

/**
 * Is trading on this venue blocked for this request?
 * Returns { blocked, country, reason }; reason is null when not blocked.
 */
function blockedFor(req, venue) {
  const list = countries(venue);
  const country = countryOf(req);
  if (!list.length) return { blocked: false, country, reason: null };
  const name = VENUES[venue].name;
  if (!country) {
    return { blocked: true, country: null, reason: `${name} trading isn't offered in some countries, and RektBull couldn't tell which country you're connecting from. You can still see markets and your positions, cancel orders and close positions.` };
  }
  if (list.includes(country)) {
    return { blocked: true, country, reason: `${name} trading isn't offered in your country (${country}). You can still see markets and your positions, cancel orders and close positions.` };
  }
  return { blocked: false, country, reason: null };
}

class RegionBlocked extends Error {
  constructor(reason) { super(reason); this.status = 451; this.code = 'region_blocked'; }
}

/** Throws RegionBlocked when blocked. */
function refuseIfBlocked(req, venue) {
  const r = blockedFor(req, venue);
  if (r.blocked) throw new RegionBlocked(r.reason);
  return r;
}

/** Checks an admin's list: unique two-letter codes, sorted. */
function checkList(list) {
  if (!Array.isArray(list)) throw Object.assign(new Error('countries must be a list of two-letter country codes, such as ["US"].'), { status: 400 });
  const out = [...new Set(list.map(c => String(c).trim().toUpperCase()))].filter(Boolean).sort();
  const badOnes = out.filter(c => !CODE.test(c));
  if (badOnes.length) throw Object.assign(new Error(`Not two-letter country codes: ${badOnes.join(', ')}.`), { status: 400 });
  if (out.length > 250) throw Object.assign(new Error('Too many countries.'), { status: 400 });
  return out;
}

async function set(venue, list, { wallet, reason }) {
  if (!VENUES[venue]) throw Object.assign(new Error('No such venue.'), { status: 404 });
  const out = checkList(list);
  await settings.set(key(venue), out.length ? { countries: out } : null, { wallet, action: out.length ? 'regions' : 'regions_none', reason });
  return { venue, countries: out };
}

/** For the admin panel: each venue's list, and what this request's header says. */
function adminList(req) {
  return {
    header: env.geoCountryHeader || null,
    your_country: countryOf(req),
    note: env.geoCountryHeader
      ? `The country is read from the ${env.geoCountryHeader} header, set by the load balancer.`
      : 'GEO_COUNTRY_HEADER isn\'t set, so RektBull can\'t tell anyone\'s country: if you block a country, everyone is blocked from trading on that venue. Set the load balancer to add a country header first (docs/ADMIN.md).',
    venues: Object.entries(VENUES).map(([id, v]) => ({ id, name: v.name, countries: countries(id) })),
  };
}

module.exports = { VENUES, countryOf, countries, blockedFor, refuseIfBlocked, RegionBlocked, checkList, set, adminList };
