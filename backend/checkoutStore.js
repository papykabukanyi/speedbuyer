const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const DATA_DIR = path.join(__dirname, 'data');
const FALLBACK_FILE = path.join(DATA_DIR, 'checkout-profile.json');
const PROFILE_ID = 'default';

const DEFAULT_PROFILE = {
  fullName: '',
  email: '',
  phone: '',
  address1: '',
  address2: '',
  city: '',
  state: '',
  postalCode: '',
  country: 'US',
  paymentLabel: '',
  cardBrand: '',
  cardLast4: '',
  updatedAt: null,
  siteCredentials: {},  // { 'nike.com': { username: '...', password: '...' }, ... }
};

let pool = null;
let initialized = false;

function hasDatabase() {
  return Boolean(process.env.DATABASE_URL);
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

function shouldUseSsl() {
  const dbUrl = process.env.DATABASE_URL || '';
  return /^postgres(ql)?:\/\//.test(dbUrl) && !/localhost|127\.0\.0\.1/i.test(dbUrl);
}

function getPool() {
  if (!pool && hasDatabase()) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: shouldUseSsl() ? { rejectUnauthorized: false } : false,
    });
  }
  return pool;
}

async function init() {
  if (initialized || !hasDatabase()) return;

  await getPool().query(`
    CREATE TABLE IF NOT EXISTS checkout_profiles (
      id TEXT PRIMARY KEY,
      full_name TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      address1 TEXT NOT NULL DEFAULT '',
      address2 TEXT NOT NULL DEFAULT '',
      city TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT '',
      postal_code TEXT NOT NULL DEFAULT '',
      country TEXT NOT NULL DEFAULT 'US',
      payment_label TEXT NOT NULL DEFAULT '',
      card_brand TEXT NOT NULL DEFAULT '',
      card_last4 TEXT NOT NULL DEFAULT '',
      site_credentials JSONB NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ NULL
    )
  `);

  initialized = true;
}

function sanitizeProfile(input = {}) {
  const creds = input.siteCredentials || {};
  const sanitized = {};

  // Sanitize site credentials: only store for recognized domains
  const supportedDomains = ['nike.com', 'adidas.com', 'footlocker.com', 'eastbay.com', 'champssports.com', 'finishline.com', 'stockx.com', 'goat.com', 'stadiumgoods.com', 'supremenewyork.com'];
  for (const domain of supportedDomains) {
    if (creds[domain]?.username && creds[domain]?.password) {
      sanitized[domain] = {
        username: String(creds[domain].username).trim().slice(0, 255),
        password: String(creds[domain].password).slice(0, 1000),
      };
    }
  }

  return {
    fullName: String(input.fullName || '').trim(),
    email: String(input.email || '').trim(),
    phone: String(input.phone || '').trim(),
    address1: String(input.address1 || '').trim(),
    address2: String(input.address2 || '').trim(),
    city: String(input.city || '').trim(),
    state: String(input.state || '').trim(),
    postalCode: String(input.postalCode || '').trim(),
    country: String(input.country || 'US').trim() || 'US',
    paymentLabel: String(input.paymentLabel || '').trim(),
    cardBrand: String(input.cardBrand || '').trim(),
    cardLast4: String(input.cardLast4 || '').replace(/\D/g, '').slice(-4),
    siteCredentials: sanitized,
    updatedAt: input.updatedAt || new Date().toISOString(),
  };
}

function mapRow(row) {
  if (!row) return { ...DEFAULT_PROFILE };
  return sanitizeProfile({
    fullName: row.full_name,
    email: row.email,
    phone: row.phone,
    address1: row.address1,
    address2: row.address2,
    city: row.city,
    state: row.state,
    postalCode: row.postal_code,
    country: row.country,
    paymentLabel: row.payment_label,
    cardBrand: row.card_brand,
    cardLast4: row.card_last4,
    siteCredentials: row.site_credentials,
    updatedAt: row.updated_at,
  });
}

async function getCheckoutProfile() {
  if (hasDatabase()) {
    await init();
    const result = await getPool().query('SELECT * FROM checkout_profiles WHERE id = $1', [PROFILE_ID]);
    return result.rowCount ? mapRow(result.rows[0]) : { ...DEFAULT_PROFILE };
  }

  return { ...DEFAULT_PROFILE, ...readJson(FALLBACK_FILE, {}) };
}

async function saveCheckoutProfile(patch = {}) {
  const current = await getCheckoutProfile();
  const next = sanitizeProfile({ ...current, ...patch });

  if (hasDatabase()) {
    await init();
    await getPool().query(
      `
        INSERT INTO checkout_profiles (
          id, full_name, email, phone, address1, address2, city, state,
          postal_code, country, payment_label, card_brand, card_last4, site_credentials, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8,
          $9, $10, $11, $12, $13, $14, $15
        )
        ON CONFLICT (id) DO UPDATE SET
          full_name = EXCLUDED.full_name,
          email = EXCLUDED.email,
          phone = EXCLUDED.phone,
          address1 = EXCLUDED.address1,
          address2 = EXCLUDED.address2,
          city = EXCLUDED.city,
          state = EXCLUDED.state,
          postal_code = EXCLUDED.postal_code,
          country = EXCLUDED.country,
          payment_label = EXCLUDED.payment_label,
          card_brand = EXCLUDED.card_brand,
          card_last4 = EXCLUDED.card_last4,
          site_credentials = EXCLUDED.site_credentials,
          updated_at = EXCLUDED.updated_at
      `,
      [
        PROFILE_ID,
        next.fullName,
        next.email,
        next.phone,
        next.address1,
        next.address2,
        next.city,
        next.state,
        next.postalCode,
        next.country,
        next.paymentLabel,
        next.cardBrand,
        next.cardLast4,
        JSON.stringify(next.siteCredentials),
        next.updatedAt,
      ]
    );
    return next;
  }

  writeJson(FALLBACK_FILE, next);
  return next;
}

module.exports = { init, getCheckoutProfile, saveCheckoutProfile };
