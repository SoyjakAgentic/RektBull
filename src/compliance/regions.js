/**
 * Region blocks per trading venue, set in the admin panel (docs/ADMIN.md).
 *
 * Each venue starts with the places the venue itself bans (DEFAULTS, each with
 * its source). An admin can change a venue's list, with a reason, and the
 * change is logged like every other admin change (admin_settings key
 * `regions:<venue>`); "Back to the venue's list" removes the change. A list
 * holds countries (ISO 3166-1 alpha-2, such as US) and regions within one
 * (ISO 3166-2, such as CA-ON for Ontario).
 *
 * A block applies to opening trades and to approvals, never to reading data,
 * and never to closing a position, cancelling an order or taking money out:
 * a user can always get out.
 *
 * The country comes from ONE request header, named by GEO_COUNTRY_HEADER and
 * set by the load balancer in front of the app (for example Google Cloud's
 * `X-Client-Geo-Location: {client_region}`, or Cloudflare's `CF-IPCountry`);
 * the region within it from GEO_SUBDIVISION_HEADER where one is set up. No
 * header is trusted unless it's named there, since a browser can send any
 * header it likes. When a venue has blocks and the country can't be told, the
 * request is refused; when a list names regions of the user's country and the
 * region can't be told, the request is refused too. Blocks fail closed.
 */
const env = require('../config/env');
const settings = require('../admin/settings');

/**
 * What each venue bans, read 17 November 2026.
 * Hyperliquid: its Terms of Use restrict the United States and Ontario, and
 * sanctioned jurisdictions without naming them; the sanctioned list here is the
 * places under comprehensive US sanctions (OFAC): Cuba, Iran, North Korea,
 * Syria, and Crimea, Donetsk and Luhansk.
 * Polymarket: docs.polymarket.com/api-reference/geoblock, blocked and
 * close-only alike (close-only matches what a block here does: no new
 * positions, closing allowed), including the countries its own site limits.
 */
const SANCTIONED = ['CU', 'IR', 'KP', 'SY', 'UA-43', 'UA-14', 'UA-09'];
const DEFAULTS = {
  hyperliquid: {
    countries: ['US', 'CA-ON', ...SANCTIONED],
    source: 'Hyperliquid Terms of Use (United States, Ontario, sanctioned jurisdictions); sanctioned places per OFAC comprehensive sanctions',
  },
  polymarket: {
    countries: [...SANCTIONED,
      'AR', 'AU', 'BY', 'BE', 'BI', 'BR', 'CA-BC', 'CA-ON', 'CA-AB', 'CA-QC', 'CF', 'CD', 'ET', 'FR', 'DE', 'IQ', 'IT', 'LB', 'LY', 'MM', 'NZ', 'NI',
      'PL', 'RU', 'SG', 'SO', 'SK', 'SS', 'SD', 'TW', 'TH', 'GB', 'US', 'UM', 'VE', 'YE', 'ZW',
      'IE', 'JP', 'NL', 'KR'],
    source: 'docs.polymarket.com/api-reference/geoblock (blocked, close-only, and close-only on its own site)',
  },
};

const VENUES = {
  hyperliquid: { name: 'Hyperliquid perps' },
  polymarket: { name: 'Polymarket' },
};

const key = venue => `regions:${venue}`;
const CODE = /^[A-Z]{2}(-[A-Z0-9]{1,3})?$/;
const COUNTRY = /^[A-Z]{2}$/;

const header = (req, name) => (name ? String(req.get?.(name) ?? req.headers?.[name.toLowerCase()] ?? '').trim().toUpperCase() : '');

/** Where the load balancer says the request comes from: { country, region } (region as CC-XX), each or both null. */
function locate(req) {
  const c = header(req, env.geoCountryHeader);
  const country = COUNTRY.test(c) && c !== 'XX' && c !== 'T1' ? c : null; // XX: unknown; T1: Tor (Cloudflare)
  let region = null;
  const s = header(req, env.geoSubdivisionHeader).replace(/[^A-Z0-9-]/g, '');
  if (country && s) {
    if (/^[A-Z]{2}-[A-Z0-9]{1,3}$/.test(s)) region = s.startsWith(country + '-') ? s : null; // CA-ON
    else if (s.startsWith(country) && s.length > 2 && s.length <= 5) region = `${country}-${s.slice(2)}`; // CAON (Google's client_region_subdivision)
    else if (/^[A-Z0-9]{1,3}$/.test(s)) region = `${country}-${s}`; // ON (Cloudflare's region code)
  }
  return { country, region };
}
const countryOf = req => locate(req).country;

/** The venue's list: the admin's, or the venue's own. */
function countries(venue) {
  if (!VENUES[venue]) throw new Error(`unknown venue ${venue}`);
  const v = settings.get(key(venue));
  return Array.isArray(v?.countries) ? v.countries : DEFAULTS[venue].countries;
}

/**
 * Is trading on this venue blocked for this request?
 * Returns { blocked, country, region, reason }; reason is null when not blocked.
 */
function blockedFor(req, venue) {
  const list = countries(venue);
  const { country, region } = locate(req);
  const out = (blocked, reason = null) => ({ blocked, country, region, reason });
  if (!list.length) return out(false);
  const name = VENUES[venue].name;
  const still = 'You can still see markets and your positions, cancel orders, close positions and take money out.';
  if (!country) return out(true, `${name} trading isn't offered in some countries, and RektBull couldn't tell which country you're connecting from. ${still}`);
  if (list.includes(country)) return out(true, `${name} trading isn't offered in your country (${country}). ${still}`);
  const regions = list.filter(c => c.startsWith(country + '-'));
  if (regions.length) {
    if (!region) return out(true, `${name} trading isn't offered in some parts of your country (${regions.join(', ')}), and RektBull couldn't tell which part you're connecting from. ${still}`);
    if (regions.includes(region)) return out(true, `${name} trading isn't offered where you are (${region}). ${still}`);
  }
  return out(false);
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

/** Checks an admin's list: unique codes (US, or CA-ON for a region), sorted. */
function checkList(list) {
  if (!Array.isArray(list)) throw Object.assign(new Error('countries must be a list of country codes, such as ["US", "CA-ON"].'), { status: 400 });
  const out = [...new Set(list.map(c => String(c).trim().toUpperCase()))].filter(Boolean).sort();
  const badOnes = out.filter(c => !CODE.test(c));
  if (badOnes.length) throw Object.assign(new Error(`Not country codes (US) or region codes (CA-ON): ${badOnes.join(', ')}.`), { status: 400 });
  if (out.length > 300) throw Object.assign(new Error('Too many countries.'), { status: 400 });
  return out;
}

/** Sets a venue's list (an empty list means no blocks). `null` goes back to the venue's own list. */
async function set(venue, list, { wallet, reason }) {
  if (!VENUES[venue]) throw Object.assign(new Error('No such venue.'), { status: 404 });
  if (list === null) {
    await settings.set(key(venue), null, { wallet, action: 'regions_default', reason });
    return { venue, countries: countries(venue), default: true };
  }
  const out = checkList(list);
  await settings.set(key(venue), { countries: out }, { wallet, action: 'regions', reason });
  return { venue, countries: out, default: false };
}

/** For the admin panel: each venue's list, the venue's own list, and what this request's headers say. */
function adminList(req) {
  const here = locate(req);
  return {
    header: env.geoCountryHeader || null,
    subdivision_header: env.geoSubdivisionHeader || null,
    your_country: here.country, your_region: here.region,
    note: env.geoCountryHeader
      ? `The country is read from the ${env.geoCountryHeader} header${env.geoSubdivisionHeader ? `, the region from ${env.geoSubdivisionHeader}` : ' (no region header is set, so a list naming regions of a country blocks that whole country)'}, set by the load balancer.`
      : 'GEO_COUNTRY_HEADER isn\'t set, so RektBull can\'t tell anyone\'s country: every venue with blocks is blocked for everyone. Set the load balancer to add a country header first (docs/ADMIN.md).',
    venues: Object.entries(VENUES).map(([id, v]) => {
      const changed = Array.isArray(settings.get(key(id))?.countries);
      return { id, name: v.name, countries: countries(id), changed, venue_list: DEFAULTS[id].countries, venue_list_source: DEFAULTS[id].source };
    }),
  };
}

module.exports = { VENUES, DEFAULTS, locate, countryOf, countries, blockedFor, refuseIfBlocked, RegionBlocked, checkList, set, adminList };
