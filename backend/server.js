const express  = require('express');

const http     = require('http');

const { Server } = require('socket.io');

const cors     = require('cors');

const { v4: uuid } = require('uuid');

const path     = require('path');



const storage  = require('./storage');
const checkoutStore = require('./checkoutStore');

const monitor  = require('./monitor');

const { scrapeNikeProduct, resolveUrl } = require('./scraper');



// Nike short-link / deep-link domains that redirect to nike.com

const ALLOWED_NIKE_HOSTS = ['nike.com', 'nike.sng.link', 'nikerunning.app.link'];



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

    return res.status(400).json({ error: 'A Nike product URL is required' });

  }



  let parsed;

  try { parsed = new URL(url); } catch {

    return res.status(400).json({ error: 'Invalid URL format' });

  }



  const isNikeHost = ALLOWED_NIKE_HOSTS.some(h => parsed.hostname === h || parsed.hostname.endsWith('.' + h));

  if (!isNikeHost) {

    return res.status(400).json({ error: 'Only Nike URLs are supported (nike.com or nike.sng.link)' });

  }



  // Prevent duplicate monitoring (check original URL)

  const existing = storage.getProducts().find(p => p.url === url);

  if (existing) return res.status(409).json({ error: 'This product is already being monitored', product: existing });



  try {

    // Resolve redirect (nike.sng.link → www.nike.com/t/...)

    const resolvedUrl = await resolveUrl(url);

    const data    = await scrapeNikeProduct(resolvedUrl);

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

      const data    = await scrapeNikeProduct(resolvedUrl);

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

    // Seed the 3 Nike products after a short boot delay

    setTimeout(seedProducts, 2000);

  });

}



start();

