/* =============================================================================
   SpeedBuyer — Minimal Dashboard
============================================================================= */
const API = window.location.protocol === 'file:' ? 'http://localhost:3001' : '';

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  products: [],
  settings: {},
  checkoutProfile: {},
  checking: new Set(),
  carting:  new Set(),
  checkoutReady: {},  // productId → checkout:ready payload
};

// ── Helpers ───────────────────────────────────────────────────────────────────
const el = id => document.getElementById(id);
const escHtml = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

// ── Socket.io ─────────────────────────────────────────────────────────────────
const socket = io(API, { transports: ['websocket', 'polling'] });

socket.on('connect',       ()  => setConn('connected', 'Live'));
socket.on('disconnect',    ()  => setConn('error', 'Disconnected'));
socket.on('connect_error', ()  => setConn('error', 'Cannot connect'));

socket.on('init', ({ products, settings, checkoutProfile }) => {
  state.products        = sortProducts(products || []);
  state.settings        = settings       || {};
  state.checkoutProfile = checkoutProfile || {};
  renderAll();
  applyProfileToForm();
  applySettingsToForm();
});

socket.on('product:added', product => {
  if (!state.products.find(p => p.id === product.id)) state.products.push(product);
  state.products = sortProducts(state.products);
  renderAll();
  toast('success', 'Product added', product.name || product.url);
});

socket.on('product:updated', data => {
  const idx = state.products.findIndex(p => p.id === data.id);
  if (idx !== -1) state.products[idx] = { ...state.products[idx], ...data };
  state.products = sortProducts(state.products);
  state.checking.delete(data.id);
  renderAll();
});

socket.on('product:removed', ({ id }) => {
  state.products = state.products.filter(p => p.id !== id);
  renderAll();
});

socket.on('alert:new', alert => {
  const row = el(`row-${alert.productId}`);
  if (row) row.classList.add('flash'), setTimeout(() => row.classList.remove('flash'), 1100);
  if (alert.type === 'BACK_IN_STOCK' || alert.type === 'RELEASE_DATE_SET') {
    toast('success', alert.type.replace(/_/g, ' '), alert.message);
  }
  if (alert.type === 'CART_ADDED') {
    toast('success', 'In Cart', alert.message);
  }
});

socket.on('checkout:ready', data => {
  state.checkoutReady[data.productId] = data;
  state.products = sortProducts(state.products);
  renderAll();
  const sizesLabel = (data.selectedSizes || []).map(s => `${s.size} x${s.quantity}`).join(', ');
  toast('success', 'Checkout Ready', `${data.productName} — ${sizesLabel || '1 item'}`);
});

// ── Sort ──────────────────────────────────────────────────────────────────────
function sortProducts(products) {
  const now = Date.now();
  return [...products].sort((a, b) => {
    const aUp = a.releaseDate && new Date(a.releaseDate) > now;
    const bUp = b.releaseDate && new Date(b.releaseDate) > now;
    if (aUp && !bUp) return -1;
    if (!aUp && bUp) return  1;
    if (aUp && bUp)  return new Date(a.releaseDate) - new Date(b.releaseDate);
    if (a.inStock && !b.inStock) return -1;
    if (!a.inStock && b.inStock) return  1;
    return 0;
  });
}

// ── Render ────────────────────────────────────────────────────────────────────
function renderAll() {
  const list = el('releases-list');
  const empt = el('empty-state');
  if (!list) return;

  if (state.products.length === 0) {
    list.innerHTML = '';
    empt.style.display = 'flex';
    el('header-count').textContent = '';
    return;
  }
  empt.style.display = 'none';
  el('header-count').textContent = `${state.products.length} release${state.products.length !== 1 ? 's' : ''}`;

  // Diff-update: only rebuild rows that changed
  const rendered = new Set();
  state.products.forEach(p => {
    rendered.add(p.id);
    const existing = el(`row-${p.id}`);
    const html = buildRowHTML(p);
    if (!existing) {
      const d = document.createElement('div');
      d.innerHTML = html;
      list.appendChild(d.firstElementChild);
    } else {
      const d = document.createElement('div');
      d.innerHTML = html;
      existing.replaceWith(d.firstElementChild);
    }
    attachRowHandlers(p.id);
  });

  // Remove rows for deleted products
  [...list.children].forEach(child => {
    const id = child.id?.replace('row-', '');
    if (id && !rendered.has(id)) child.remove();
  });
}

function buildRowHTML(p) {
  const checking = state.checking.has(p.id);
  const carting  = state.carting.has(p.id);
  const checkout = state.checkoutReady[p.id] || null;

  // Status badge
  let badgeClass, badgeText;
  const now = Date.now();
  const rdMs = p.releaseDate ? new Date(p.releaseDate).getTime() : null;
  if (rdMs && rdMs > now) {
    badgeClass = 'upcoming'; badgeText = 'Upcoming';
  } else if (p.inStock === true) {
    badgeClass = 'instock'; badgeText = 'In Stock';
  } else {
    badgeClass = 'soldout'; badgeText = p.inStock === false ? 'Sold Out' : 'Unknown';
  }

  // Release info
  let releaseHTML = '';
  if (p.releaseDate) {
    const d = new Date(p.releaseDate);
    const abs = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const diffMs = d - now;
    let rel = '';
    if (diffMs > 0) {
      const days = Math.ceil(diffMs / 86400000);
      rel = days === 1 ? 'Tomorrow' : `In ${days} days`;
    } else {
      rel = 'Released';
    }
    releaseHTML = `<span class="release-date">${abs}</span><span class="release-countdown">${rel}</span>`;
  }

  // Price
  let priceHTML = '';
  if (p.price != null) {
    priceHTML = `<span class="row-price">$${Number(p.price).toFixed(2)}</span>`;
    if (p.originalPrice && p.originalPrice !== p.price)
      priceHTML += `<span class="row-price-orig">$${Number(p.originalPrice).toFixed(2)}</span>`;
  }

  // Image
  const imgHTML = p.image
    ? `<img class="row-img" src="${escHtml(p.image)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><div class="row-img-placeholder" style="display:none">👟</div>`
    : `<div class="row-img-placeholder">👟</div>`;

  // Sizes (show only a few)
  let sizesHTML = '';
  if (p.availableSizes && p.availableSizes.length > 0) {
    const chips = p.availableSizes.slice(0, 8).map(s =>
      `<span class="size-chip ${s.available ? 'avail' : 'gone'}">${escHtml(s.size)}</span>`
    ).join('');
    sizesHTML = `<div class="row-sizes">${chips}</div>`;
  }

  // Cart button
  let cartBtn;
  if (p.inCart) {
    cartBtn = `<button class="btn-cart ready" disabled>✅ Ready!</button>`;
  } else if (carting) {
    cartBtn = `<button class="btn-cart checking" disabled><div class="spinner"></div></button>`;
  } else {
    cartBtn = `<button class="btn-cart" data-action="cart" data-id="${p.id}">Add to Cart</button>`;
  }

  // Error
  const errHTML = p.lastError ? `<div class="row-error">⚠ ${escHtml(p.lastError)}</div>` : '';

  // Checkout ready panel
  let checkoutHTML = '';
  if (checkout) {
    const sizesLabel = (checkout.selectedSizes || []).map(s => `${escHtml(s.size)} x${s.quantity}`).join(', ');
    const prof = checkout.profile || {};
    let profileLine = '';
    if (prof.fullName || prof.address1) {
      const parts = [prof.fullName, prof.address1, [prof.city, prof.state, prof.postalCode].filter(Boolean).join(' ')].filter(Boolean);
      profileLine += `<span class="checkout-profile-line">${escHtml(parts.join(' · '))}</span>`;
    }
    if (prof.cardBrand || prof.cardLast4) {
      const card = [prof.cardBrand, prof.cardLast4 ? `****${prof.cardLast4}` : ''].filter(Boolean).join(' ');
      profileLine += `<span class="checkout-card-line">${escHtml(card)}</span>`;
    }
    checkoutHTML = `<div class="checkout-panel">
      <div class="checkout-panel-header">
        <span class="checkout-panel-badge">Checkout Ready</span>
        <span class="checkout-sizes-label">${sizesLabel || '1 item'}</span>
      </div>
      ${profileLine ? `<div class="checkout-profile-hint">${profileLine}</div>` : ''}
    </div>`;
  }

  return `
<div class="release-row" id="row-${p.id}" data-id="${p.id}">
  ${checking ? '<div class="scanning-bar"></div>' : ''}
  ${imgHTML}
  <div class="row-info">
    <div class="row-name">${escHtml(p.name || p.url)}</div>
    <div class="row-meta">
      <span class="row-store">${escHtml(p.store || '')}</span>
      ${priceHTML}
    </div>
    <div class="row-release">
      <span class="release-badge ${badgeClass}">${badgeText}</span>
      ${releaseHTML}
    </div>
    ${sizesHTML}
    ${errHTML}
    ${checkoutHTML}
  </div>
  <div class="row-action">
    ${cartBtn}
    <a class="btn-row-open" href="${escHtml(p.url)}" target="_blank" rel="noopener">Open ↗</a>
    <button class="btn-row-remove" data-action="remove" data-id="${p.id}" title="Stop tracking">✕</button>
  </div>
</div>`;
}

function attachRowHandlers(id) {
  const row = el(`row-${id}`);
  if (!row) return;
  row.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', e => {
      const action = e.currentTarget.dataset.action;
      const pid    = e.currentTarget.dataset.id;
      if (action === 'cart')   handleCart(pid);
      if (action === 'remove') handleRemove(pid);
    });
  });
}

// ── Cart ──────────────────────────────────────────────────────────────────────
async function handleCart(id) {
  if (state.carting.has(id)) return;
  state.carting.add(id);
  renderAll();
  try {
    const res  = await fetch(`${API}/api/products/${id}/cart`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      const idx = state.products.findIndex(p => p.id === id);
      if (idx !== -1) state.products[idx] = { ...state.products[idx], ...(data.product || {}), inCart: true };
      toast('success', '✅ In Cart', state.products.find(p => p.id === id)?.name || 'Product');
    } else {
      toast('error', 'Cart failed', data.error || 'Unknown error');
    }
  } catch (e) {
    toast('error', 'Cart error', e.message);
  } finally {
    state.carting.delete(id);
    renderAll();
  }
}

// ── Remove ────────────────────────────────────────────────────────────────────
async function handleRemove(id) {
  const p = state.products.find(x => x.id === id);
  if (!confirm(`Stop tracking "${p?.name || p?.url || id}"?`)) return;
  try {
    await fetch(`${API}/api/products/${id}`, { method: 'DELETE' });
    state.products = state.products.filter(x => x.id !== id);
    renderAll();
  } catch (e) {
    toast('error', 'Remove failed', e.message);
  }
}

// ── Add URL ───────────────────────────────────────────────────────────────────
el('btn-add').addEventListener('click', () => openModal('modal-add'));

el('btn-add-submit').addEventListener('click', async () => {
  const url = el('add-url').value.trim();
  const errEl = el('add-error');
  errEl.classList.add('hidden');
  if (!url) { errEl.textContent = 'Enter a URL.'; errEl.classList.remove('hidden'); return; }

  const txt = el('add-btn-text');
  const sp  = el('add-btn-spinner');
  txt.textContent = 'Tracking…';
  sp.classList.remove('hidden');
  el('btn-add-submit').disabled = true;

  try {
    const res  = await fetch(`${API}/api/products`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');
    el('add-url').value = '';
    closeModal('modal-add');
  } catch (e) {
    errEl.textContent = e.message;
    errEl.classList.remove('hidden');
  } finally {
    txt.textContent = 'Track';
    sp.classList.add('hidden');
    el('btn-add-submit').disabled = false;
  }
});

// ── Refresh ───────────────────────────────────────────────────────────────────
el('btn-refresh').addEventListener('click', async () => {
  el('btn-refresh').disabled = true;
  el('btn-refresh').textContent = '↻ Checking…';
  try {
    await fetch(`${API}/api/check-all`, { method: 'POST' });
    toast('info', 'Checking all products…', 'Updates will appear shortly');
  } catch (e) {
    toast('error', 'Refresh failed', e.message);
  } finally {
    setTimeout(() => { el('btn-refresh').disabled = false; el('btn-refresh').textContent = '↻ Refresh'; }, 3000);
  }
});

// ── Profile modal ─────────────────────────────────────────────────────────────
el('btn-profile').addEventListener('click', () => openModal('modal-profile'));

el('btn-save-profile').addEventListener('click', async () => {
  el('btn-save-profile').disabled = true;
  el('btn-save-profile').textContent = 'Saving…';
  try {
    await saveProfile();
    await saveSettings();
    closeModal('modal-profile');
    toast('success', 'Profile saved', 'Your info has been updated');
  } catch (e) {
    toast('error', 'Save failed', e.message);
  } finally {
    el('btn-save-profile').disabled = false;
    el('btn-save-profile').textContent = 'Save';
  }
});

async function saveProfile() {
  const profile = {
    fullName:  el('checkout-full-name').value.trim(),
    email:     el('checkout-email').value.trim(),
    phone:     el('checkout-phone').value.trim(),
    address1:  el('checkout-address1').value.trim(),
    address2:  el('checkout-address2').value.trim(),
    city:      el('checkout-city').value.trim(),
    state:     el('checkout-state').value.trim(),
    postalCode:el('checkout-postal').value.trim(),
    country:   el('checkout-country').value.trim(),
    payment: {
      label: el('checkout-payment-label').value.trim(),
      brand: el('checkout-card-brand').value.trim(),
      last4: el('checkout-card-last4').value.trim(),
    },
    siteCredentials: {},
  };

  // Collect site credentials
  const sites = ['nike.com', 'adidas.com', 'footlocker.com', 'eastbay.com', 'champssports.com', 'finishline.com', 'stockx.com', 'goat.com', 'stadiumgoods.com', 'supremenewyork.com'];
  for (const site of sites) {
    const user = el(`site-${site}-user`)?.value.trim();
    const pass = el(`site-${site}-pass`)?.value.trim();
    if (user && pass) {
      profile.siteCredentials[site] = { username: user, password: pass };
    }
  }

  const res = await fetch(`${API}/api/checkout-profile`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(profile),
  });
  if (!res.ok) throw new Error('Profile save failed');
  state.checkoutProfile = await res.json();
}

async function saveSettings() {
  const emailEnabled = el('set-email-enabled').checked;
  const settings = {
    checkIntervalMinutes: parseInt(el('set-interval').value) || 5,
    emailEnabled,
  };
  if (emailEnabled) {
    settings.emailHost = el('set-email-host').value.trim();
    settings.emailPort = parseInt(el('set-email-port').value) || 587;
    settings.emailUser = el('set-email-user').value.trim();
    const pass = el('set-email-pass').value;
    if (pass && pass !== '***') settings.emailPass = pass;
    settings.emailTo = el('set-email-to').value.trim();
  }
  const res = await fetch(`${API}/api/settings`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  if (!res.ok) throw new Error('Settings save failed');
}

function applyProfileToForm() {
  const p = state.checkoutProfile || {};
  const set = (id, val) => { const e = el(id); if (e) e.value = val || ''; };
  set('checkout-full-name', p.fullName);
  set('checkout-email',     p.email);
  set('checkout-phone',     p.phone);
  set('checkout-address1',  p.address1);
  set('checkout-address2',  p.address2);
  set('checkout-city',      p.city);
  set('checkout-state',     p.state);
  set('checkout-postal',    p.postalCode);
  set('checkout-country',   p.country);
  const pay = p.payment || {};
  set('checkout-payment-label', pay.label);
  set('checkout-card-brand',    pay.brand);
  set('checkout-card-last4',    pay.last4);

  // Apply site credentials
  const creds = p.siteCredentials || {};
  for (const [site, cred] of Object.entries(creds)) {
    set(`site-${site}-user`, cred.username);
    set(`site-${site}-pass`, cred.password);
  }
}

function applySettingsToForm() {
  const s = state.settings || {};
  if (s.checkIntervalMinutes) el('set-interval').value = s.checkIntervalMinutes;
  const enabled = !!s.emailEnabled;
  el('set-email-enabled').checked = enabled;
  el('email-fields').classList.toggle('hidden', !enabled);
  if (s.emailHost) el('set-email-host').value = s.emailHost;
  if (s.emailPort) el('set-email-port').value = s.emailPort;
  if (s.emailUser) el('set-email-user').value = s.emailUser;
  if (s.emailPass) el('set-email-pass').value = '***';
  if (s.emailTo)   el('set-email-to').value   = s.emailTo;
}

// Toggle email fields visibility
el('set-email-enabled').addEventListener('change', e => {
  el('email-fields').classList.toggle('hidden', !e.target.checked);
});

// ── Modal helpers ─────────────────────────────────────────────────────────────
function openModal(id)  { el(id).classList.add('open'); }
function closeModal(id) { el(id).classList.remove('open'); }

document.querySelectorAll('.modal-close, [data-modal]').forEach(btn => {
  btn.addEventListener('click', e => {
    const target = e.currentTarget.dataset.modal || e.currentTarget.closest('.modal-overlay')?.id;
    if (target) closeModal(target);
  });
});
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(overlay.id); });
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') document.querySelectorAll('.modal-overlay.open').forEach(m => closeModal(m.id));
});

// ── Connection status ─────────────────────────────────────────────────────────
function setConn(status, label) {
  const pill = el('conn-status');
  const dot  = pill.querySelector('.conn-dot');
  const lbl  = pill.querySelector('.conn-label');
  pill.className = `conn-pill ${status}`;
  lbl.textContent = label;
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function toast(type, title, msg) {
  const icons = { success: '✅', error: '❌', info: 'ℹ️', warning: '⚠️' };
  const c = el('toast-container');
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.innerHTML = `<span class="toast-icon">${icons[type] || 'ℹ️'}</span><div class="toast-text"><div class="toast-title">${escHtml(title)}</div>${msg ? `<div class="toast-msg">${escHtml(msg)}</div>` : ''}</div>`;
  c.appendChild(t);
  setTimeout(() => { t.classList.add('removing'); setTimeout(() => t.remove(), 300); }, 4000);
}
