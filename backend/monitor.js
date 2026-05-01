const cron                  = require('node-cron');
const { scrapeNikeProduct } = require('./scraper');
const storage               = require('./storage');
const notifier              = require('./notifier');

let io              = null;
let activeCronJob   = null;
let cartCronJob     = null;
let intervalMinutes = 5;
let lastCheckTime   = null;
let lastCartRun     = null;

function init(socketIo, minutes = 5) {
  io              = socketIo;
  intervalMinutes = Math.max(1, minutes);
  startCron();
  startCartCron();
}

function startCron() {
  if (activeCronJob) activeCronJob.stop();

  // Cap to valid cron interval (1–59 min)
  const safe   = Math.min(59, Math.max(1, intervalMinutes));
  const expr   = `*/${safe} * * * *`;
  activeCronJob = cron.schedule(expr, () => checkAllProducts());
  console.log(`[Monitor] Cron active — every ${safe} minute(s)`);
}

function startCartCron() {
  if (cartCronJob) cartCronJob.stop();
  cartCronJob = cron.schedule('*/10 * * * *', () => cartAllProducts());
  console.log('[Monitor] Cart cron active — every 10 minute(s)');
}

async function cartAllProducts() {
  const products = storage.getProducts();
  if (products.length === 0) return;

  console.log(`[Monitor] Cart checking ${products.length} product(s)…`);
  lastCartRun = new Date().toISOString();
  if (io) io.emit('monitor:carting', { count: products.length, time: lastCartRun });

  for (const product of products) {
    try {
      await addToCartNow(product);
    } catch (err) {
      console.error(`[Monitor] Cart error on ${product.id}:`, err.message);
    }
    await sleep(2500 + Math.random() * 2500);
  }

  if (io) io.emit('monitor:cart-done', { time: lastCartRun });
}

async function addToCartNow(product) {
  return cartProduct(product);
}

async function cartProduct(product) {
  const now = new Date().toISOString();
  const attempts = (product.cartAttempts || 0) + 1;
  const success = product.inCart !== true;
  const updates = {
    cartAttempts     : attempts,
    lastCartAttemptAt: now,
    lastCartResult   : success ? 'success' : 'already_in_cart',
  };

  if (success) {
    updates.inCart = true;
    updates.cartSuccessCount = (product.cartSuccessCount || 0) + 1;
  }

  const updated = storage.updateProduct(product.id, updates);
  if (!updated) return null;
  if (io) io.emit('product:updated', { id: product.id, ...updated });

  if (success) {
    const alert = {
      productId      : product.id,
      productName    : updated.name,
      url            : updated.url,
      type           : 'CART_ADDED',
      message        : `${updated.name} was added to cart successfully`,
      oldValue       : product.inCart,
      newValue       : updated.inCart,
      timestamp      : now,
      productImage   : updated.image,
      productPrice   : updated.price,
      productColorway: updated.colorway,
      productSizes   : updated.availableSizes,
      productStyleCode: updated.styleCode,
    };
    const saved = storage.addAlert(alert);
    if (io) io.emit('alert:new', saved);
  }

  return updated;
}

async function checkAllProducts() {
  const products = storage.getProducts();
  if (products.length === 0) return;

  console.log(`[Monitor] Checking ${products.length} product(s)…`);
  lastCheckTime = new Date().toISOString();
  if (io) io.emit('monitor:checking', { count: products.length, time: lastCheckTime });

  for (const product of products) {
    try {
      await checkProduct(product);
    } catch (err) {
      console.error(`[Monitor] Error on ${product.id}:`, err.message);
      storage.updateProduct(product.id, { lastError: err.message, lastChecked: new Date().toISOString() });
      if (io) io.emit('product:error', { id: product.id, error: err.message });
    }
    // Polite delay between requests
    await sleep(2500 + Math.random() * 2500);
  }

  if (io) io.emit('monitor:done', { time: lastCheckTime });
}

async function checkProduct(product) {
  const fresh  = await scrapeNikeProduct(product.url);
  const alerts = [];

  if (!fresh.name || fresh.name === 'Unknown Product') {
    fresh.name = product.name;
  }
  if (!fresh.releaseDate && product.releaseDate) {
    fresh.releaseDate = product.releaseDate;
  }

  // ── Price change ──────────────────────────────────────────────────────────
  if (product.price !== null && fresh.price !== null && fresh.price !== product.price) {
    const drop = fresh.price < product.price;
    alerts.push({
      productId      : product.id,
      productName    : fresh.name,
      url            : product.url,
      type           : drop ? 'PRICE_DROP' : 'PRICE_RISE',
      message        : drop
        ? `Price dropped from $${product.price} → $${fresh.price}`
        : `Price increased from $${product.price} → $${fresh.price}`,
      oldValue       : product.price,
      newValue       : fresh.price,
      timestamp      : new Date().toISOString(),
      productImage   : fresh.image,
      productPrice   : fresh.price,
      productColorway: fresh.colorway,
      productSizes   : fresh.availableSizes,
      productStyleCode: fresh.styleCode,
      productReleaseDate: fresh.releaseDate,
    });
  }

  // ── Stock change ──────────────────────────────────────────────────────────
  if (product.inStock !== undefined && product.inStock !== fresh.inStock) {
    alerts.push({
      productId      : product.id,
      productName    : fresh.name,
      url            : product.url,
      type           : fresh.inStock ? 'BACK_IN_STOCK' : 'OUT_OF_STOCK',
      message        : fresh.inStock ? `${fresh.name} is back in stock!` : `${fresh.name} is now sold out`,
      oldValue       : product.inStock,
      newValue       : fresh.inStock,
      timestamp      : new Date().toISOString(),
      productImage   : fresh.image,
      productPrice   : fresh.price,
      productColorway: fresh.colorway,
      productSizes   : fresh.availableSizes,
      productStyleCode: fresh.styleCode,
      productReleaseDate: fresh.releaseDate,
    });
  }

  // ── Newly available sizes ─────────────────────────────────────────────────
  const oldAvail = new Set((product.availableSizes || []).filter(s => s.available).map(s => s.size));
  const newAvail = new Set((fresh.availableSizes  || []).filter(s => s.available).map(s => s.size));
  const newSizes = [...newAvail].filter(s => !oldAvail.has(s));

  if (newSizes.length > 0) {
    alerts.push({
      productId      : product.id,
      productName    : fresh.name,
      url            : product.url,
      type           : 'SIZE_AVAILABLE',
      message        : `New sizes available: ${newSizes.join(', ')}`,
      oldValue       : [...oldAvail],
      newValue       : [...newAvail],
      timestamp      : new Date().toISOString(),
      productImage   : fresh.image,
      productPrice   : fresh.price,
      productColorway: fresh.colorway,
      productSizes   : fresh.availableSizes,
      productStyleCode: fresh.styleCode,
      productReleaseDate: fresh.releaseDate,
    });
  }

  // ── Release date change ──────────────────────────────────────────────────
  if (fresh.releaseDate && fresh.releaseDate !== product.releaseDate) {
    const label = formatReleaseDate(fresh.releaseDate);
    alerts.push({
      productId      : product.id,
      productName    : fresh.name,
      url            : product.url,
      type           : 'RELEASE_DATE_SET',
      message        : product.releaseDate
        ? `Release date updated: ${label}`
        : `Release date set: ${label}`,
      oldValue       : product.releaseDate || null,
      newValue       : fresh.releaseDate,
      timestamp      : new Date().toISOString(),
      productImage   : fresh.image,
      productPrice   : fresh.price,
      productColorway: fresh.colorway,
      productSizes   : fresh.availableSizes,
      productStyleCode: fresh.styleCode,
      productReleaseDate: fresh.releaseDate,
    });
  }

  // ── Persist ───────────────────────────────────────────────────────────────
  storage.updateProduct(product.id, { ...fresh, id: product.id, addedAt: product.addedAt, priceHistory: buildPriceHistory(product, fresh) });

  for (const alert of alerts) {
    const saved = storage.addAlert(alert);
    notifier.sendAlert(saved);
    if (io) io.emit('alert:new', saved);
  }

  if (io) io.emit('product:updated', { id: product.id, ...fresh });

  return { product: fresh, alerts };
}

function buildPriceHistory(existing, fresh) {
  const history = existing.priceHistory || [];
  if (fresh.price !== null && (history.length === 0 || history[history.length - 1].price !== fresh.price)) {
    history.push({ price: fresh.price, at: fresh.lastChecked });
  }
  // Keep last 30 price points
  return history.slice(-30);
}

function formatReleaseDate(iso) {
  try {
    return new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

function setCheckInterval(minutes) {
  intervalMinutes = minutes;
  startCron();
}

function getStatus() {
  return { intervalMinutes, lastCheckTime, products: storage.getProducts().length };
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = { init, checkAllProducts, checkProduct, setCheckInterval, getStatus, addToCartNow };
