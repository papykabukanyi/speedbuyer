const fs   = require('fs');
const path = require('path');

const DATA_DIR     = path.join(__dirname, 'data');
const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');
const ALERTS_FILE   = path.join(DATA_DIR, 'alerts.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const DEFAULT_SETTINGS = {
  checkIntervalMinutes: 5,
  emailEnabled: false,
  emailHost: 'smtp.gmail.com',
  emailPort: 587,
  emailUser: '',
  emailPass: '',
  emailTo: '',
};

function getEnvSettings() {
  const env = process.env;
  const settings = {};

  if (env.CHECK_INTERVAL_MINUTES || env.CHECK_INTERVAL) {
    const raw = env.CHECK_INTERVAL_MINUTES || env.CHECK_INTERVAL;
    const val = parseInt(raw);
    if (!isNaN(val)) settings.checkIntervalMinutes = val;
  }

  if (env.EMAIL_ENABLED !== undefined) {
    settings.emailEnabled = env.EMAIL_ENABLED === 'true' || env.EMAIL_ENABLED === '1';
  }

  if (env.EMAIL_HOST) settings.emailHost = env.EMAIL_HOST;
  if (env.EMAIL_PORT) {
    const port = parseInt(env.EMAIL_PORT);
    if (!isNaN(port)) settings.emailPort = port;
  }
  if (env.EMAIL_USER) settings.emailUser = env.EMAIL_USER;
  if (env.EMAIL_PASS) settings.emailPass = env.EMAIL_PASS;
  if (env.EMAIL_TO) settings.emailTo = env.EMAIL_TO;

  if (settings.emailEnabled === undefined && (settings.emailUser || settings.emailPass || settings.emailTo)) {
    settings.emailEnabled = true;
  }

  return settings;
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  return fallback;
}

function writeJson(file, data) {
  ensureDataDir();
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

// ── Products ─────────────────────────────────────────────────────────────────
function getProducts()       { return readJson(PRODUCTS_FILE, []); }
function saveProducts(list)  { writeJson(PRODUCTS_FILE, list); }

function addProduct(product) {
  const list = getProducts();
  list.push(product);
  saveProducts(list);
}

function updateProduct(id, updates) {
  const list = getProducts();
  const idx  = list.findIndex(p => p.id === id);
  if (idx === -1) return null;
  list[idx] = { ...list[idx], ...updates };
  saveProducts(list);
  return list[idx];
}

function removeProduct(id) {
  saveProducts(getProducts().filter(p => p.id !== id));
}

// ── Alerts ────────────────────────────────────────────────────────────────────
function getAlerts()       { return readJson(ALERTS_FILE, []); }
function saveAlerts(list)  { writeJson(ALERTS_FILE, list); }

function addAlert(alert) {
  const list = getAlerts();
  alert.id   = Date.now().toString();
  list.unshift(alert);
  if (list.length > 200) list.splice(200);
  saveAlerts(list);
  return alert;
}

function clearAlerts() { saveAlerts([]); }

// ── Settings ──────────────────────────────────────────────────────────────────
function getSettings()       { return { ...DEFAULT_SETTINGS, ...readJson(SETTINGS_FILE, {}), ...getEnvSettings() }; }

// Persist only file-level settings — never write env-provided secrets (e.g. email creds) back to disk
function saveSettings(patch) { writeJson(SETTINGS_FILE, { ...DEFAULT_SETTINGS, ...readJson(SETTINGS_FILE, {}), ...patch }); }

module.exports = {
  getProducts, addProduct, updateProduct, removeProduct,
  getAlerts,   addAlert,   clearAlerts,
  getSettings, saveSettings,
};
