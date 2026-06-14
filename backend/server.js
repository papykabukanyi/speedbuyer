require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const express  = require('express');

const http     = require('http');

const { Server } = require('socket.io');

const cors     = require('cors');

const { v4: uuid } = require('uuid');

const path     = require('path');

const axios    = require('axios');
const cheerio  = require('cheerio');



const storage  = require('./storage');
const checkoutStore = require('./checkoutStore');

const monitor  = require('./monitor');

const { scrapeProduct, resolveUrl } = require('./scraper');

const DISCOVERY_SOURCES = [
  { name: 'Nike Launch', url: 'https://www.nike.com/launch', maxProducts: 8 },
  { name: 'Adidas Confirmed', url: 'https://www.adidas.com/us/confirmed', maxProducts: 6 },
  { name: 'Foot Locker New Arrivals', url: 'https://www.footlocker.com/category/new-arrivals.html', maxProducts: 6 },
  { name: 'StockX Sneakers', url: 'https://stockx.com/sneakers', maxProducts: 6 },
  { name: 'GOAT Sneakers', url: 'https://www.goat.com/sneakers', maxProducts: 6 },
];

const DISCOVERY_INTERVAL_MINUTES = 120;
const DISCOVERY_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
};



// Supported release site hostnames
const ALLOWED_HOSTS = [
  'nike.com', 'nike.sng.link', 'nikerunning.app.link',
  'adidas.com', 'adidas.eu',
  'stockx.com', 'goat.com',
  'footlocker.com', 'eastbay.com', 'champssports.com',
  'finishline.com', 'stadiumgoods.com', 'supremenewyork.com',
];



const app    = express();

const server = http.createServer(app);

const io     = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

const PORT   = process.env.PORT || 3001;

function defaultPurchasePlan() {

  return {
    enabled: false,
    useReleaseTime: true,
    targetTime: null,
    checkEveryMinutes: 30,
    sizeQuantities: [],
    lastScheduledCheckAt: null,
    resolvedTargetTime: null,
    readyAlertSent: false,
  };

}

function normalizeIsoDate(value) {

  if (!value) return null;
  const date = new Date(value);
  return isNaN(date) ? null : date.toISOString();

}

function sanitizeSizeQuantities(list) {

  if (!Array.isArray(list)) return [];
  return list
    .map(entry => ({
      size: String(entry?.size || '').trim(),
      quantity: Math.max(1, Math.min(10, parseInt(entry?.quantity) || 1)),
    }))
    .filter(entry => entry.size);

}

function sanitizePurchasePlan(input = {}, existing = {}) {

  const current = { ...defaultPurchasePlan(), ...existing };

  return {
    ...current,
    enabled: Boolean(input.enabled),
    useReleaseTime: input.useReleaseTime !== false,
    targetTime: normalizeIsoDate(input.targetTime),
    checkEveryMinutes: 30,
    sizeQuantities: sanitizeSizeQuantities(input.sizeQuantities),
    lastScheduledCheckAt: current.lastScheduledCheckAt || null,
    resolvedTargetTime: null,
    readyAlertSent: false,
  };

}



app.use(cors());

app.use(express.json());



// ── Static frontend ───────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, '../frontend')));



// ── Products ──────────────────────────────────────────────────────────────────

app.get('/api/products', (_req, res) => {

  res.json(storage.getProducts());

});



app.post('/api/products', async (req, res) => {

  const { url } = req.body || {};



  if (!url || typeof url !== 'string') {

    return res.status(400).json({ error: 'A product URL is required' });

  }



  let parsed;

  try { parsed = new URL(url); } catch {

    return res.status(400).json({ error: 'Invalid URL format' });

  }



  const isSupportedHost = ALLOWED_HOSTS.some(h => parsed.hostname === h || parsed.hostname.endsWith('.' + h));

  if (!isSupportedHost) {

    return res.status(400).json({ error: `Only supported product URLs are allowed. Supported stores: ${ALLOWED_HOSTS.join(', ')}` });

  }



  // Prevent duplicate monitoring (check original URL)

  const existing = storage.getProducts().find(p => p.url === url);

  if (existing) return res.status(409).json({ error: 'This product is already being monitored', product: existing });



  try {

    // Resolve redirect (nike.sng.link → www.nike.com/t/...)

    const resolvedUrl = await resolveUrl(url);

    const data    = await scrapeProduct(resolvedUrl);

    // Store the resolved URL but keep the original URL for dedup checks

    const product = {

      id: uuid(),

      ...data,

      url: resolvedUrl,

      sourceUrl: url,

      addedAt: new Date().toISOString(),

      inCart: false,

      cartAttempts: 0,

      cartSuccessCount: 0,

      lastCartAttemptAt: null,

      lastCartResult: null,

      purchasePlan: defaultPurchasePlan(),

      priceHistory: data.price !== null ? [{ price: data.price, at: data.lastChecked }] : [],

    };

    storage.addProduct(product);

    io.emit('product:added', product);

    const updated = await monitor.addToCartNow(product);

    res.status(201).json(updated || product);

  } catch (err) {

    res.status(502).json({ error: err.message });

  }

});



app.delete('/api/products/:id', (req, res) => {

  const { id } = req.params;

  const products = storage.getProducts();

  if (!products.find(p => p.id === id)) return res.status(404).json({ error: 'Not found' });

  storage.removeProduct(id);

  io.emit('product:removed', { id });

  res.json({ success: true });

});



app.post('/api/products/:id/check', async (req, res) => {

  const product = storage.getProducts().find(p => p.id === req.params.id);

  if (!product) return res.status(404).json({ error: 'Not found' });

  try {

    const result = await monitor.checkProduct(product);

    res.json(result);

  } catch (err) {

    res.status(502).json({ error: err.message });

  }

});



app.put('/api/products/:id/purchase-plan', (req, res) => {

  const product = storage.getProducts().find(p => p.id === req.params.id);

  if (!product) return res.status(404).json({ error: 'Not found' });

  const purchasePlan = sanitizePurchasePlan(req.body || {}, product.purchasePlan);
  const updated = storage.updateProduct(product.id, { purchasePlan });

  io.emit('product:updated', updated);

  res.json(updated);

});



app.post('/api/products/:id/cart', async (req, res) => {

  const product = storage.getProducts().find(p => p.id === req.params.id);

  if (!product) return res.status(404).json({ error: 'Not found' });



  try {
    const updated = await monitor.addToCartNow(product);
    res.json({ success: true, product: updated });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }

});



// ── Alerts ────────────────────────────────────────────────────────────────────

app.get('/api/alerts', (req, res) => {

  const limit = Math.min(200, parseInt(req.query.limit) || 50);

  res.json(storage.getAlerts().slice(0, limit));

});



app.delete('/api/alerts', (_req, res) => {

  storage.clearAlerts();

  io.emit('alerts:cleared');

  res.json({ success: true });

});



app.get('/api/checkout-profile', async (_req, res) => {

  try {
    const profile = await checkoutStore.getCheckoutProfile();
    res.json(profile);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }

});



app.put('/api/checkout-profile', async (req, res) => {

  try {
    const profile = await checkoutStore.saveCheckoutProfile(req.body || {});
    res.json(profile);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }

});



// ── Settings ──────────────────────────────────────────────────────────────────

app.get('/api/settings', (_req, res) => {

  const s = storage.getSettings();

  res.json({ ...s, emailPass: s.emailPass ? '***' : '' });

});



app.put('/api/settings', (req, res) => {

  const updates = { ...req.body };

  if (updates.emailPass === '***') delete updates.emailPass;  // don't overwrite masked value



  // Validate interval range

  if (updates.checkIntervalMinutes !== undefined) {

    updates.checkIntervalMinutes = Math.max(1, Math.min(60, parseInt(updates.checkIntervalMinutes) || 5));

    monitor.setCheckInterval(updates.checkIntervalMinutes);

  }



  storage.saveSettings(updates);

  res.json({ success: true });

});



// ── Monitor status ────────────────────────────────────────────────────────────

app.get('/api/status', (_req, res) => res.json(monitor.getStatus()));



app.post('/api/check-all', async (req, res) => {

  res.json({ success: true, message: 'Manual check triggered' });

  monitor.checkAllProducts(); // run async, don't await

});



app.post('/api/discover', async (req, res) => {
  res.json({ success: true, message: 'Discovery triggered' });
  discoverTrendingProducts().catch(err => console.error('[Discovery] Manual trigger failed:', err.message));
});

// ── Socket.io ─────────────────────────────────────────────────────────────────

io.on('connection', async (socket) => {

  console.log('[Socket] Connected:', socket.id);



  const s = storage.getSettings();
  const checkoutProfile = await checkoutStore.getCheckoutProfile().catch(() => null);

  socket.emit('init', {

    products: storage.getProducts(),

    alerts  : storage.getAlerts().slice(0, 50),

    settings: { ...s, emailPass: s.emailPass ? '***' : '' },

    checkoutProfile,

    status  : monitor.getStatus(),

  });



  socket.on('disconnect', () => console.log('[Socket] Disconnected:', socket.id));

});


// ── Discovery helpers ───────────────────────────────────────────────────────

function normalizeUrl(href, base) {
  try {
    const url = new URL(href, base);
    url.hash = '';
    url.search = url.search.replace(/utm_[^=&]+(&|$)/g, '').replace(/&$/, '');
    return url.toString();
  } catch {
    return null;
  }
}

function isSupportedProductUrl(urlString) {
  try {
    const url = new URL(urlString);
    const host = url.hostname.toLowerCase();
    const path = url.pathname.toLowerCase();

    if (!ALLOWED_HOSTS.some(h => host === h || host.endsWith('.' + h))) return false;
    if (path.includes('/cart') || path.includes('/privacy') || path.includes('/login') || path.includes('/account')) return false;

    const matchers = [
      { host: /nike/, regex: /(\/t\/|\/launch\/t\/)/ },
      { host: /adidas/, regex: /(\/product\/|\/confirmed\/|\/launch\/|\/sneakers\/)/ },
      { host: /footlocker|eastbay|champssports/, regex: /(\/product\/|\/sku\/|\/shoe\/|\/new-arrivals|\/launches)/ },
      { host: /finishline/, regex: /(\/product\/|\/sku\/|\/sneakers\/)/ },
      { host: /stockx/, regex: /\/sneakers\// },
      { host: /goat/, regex: /\/p\// },
      { host: /stadiumgoods/, regex: /\/product\// },
      { host: /supremenewyork/, regex: /(\/products\/|\/shop\/)/ },
    ];

    for (const item of matchers) {
      if (item.host.test(host) && item.regex.test(path)) return true;
    }

    return /(\/product|\/sneakers|\/shoe|\/t\/|\/p\/|\/products\/|\/item\/)/.test(path);
  } catch {
    return false;
  }
}

function extractProductLinks(html, baseUrl) {
  const $ = cheerio.load(html);
  const urls = new Set();

  $('a[href]').each((_, el) => {
    const raw = $(el).attr('href');
    if (!raw) return;
    const normalized = normalizeUrl(raw, baseUrl);
    if (!normalized || !isSupportedProductUrl(normalized)) return;
    urls.add(normalized);
  });

  return [...urls];
}

async function discoverTrendingProducts() {
  const existing = storage.getProducts();
  const existingUrls = new Set(existing.map(p => p.sourceUrl || p.url));
  const discovered = new Set();

  for (const source of DISCOVERY_SOURCES) {
    try {
      const response = await axios.get(source.url, { headers: DISCOVERY_HEADERS, timeout: 25000 });
      const links = extractProductLinks(response.data, source.url);
      let added = 0;

      for (const productUrl of links) {
        if (existingUrls.has(productUrl) || discovered.has(productUrl)) continue;
        if (added >= source.maxProducts) break;

        try {
          console.log(`[Discovery] Adding from ${source.name}: ${productUrl}`);
          const resolvedUrl = await resolveUrl(productUrl);
          const data = await scrapeProduct(resolvedUrl);
          const product = {
            id: uuid(),
            ...data,
            url: resolvedUrl,
            sourceUrl: productUrl,
            addedAt: new Date().toISOString(),
            inCart: false,
            cartAttempts: 0,
            cartSuccessCount: 0,
            lastCartAttemptAt: null,
            lastCartResult: null,
            purchasePlan: defaultPurchasePlan(),
            priceHistory: data.price !== null ? [{ price: data.price, at: data.lastChecked }] : [],
          };
          storage.addProduct(product);
          io.emit('product:added', product);
          existingUrls.add(productUrl);
          discovered.add(productUrl);
          added += 1;
          await new Promise(r => setTimeout(r, 2000));
        } catch (err) {
          console.error(`[Discovery] Failed to add ${productUrl}:`, err.message);
        }
      }
    } catch (err) {
      console.error(`[Discovery] Failed to fetch ${source.url}:`, err.message);
    }
  }
}

async function startDiscoveryScheduler() {
  try {
    await discoverTrendingProducts();
  } catch (err) {
    console.error('[Discovery] Initial discovery failed:', err.message);
  }

  setInterval(() => {
    discoverTrendingProducts().catch(err => console.error('[Discovery] Scheduled discovery failed:', err.message));
  }, DISCOVERY_INTERVAL_MINUTES * 60 * 1000);
}

// ── Seed products ────────────────────────────────────────────────────────────

const SEED_URLS = [

  'https://nike.sng.link/Astn5/6tbz/r_6150d2a81b',

  'https://nike.sng.link/Astn5/6tbz/r_f506e438c3',

  'https://nike.sng.link/Astn5/6tbz/r_0f7562e9a5',

];



async function seedProducts() {

  const existing = storage.getProducts();

  const existingUrls = new Set(existing.map(p => p.sourceUrl || p.url));



  for (const seedUrl of SEED_URLS) {

    if (existingUrls.has(seedUrl)) {

      console.log(`[Seed] Already tracked: ${seedUrl}`);

      continue;

    }

    try {

      console.log(`[Seed] Resolving ${seedUrl} …`);

      const resolvedUrl = await resolveUrl(seedUrl);

      console.log(`[Seed] → ${resolvedUrl}`);

      const data    = await scrapeProduct(resolvedUrl);

      const product = {

        id        : uuid(),

        ...data,

        url       : resolvedUrl,

        sourceUrl : seedUrl,

        addedAt   : new Date().toISOString(),

        inCart    : false,

        cartAttempts: 0,

        cartSuccessCount: 0,

        lastCartAttemptAt: null,

        lastCartResult: null,

        purchasePlan: defaultPurchasePlan(),

        priceHistory: data.price !== null ? [{ price: data.price, at: data.lastChecked }] : [],

      };

      storage.addProduct(product);

      io.emit('product:added', product);

      console.log(`[Seed] ✓ Added: ${data.name}`);

      // polite pause between seed requests

      await new Promise(r => setTimeout(r, 3000));

    } catch (err) {

      console.error(`[Seed] Failed for ${seedUrl}:`, err.message);

    }

  }

}



// ── Start ─────────────────────────────────────────────────────────────────────

async function start() {

  try {
    await checkoutStore.init();
  } catch (err) {
    console.error('[CheckoutStore] Init failed:', err.message);
  }

  const settings = storage.getSettings();

  monitor.init(io, settings.checkIntervalMinutes);

  server.listen(PORT, () => {

    console.log(`\n  SpeedBuyer running → http://localhost:${PORT}\n`);

    // Seed the 3 Nike products and discover trending releases automatically

    setTimeout(() => {
      seedProducts().catch(err => console.error('[Seed] Failed:', err.message));
      startDiscoveryScheduler();
    }, 2000);

  });

}



start();

