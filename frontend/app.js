/* =============================================================================
   SpeedBuyer — Nike Monitor Frontend
   Single-file JS: state management, Socket.io, API calls, UI rendering
============================================================================= */

const API = window.location.protocol === 'file:' ? 'http://localhost:3001' : '';

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  products  : [],   // { id, name, price, inStock, availableSizes, image, ... }
  alerts    : [],   // { id, type, message, productName, timestamp, ... }
  settings  : {},
  status    : {},
  checking  : new Set(), // product IDs currently being force-checked
};

// ── Socket.io ─────────────────────────────────────────────────────────────────
const socket = io(API, { transports: ['websocket', 'polling'] });

socket.on('connect', () => {
  setConnStatus('connected', 'Live');
});

socket.on('disconnect', () => {
  setConnStatus('error', 'Disconnected');
});

socket.on('connect_error', () => {
  setConnStatus('error', 'Cannot connect');
});

socket.on('init', ({ products, alerts, settings, status }) => {
  state.products = products || [];
  state.alerts   = alerts   || [];
  state.settings = settings || {};
  state.status   = status   || {};
  renderAll();
  applySettingsToForm();
});

socket.on('product:added', product => {
  state.products.push(product);
  renderProducts();
  updateStats();
  toast('success', 'Product added', product.name);
});

socket.on('product:updated', data => {
  const idx = state.products.findIndex(p => p.id === data.id);
  if (idx !== -1) {
    state.products[idx] = { ...state.products[idx], ...data };
    renderProductCard(state.products[idx]);
  }
  state.checking.delete(data.id);
  updateStats();
});

socket.on('product:removed', ({ id }) => {
  state.products = state.products.filter(p => p.id !== id);
  document.getElementById(`card-${id}`)?.remove();
  updateStats();
  if (state.products.length === 0) showEmptyState();
});

socket.on('product:error', ({ id, error }) => {
  state.checking.delete(id);
  const idx = state.products.findIndex(p => p.id === id);
  if (idx !== -1) {
    state.products[idx].lastError = error;
    renderProductCard(state.products[idx]);
  }
  toast('error', 'Scrape error', error);
});

socket.on('alert:new', alert => {
  state.alerts.unshift(alert);
  prependAlertItem(alert);
  updateStats();
  flashCard(alert.productId);
  // Browser notification
  showBrowserNotification(alert);
});

socket.on('alerts:cleared', () => {
  state.alerts = [];
  renderAlerts();
  updateStats();
});

socket.on('monitor:checking', ({ count, time }) => {
  state.status.lastCheckTime = time;
  updateStats();
  el('stat-last-check').textContent = 'Checking…';
});

socket.on('monitor:done', ({ time }) => {
  state.status.lastCheckTime = time;
  updateStats();
});

// ── Render all ────────────────────────────────────────────────────────────────
function renderAll() {
  renderProducts();
  renderAlerts();
  updateStats();
}

// ── Products ──────────────────────────────────────────────────────────────────
function renderProducts() {
  const grid = el('products-grid');
  grid.innerHTML = '';

  if (state.products.length === 0) {
    showEmptyState();
    return;
  }

  hideEmptyState();
  state.products.forEach(p => {
    const div = document.createElement('div');
    div.innerHTML = buildCardHTML(p);
    grid.appendChild(div.firstElementChild);
    attachCardHandlers(p.id);
  });
}

function renderProductCard(product) {
  const existing = el(`card-${product.id}`);
  const html     = buildCardHTML(product);
  if (existing) {
    const div      = document.createElement('div');
    div.innerHTML  = html;
    existing.replaceWith(div.firstElementChild);
    attachCardHandlers(product.id);
  } else {
    const grid = el('products-grid');
    const div  = document.createElement('div');
    div.innerHTML = html;
    grid.appendChild(div.firstElementChild);
    attachCardHandlers(product.id);
  }
}

function buildCardHTML(p) {
  const checking = state.checking.has(p.id);

  // Status badge
  let badgeClass, badgeText;
  if (p.inStock === true)  { badgeClass = 'badge-instock';  badgeText = 'In Stock'; }
  else if (p.inStock === false) { badgeClass = 'badge-outstock'; badgeText = 'Sold Out'; }
  else                     { badgeClass = 'badge-unknown';  badgeText = 'Unknown'; }

  // Price display
  let priceHTML = '<span class="card-price">—</span>';
  if (p.price !== null && p.price !== undefined) {
    const fmt      = `$${p.price.toFixed(2)}`;
    const origHTML = (p.originalPrice && p.originalPrice !== p.price)
      ? `<span class="price-orig">$${p.originalPrice.toFixed(2)}</span>` : '';
    priceHTML = `<div class="card-price">${fmt}${origHTML}</div>`;
  }

  const releaseHTML = p.releaseDate ? buildReleaseHTML(p.releaseDate) : '';

  // Size chips
  let sizesHTML = '';
  if (p.availableSizes && p.availableSizes.length > 0) {
    const chips = p.availableSizes.map(s =>
      `<span class="size-chip ${s.available ? 'available' : 'sold-out'}" title="${s.available ? 'Available' : 'Sold out'}">${escHtml(s.size)}</span>`
    ).join('');
    sizesHTML = `<div class="sizes-label">Sizes</div><div class="sizes-grid">${chips}</div>`;
  }

  // Error
  const errorHTML = p.lastError
    ? `<div class="card-error">⚠ ${escHtml(p.lastError)}</div>` : '';

  // Image
  const imgHTML = p.image
    ? `<img class="card-image" src="${escHtml(p.image)}" alt="${escHtml(p.name)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" /><div class="card-image-placeholder" style="display:none">👟</div>`
    : `<div class="card-image-placeholder">👟</div>`;

  return `
<div class="product-card" id="card-${p.id}" data-id="${p.id}">
  ${checking ? '<div class="card-checking-bar"></div>' : ''}
  ${imgHTML}
  <div class="card-body">
    <div class="card-top">
      <div class="card-name">${escHtml(p.name)}</div>
      <span class="card-badge ${badgeClass}">${badgeText}</span>
    </div>
    <div class="card-meta">
      ${p.styleCode ? `<span>${escHtml(p.styleCode)}</span>` : ''}
      ${p.colorway  ? ` · <span>${escHtml(p.colorway)}</span>` : ''}
    </div>
    ${priceHTML}
    ${releaseHTML}
    ${errorHTML}
    ${sizesHTML}
    <div class="card-footer">
      <span class="card-last-check">${p.lastChecked ? 'Checked ' + timeAgo(p.lastChecked) : 'Not checked yet'}</span>
      <div class="card-actions">
        <button class="btn btn-ghost btn-sm btn-check-now" data-id="${p.id}" ${checking ? 'disabled' : ''} title="Check now">↻</button>
        <button class="btn btn-danger btn-sm btn-remove" data-id="${p.id}" title="Remove">✕</button>
      </div>
    </div>
  </div>
</div>`;
}

function attachCardHandlers(id) {
  const card = el(`card-${id}`);
  if (!card) return;

  card.querySelector('.btn-check-now')?.addEventListener('click', async () => {
    state.checking.add(id);
    renderProductCard(state.products.find(p => p.id === id));
    try {
      const res = await fetch(`${API}/api/products/${id}/check`, { method: 'POST' });
      if (!res.ok) {
        const e = await res.json();
        toast('error', 'Check failed', e.error);
        state.checking.delete(id);
        renderProductCard(state.products.find(p => p.id === id));
      }
    } catch {
      toast('error', 'Check failed', 'Cannot reach server');
      state.checking.delete(id);
      renderProductCard(state.products.find(p => p.id === id));
    }
  });

  card.querySelector('.btn-remove')?.addEventListener('click', () => {
    removeProduct(id);
  });
}

async function removeProduct(id) {
  try {
    await fetch(`${API}/api/products/${id}`, { method: 'DELETE' });
  } catch {
    toast('error', 'Error', 'Cannot reach server');
  }
}

function flashCard(productId) {
  const card = el(`card-${productId}`);
  if (!card) return;
  card.classList.remove('flash-alert');
  void card.offsetWidth;
  card.classList.add('flash-alert');
}

function showEmptyState() {
  el('empty-state').style.display = '';
  el('products-grid').style.display = 'none';
}

function hideEmptyState() {
  el('empty-state').style.display = 'none';
  el('products-grid').style.display = '';
}

// ── Alerts ────────────────────────────────────────────────────────────────────
function renderAlerts() {
  const list = el('alerts-list');
  if (state.alerts.length === 0) {
    list.innerHTML = '<p class="no-alerts">No alerts yet</p>';
    return;
  }
  list.innerHTML = state.alerts.map(buildAlertHTML).join('');
}

function prependAlertItem(alert) {
  const list = el('alerts-list');
  const noMsg = list.querySelector('.no-alerts');
  if (noMsg) noMsg.remove();

  const div      = document.createElement('div');
  div.innerHTML  = buildAlertHTML(alert);
  list.insertBefore(div.firstElementChild, list.firstChild);

  // Keep DOM cap at 50
  while (list.children.length > 50) list.lastChild?.remove();
}

const ALERT_LABELS = {
  PRICE_DROP    : '📉 Price Drop',
  PRICE_RISE    : '📈 Price Rise',
  BACK_IN_STOCK : '✅ Back in Stock',
  OUT_OF_STOCK  : '❌ Sold Out',
  SIZE_AVAILABLE: '👟 New Sizes',
  RELEASE_DATE_SET: '📅 Release Date',
};

function buildAlertHTML(a) {
  return `
<div class="alert-item ${a.type}" data-id="${a.id}">
  <div class="alert-type">${ALERT_LABELS[a.type] || a.type}</div>
  <div class="alert-msg">${escHtml(a.message)}</div>
  <div class="alert-name">${escHtml(a.productName)}</div>
  <div class="alert-time">${timeAgo(a.timestamp)}</div>
</div>`;
}

// ── Stats ─────────────────────────────────────────────────────────────────────
function updateStats() {
  el('stat-monitored').textContent = state.products.length;
  el('stat-instock').textContent   = state.products.filter(p => p.inStock === true).length;

  const today  = new Date().toDateString();
  const todayAlerts = state.alerts.filter(a => new Date(a.timestamp).toDateString() === today).length;
  el('stat-alerts').textContent = todayAlerts;

  el('stat-interval').textContent = state.settings.checkIntervalMinutes
    ? `${state.settings.checkIntervalMinutes}m` : '—';

  if (state.status?.lastCheckTime) {
    el('stat-last-check').textContent = timeAgo(state.status.lastCheckTime);
  }
}

// ── Connection status ─────────────────────────────────────────────────────────
function setConnStatus(cls, label) {
  const pill = el('conn-status');
  pill.className = `status-pill ${cls}`;
  pill.querySelector('.status-label').textContent = label;
}

// ── Add product ───────────────────────────────────────────────────────────────
function openAddModal() {
  el('add-url').value = '';
  el('add-error').classList.add('hidden');
  el('add-error').textContent = '';
  el('modal-add').classList.add('open');
  setTimeout(() => el('add-url').focus(), 50);
}

async function submitAddProduct() {
  const url = el('add-url').value.trim();
  const errEl = el('add-error');

  if (!url) { showAddError('Please enter a URL'); return; }

  setAddLoading(true);

  try {
    const res  = await fetch(`${API}/api/products`, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({ url }),
    });

    const data = await res.json();

    if (!res.ok) {
      showAddError(data.error || 'Unknown error');
      return;
    }

    closeModal('modal-add');
  } catch {
    showAddError('Cannot reach server — is it running?');
  } finally {
    setAddLoading(false);
  }
}

function showAddError(msg) {
  const errEl = el('add-error');
  errEl.textContent = msg;
  errEl.classList.remove('hidden');
}

function setAddLoading(loading) {
  el('btn-add-submit').disabled = loading;
  el('add-btn-text').textContent = loading ? 'Fetching…' : 'Start Monitoring';
  el('add-btn-spinner').classList.toggle('hidden', !loading);
}

// ── Settings ──────────────────────────────────────────────────────────────────
function applySettingsToForm() {
  const s = state.settings;
  setVal('set-interval',     s.checkIntervalMinutes ?? 5);
  setChecked('set-email-enabled', s.emailEnabled ?? false);
  setVal('set-email-host',   s.emailHost   || 'smtp.gmail.com');
  setVal('set-email-port',   s.emailPort   || 587);
  setVal('set-email-user',   s.emailUser   || '');
  setVal('set-email-pass',   s.emailPass   || '');
  setVal('set-email-to',     s.emailTo     || '');
  updateEmailFieldsVisibility();
}

function updateEmailFieldsVisibility() {
  const enabled = el('set-email-enabled').checked;
  el('email-fields').style.display = enabled ? '' : 'none';
}

async function saveSettings() {
  const settings = {
    checkIntervalMinutes: parseInt(el('set-interval').value) || 5,
    emailEnabled        : el('set-email-enabled').checked,
    emailHost           : el('set-email-host').value.trim(),
    emailPort           : parseInt(el('set-email-port').value) || 587,
    emailUser           : el('set-email-user').value.trim(),
    emailPass           : el('set-email-pass').value,
    emailTo             : el('set-email-to').value.trim(),
  };

  try {
    const res = await fetch(`${API}/api/settings`, {
      method : 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify(settings),
    });

    if (!res.ok) throw new Error('Save failed');

    state.settings = { ...state.settings, ...settings, emailPass: settings.emailPass ? '***' : '' };
    updateStats();
    closeModal('modal-settings');
    toast('success', 'Settings saved', 'Check interval updated');
  } catch {
    toast('error', 'Error', 'Could not save settings');
  }
}

// ── Check all ─────────────────────────────────────────────────────────────────
async function checkAll() {
  try {
    await fetch(`${API}/api/check-all`, { method: 'POST' });
    toast('info', 'Checking…', `Running check on ${state.products.length} product(s)`);
  } catch {
    toast('error', 'Error', 'Cannot reach server');
  }
}

// ── Browser notifications ─────────────────────────────────────────────────────
function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

function showBrowserNotification(alert) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const icon = { PRICE_DROP: '📉', PRICE_RISE: '📈', BACK_IN_STOCK: '✅', OUT_OF_STOCK: '❌', SIZE_AVAILABLE: '👟', RELEASE_DATE_SET: '📅' }[alert.type] || '🔔';
  const n = new Notification(`${icon} ${alert.type.replace(/_/g, ' ')}`, {
    body: `${alert.message}\n${alert.productName}`,
    tag : alert.productId,
  });
  n.onclick = () => { window.focus(); n.close(); };
  setTimeout(() => n.close(), 6000);
}

// ── Toasts ────────────────────────────────────────────────────────────────────
const TOAST_ICONS = { success: '✓', error: '✕', info: 'ℹ', warning: '⚠' };

function toast(type, title, msg = '') {
  const container = el('toast-container');
  const div = document.createElement('div');
  div.className = `toast ${type}`;
  div.innerHTML = `
    <span class="toast-icon">${TOAST_ICONS[type] || '●'}</span>
    <div class="toast-text">
      <div class="toast-title">${escHtml(title)}</div>
      ${msg ? `<div class="toast-msg">${escHtml(msg)}</div>` : ''}
    </div>`;
  container.appendChild(div);

  setTimeout(() => {
    div.classList.add('removing');
    div.addEventListener('animationend', () => div.remove());
  }, 4000);
}

// ── Modal helpers ─────────────────────────────────────────────────────────────
function closeModal(id) {
  el(id).classList.remove('open');
}

document.addEventListener('click', e => {
  // Close on overlay click
  if (e.target.classList.contains('modal-overlay')) {
    e.target.classList.remove('open');
  }
  // Close buttons
  const btn = e.target.closest('[data-modal]');
  if (btn) closeModal(btn.dataset.modal);
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') document.querySelectorAll('.modal-overlay.open').forEach(m => m.classList.remove('open'));
});

// ── Wire up event listeners ───────────────────────────────────────────────────
function wireEvents() {
  el('btn-add').addEventListener('click', openAddModal);
  el('btn-add-empty').addEventListener('click', openAddModal);

  el('btn-add-submit').addEventListener('click', submitAddProduct);
  el('add-url').addEventListener('keydown', e => { if (e.key === 'Enter') submitAddProduct(); });

  el('btn-settings').addEventListener('click', () => {
    applySettingsToForm();
    el('modal-settings').classList.add('open');
  });
  el('btn-save-settings').addEventListener('click', saveSettings);

  el('btn-check-all').addEventListener('click', checkAll);

  el('btn-clear-alerts').addEventListener('click', async () => {
    await fetch(`${API}/api/alerts`, { method: 'DELETE' });
  });

  el('set-email-enabled').addEventListener('change', updateEmailFieldsVisibility);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function el(id)                { return document.getElementById(id); }
function setVal(id, v)         { const e = el(id); if (e) e.value = v; }
function setChecked(id, v)     { const e = el(id); if (e) e.checked = v; }
function escHtml(str)          { const d = document.createElement('div'); d.textContent = String(str ?? ''); return d.innerHTML; }

function timeAgo(iso) {
  const diff = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (diff < 5)   return 'just now';
  if (diff < 60)  return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function formatReleaseDate(iso) {
  const d = new Date(iso);
  return isNaN(d) ? 'Unknown' : d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

function timeUntil(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const diffMs = d.getTime() - Date.now();
  const absMs  = Math.abs(diffMs);
  const totalMin = Math.floor(absMs / 60000);
  const days   = Math.floor(totalMin / (60 * 24));
  const hours  = Math.floor((totalMin - days * 24 * 60) / 60);
  const mins   = totalMin % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (!days && !hours) parts.push(`${mins}m`);
  const label = parts.join(' ') || 'moments';
  return diffMs >= 0 ? `in ${label}` : `${label} ago`;
}

function buildReleaseHTML(iso) {
  return `
  <div class="card-release" data-release="${escHtml(iso)}">
    <span class="release-label">Release</span>
    <span class="release-abs">${escHtml(formatReleaseDate(iso))}</span>
    <span class="release-rel">${escHtml(timeUntil(iso))}</span>
  </div>`;
}

// Refresh relative timestamps every 30s
setInterval(() => {
  document.querySelectorAll('.card-last-check').forEach(el => {
    const card = el.closest('.product-card');
    if (!card) return;
    const id   = card.dataset.id;
    const p    = state.products.find(p => p.id === id);
    if (p?.lastChecked) el.textContent = 'Checked ' + timeAgo(p.lastChecked);
  });
  document.querySelectorAll('.card-release').forEach(el => {
    const iso = el.dataset.release;
    const rel = el.querySelector('.release-rel');
    if (iso && rel) rel.textContent = timeUntil(iso);
  });
  document.querySelectorAll('.alert-time').forEach(el => {
    const item = el.closest('.alert-item');
    if (!item) return;
    const id   = item.dataset.id;
    const a    = state.alerts.find(a => a.id === id);
    if (a?.timestamp) el.textContent = timeAgo(a.timestamp);
  });
  if (state.status?.lastCheckTime) {
    document.getElementById('stat-last-check').textContent = timeAgo(state.status.lastCheckTime);
  }
}, 30_000);

// ── Init ──────────────────────────────────────────────────────────────────────
wireEvents();
requestNotificationPermission();
showEmptyState(); // default until init arrives
