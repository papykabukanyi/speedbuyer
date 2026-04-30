/**
 * Nike product scraper
 * Primary  : extracts __NEXT_DATA__ JSON embedded in the page
 * Secondary: JSON-LD structured data
 * Fallback : basic Open Graph / HTML meta tags
 */
const axios   = require('axios');
const cheerio = require('cheerio');

const HEADERS = {
  'User-Agent'               : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept'                   : 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language'          : 'en-US,en;q=0.9',
  'Accept-Encoding'          : 'gzip, deflate, br',
  'Cache-Control'            : 'no-cache',
  'Sec-Fetch-Dest'           : 'document',
  'Sec-Fetch-Mode'           : 'navigate',
  'Sec-Fetch-Site'           : 'none',
  'Upgrade-Insecure-Requests': '1',
};

async function scrapeNikeProduct(url) {
  let response;
  try {
    response = await axios.get(url, { headers: HEADERS, timeout: 20000, maxRedirects: 5 });
  } catch (err) {
    const status = err.response?.status;
    if (status === 403) throw new Error('Nike returned 403 – try again in a few minutes');
    if (status === 404) throw new Error('Product not found (404) – check the URL');
    throw new Error(`Network error: ${err.message}`);
  }

  const $ = cheerio.load(response.data);

  // Detect CAPTCHA / access-denied pages
  const title = $('title').text().toLowerCase();
  if (title.includes('access denied') || title.includes('robot') || title.includes('captcha')) {
    throw new Error('Nike served a bot-check page. Wait a few minutes and try again.');
  }

  // ── Primary: __NEXT_DATA__ ──────────────────────────────────────────────────
  const nextRaw = $('#__NEXT_DATA__').html();
  if (nextRaw) {
    try {
      const nextData = JSON.parse(nextRaw);
      const product  = parseNextData(nextData, url);
      if (product) return product;
    } catch {}
  }

  // ── Secondary: JSON-LD ──────────────────────────────────────────────────────
  let jsonLd = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const d = JSON.parse($(el).html());
      if (d['@type'] === 'Product') jsonLd = d;
    } catch {}
  });
  if (jsonLd) return parseJsonLd(jsonLd, url);

  // ── Fallback: OG / basic HTML ───────────────────────────────────────────────
  const fallback = parseFallback($, url);

  // If name still unknown, derive it from the URL slug (reliable for Nike URLs)
  if (!fallback.name || fallback.name === 'Unknown Product') {
    fallback.name = nameFromSlug(url);
  }

  return fallback;
}

// Converts "/t/mind-001-mens-pregame-mules-XXXX/HQ4307-400" → "Nike Mind 001 Men's Pregame Mules"
function nameFromSlug(url) {
  try {
    const m = new URL(url).pathname.match(/\/t\/([^/]+)\//);
    if (!m) return 'Nike Product';
    // Remove the random suffix (last hyphen-segment that's 6–10 chars of mixed case/numbers)
    const slug   = m[1].replace(/-[A-Za-z0-9]{6,10}$/, '');
    const words  = slug.split('-').map(w => {
      if (w === 'mens')   return "Men's";
      if (w === 'womens') return "Women's";
      if (w === 'kids')   return "Kids'";
      return w.charAt(0).toUpperCase() + w.slice(1);
    });
    return 'Nike ' + words.join(' ');
  } catch {
    return 'Nike Product';
  }
}

// ── __NEXT_DATA__ parser ──────────────────────────────────────────────────────
function parseNextData(data, url) {
  try {
    const pageProps = data?.props?.pageProps;
    if (!pageProps) return null;

    // Path A – initialState.Threads (common on product pages)
    const threads = pageProps?.initialState?.Threads;
    if (threads) {
      const prodMap = threads?.products?.products || threads?.products || {};
      const keys    = Object.keys(prodMap);
      if (keys.length > 0) return formatProduct(prodMap[keys[0]], url, data);
    }

    // Path B – direct product / productInfo
    const direct = pageProps?.product || pageProps?.productInfo;
    if (direct) return formatProduct(direct, url, data);

    // Path C – componentProps.productCard
    const card = pageProps?.componentProps?.productCard;
    if (card) return formatProduct(card, url, data);

    // Path D – deep search for "currentPrice" key
    const found = deepFind(data, 'currentPrice');
    if (found) return formatProduct(found, url, data);

    return null;
  } catch {
    return null;
  }
}

function deepFind(obj, key, depth = 0) {
  if (depth > 6 || !obj || typeof obj !== 'object') return null;
  if (key in obj) return obj;
  for (const v of Object.values(obj)) {
    const result = deepFind(v, key, depth + 1);
    if (result) return result;
  }
  return null;
}

function formatProduct(prod, url, root) {
  if (!prod) return null;

  const skus = prod.skus || prod.availableSkus || [];
  const sizes = skus
    .map(s => ({
      size     : s.nikeSize || s.localizedSize || s.skuDescription || s.size,
      available: s.available !== false,
      level    : s.level || 'AVAILABLE',
    }))
    .filter(s => s.size);

  const availCount = sizes.filter(s => s.available).length;

  const name = prod.title || prod.name || prod.fullTitle || nameFromSlug(url);
  const releaseDate = extractReleaseDate(prod, root);

  return {
    name,
    price        : prod.currentPrice ?? prod.fullPrice ?? prod.price ?? null,
    originalPrice: prod.fullPrice ?? null,
    currency     : prod.currency || 'USD',
    inStock      : availCount > 0 || prod.inStock === true,
    availableSizes: sizes,
    image        : prod.imageUrl || prod.heroImage || prod.images?.[0]?.src || null,
    colorway     : prod.colorDescription || prod.colorway || null,
    styleCode    : prod.styleColor || prod.productCode || extractStyleCode(url),
    releaseDate,
    url,
    lastChecked  : new Date().toISOString(),
  };
}

// ── JSON-LD parser ────────────────────────────────────────────────────────────
function parseJsonLd(data, url) {
  const offer = Array.isArray(data.offers) ? data.offers[0] : data.offers;
  return {
    name          : data.name || nameFromSlug(url),
    price         : offer?.price ? parseFloat(offer.price) : null,
    originalPrice : null,
    currency      : offer?.priceCurrency || 'USD',
    inStock       : offer?.availability?.includes('InStock') ?? false,
    availableSizes: [],
    image         : Array.isArray(data.image) ? data.image[0] : data.image || null,
    colorway      : null,
    styleCode     : extractStyleCode(url),
    releaseDate   : extractReleaseDate(data, null),
    url,
    lastChecked   : new Date().toISOString(),
  };
}

// ── Fallback HTML parser ──────────────────────────────────────────────────────
function parseFallback($, url) {
  const name       = $('h1').first().text().trim() || $('title').text().trim() || 'Unknown Product';
  const ogImage    = $('meta[property="og:image"]').attr('content') || null;
  const priceText  = $('[data-testid="currentPrice-container"]').text() || $('[class*="price"]').first().text();
  const price      = priceText ? parseFloat(priceText.replace(/[^0-9.]/g, '')) || null : null;
  const releaseDate = extractReleaseDateFromHtml($);

  return {
    name,
    price,
    originalPrice : null,
    currency      : 'USD',
    inStock       : !$('[data-testid="soldout"]').length,
    availableSizes: [],
    image         : ogImage,
    colorway      : null,
    styleCode     : extractStyleCode(url),
    releaseDate,
    url,
    lastChecked   : new Date().toISOString(),
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function extractStyleCode(url) {
  const m = url.match(/\/([A-Z0-9]+-[A-Z0-9]+)\/?(\?.*)?$/);
  return m?.[1] || null;
}

function normalizeDate(value) {
  if (!value) return null;
  if (value instanceof Date) return isNaN(value) ? null : value.toISOString();
  if (typeof value === 'number') {
    const ms = value < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    return isNaN(d) ? null : d.toISOString();
  }
  if (typeof value === 'string') {
    const v = value.trim();
    if (!v) return null;
    if (/^\d{10,13}$/.test(v)) return normalizeDate(Number(v));
    const d = new Date(v);
    return isNaN(d) ? null : d.toISOString();
  }
  return null;
}

const RELEASE_DATE_KEYS = [
  'startSellDate',
  'startSellDateUtc',
  'startSellDateUTC',
  'startSellDateLocal',
  'launchDate',
  'availableDate',
  'releaseDate',
  'firstAvailableDate',
  'commerceStartDate',
  'startDate',
  'availabilityStarts',
  'availabilityStartsDate',
];

function extractReleaseDate(obj, root) {
  const direct = findReleaseDate(obj, 0);
  if (direct) return direct;
  return root ? findReleaseDate(root, 0) : null;
}

function findReleaseDate(obj, depth) {
  if (!obj || typeof obj !== 'object' || depth > 6) return null;

  for (const key of RELEASE_DATE_KEYS) {
    if (obj[key]) {
      const n = normalizeDate(obj[key]);
      if (n) return n;
    }
  }

  for (const val of Object.values(obj)) {
    const found = findReleaseDate(val, depth + 1);
    if (found) return found;
  }
  return null;
}

function extractReleaseDateFromHtml($) {
  const metaDate = normalizeDate(
    $('meta[property="product:release_date"]').attr('content') ||
    $('meta[name="release_date"]').attr('content') ||
    $('meta[property="product:availability_starts"]').attr('content') ||
    ''
  );
  if (metaDate) return metaDate;

  const selectors = [
    '[data-testid="launch-date"]',
    '[data-testid="product-launch-date"]',
    '[data-testid="available-date"]',
  ];

  for (const sel of selectors) {
    const txt = $(sel).first().text().trim();
    if (!txt) continue;
    const cleaned = txt.replace(/^available\s*/i, '').trim();
    const parsed = normalizeDate(cleaned);
    if (parsed) return parsed;
  }

  return null;
}

/**
 * Follow redirect chain (e.g. nike.sng.link → www.nike.com/t/...)
 * Returns the final URL after all redirects.
 */
async function resolveUrl(url) {
  try {
    const res = await axios.get(url, {
      headers     : HEADERS,
      maxRedirects: 10,
      timeout     : 15000,
    });
    // follow-redirects (used by axios) exposes the final URL here
    const finalUrl =
      res.request?.res?.responseUrl   ||   // Node.js http
      res.request?.responseURL         ||   // XMLHttpRequest compat
      res.config?.url                  ||
      url;
    return finalUrl;
  } catch (err) {
    // Even on a 4xx/5xx we might have followed redirects
    const finalUrl =
      err.request?.res?.responseUrl ||
      err.request?.responseURL      ||
      url;
    return finalUrl;
  }
}

module.exports = { scrapeNikeProduct, resolveUrl };
