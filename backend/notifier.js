const nodemailer = require('nodemailer');
const storage    = require('./storage');

const TYPE_EMOJI = {
  PRICE_DROP    : '📉',
  PRICE_RISE    : '📈',
  BACK_IN_STOCK : '✅',
  OUT_OF_STOCK  : '❌',
  SIZE_AVAILABLE: '👟',
  RELEASE_DATE_SET: '📅',
  CART_ADDED    : '🛒',
  PURCHASE_WINDOW_READY: '⏰',
};

async function sendAlert(alert) {
  console.log(`[Alert] ${TYPE_EMOJI[alert.type] || '🔔'} ${alert.message}`);

  const settings = storage.getSettings();
  if (!settings.emailEnabled || !settings.emailTo || !settings.emailUser || !settings.emailPass) return;

  // Support comma-separated recipient list
  const recipients = settings.emailTo
    .split(',')
    .map(e => e.trim())
    .filter(Boolean)
    .join(', ');

  try {
    const transport = nodemailer.createTransport({
      host  : settings.emailHost,
      port  : settings.emailPort,
      secure: settings.emailPort === 465,
      auth  : { user: settings.emailUser, pass: settings.emailPass },
    });

    await transport.sendMail({
      from   : `"SpeedBuyer Monitor" <${settings.emailUser}>`,
      to     : recipients,
      subject: `[SpeedBuyer] ${alert.type.replace(/_/g, ' ')}: ${alert.productName}`,
      html   : buildHtml(alert),
    });

    console.log(`[Alert] Email sent → ${recipients}`);
  } catch (err) {
    console.error('[Alert] Email failed:', err.message);
  }
}

function buildHtml(alert) {
  const COLOR_MAP = {
    PRICE_DROP    : '#22c55e',
    PRICE_RISE    : '#ef4444',
    BACK_IN_STOCK : '#22c55e',
    OUT_OF_STOCK  : '#ef4444',
    SIZE_AVAILABLE: '#f59e0b',
    RELEASE_DATE_SET: '#3b82f6',
    CART_ADDED    : '#3b82f6',
    PURCHASE_WINDOW_READY: '#f59e0b',
  };
  const color = COLOR_MAP[alert.type] || '#6366f1';
  const emoji = TYPE_EMOJI[alert.type] || '🔔';
  const typeLabel = alert.type.replace(/_/g, ' ');

  // Product details (attached by monitor.js when calling sendAlert)
  const {
    productName,
    message,
    url,
    timestamp,
    productImage,
    productPrice,
    productColorway,
    productSizes,
    productStyleCode,
    productReleaseDate,
  } = alert;

  const imageSection = productImage
    ? `<img src="${productImage}" alt="${productName}" style="width:100%;max-height:300px;object-fit:cover;display:block;" />`
    : '';

  const priceSection = productPrice !== undefined && productPrice !== null
    ? `<p style="margin:10px 0 0;font-size:28px;font-weight:900;color:#fff;">$${Number(productPrice).toFixed(2)}</p>`
    : '';

  const colorwaySection = productColorway
    ? `<p style="margin:6px 0 0;color:#aaa;font-size:13px;">Colorway: <strong style="color:#fff;">${productColorway}</strong></p>`
    : '';

  const styleSection = productStyleCode
    ? `<p style="margin:4px 0 0;color:#666;font-size:12px;">Style: ${productStyleCode}</p>`
    : '';

  const releaseSection = productReleaseDate
    ? `<p style="margin:10px 0 0;color:#aaa;font-size:13px;">Release: <strong style="color:#fff;">${formatReleaseDate(productReleaseDate)}</strong></p>`
    : '';

  const availableSizes = Array.isArray(productSizes)
    ? productSizes.filter(s => s.available).map(s => s.size)
    : [];
  const sizesSection = availableSizes.length > 0
    ? `<div style="margin-top:14px;">
         <p style="margin:0 0 6px;color:#aaa;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;">Available Sizes</p>
         <div style="display:flex;flex-wrap:wrap;gap:6px;">
           ${availableSizes.map(s => `<span style="background:#22c55e22;color:#22c55e;border:1px solid #22c55e44;padding:4px 10px;border-radius:5px;font-size:12px;font-weight:700;">${s}</span>`).join('')}
         </div>
       </div>`
    : '';

  const ctaButton = url
    ? `<a href="${url}" style="display:inline-block;margin-top:24px;background:#fff;color:#000;padding:14px 30px;text-decoration:none;border-radius:8px;font-weight:800;font-size:15px;letter-spacing:0.3px;">View on Nike →</a>`
    : '';

  return `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:20px;background:#0a0a0a;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:600px;margin:0 auto;background:#111;border-radius:14px;overflow:hidden;border:1px solid #222;">

    <!-- Header -->
    <div style="background:#0d0d0d;padding:20px 28px;border-bottom:2px solid ${color};display:flex;align-items:center;justify-content:space-between;">
      <div>
        <span style="font-size:22px;font-weight:900;color:#fff;letter-spacing:-0.5px;">⚡ SpeedBuyer</span>
        <p style="margin:3px 0 0;color:#666;font-size:12px;text-transform:uppercase;letter-spacing:1px;">Nike Product Monitor</p>
      </div>
      <span style="background:${color}22;color:${color};border:1px solid ${color}55;padding:6px 14px;border-radius:99px;font-size:12px;font-weight:700;text-transform:uppercase;">${typeLabel}</span>
    </div>

    <!-- Product image -->
    ${imageSection}

    <!-- Alert banner -->
    <div style="background:${color}18;border-left:4px solid ${color};margin:20px 28px 0;padding:14px 18px;border-radius:4px;">
      <p style="margin:0;font-size:20px;font-weight:800;color:${color};">${emoji} ${typeLabel}</p>
      <p style="margin:6px 0 0;color:#ddd;font-size:14px;line-height:1.5;">${message}</p>
    </div>

    <!-- Product details -->
    <div style="padding:20px 28px;">
      <h2 style="margin:0;font-size:20px;font-weight:800;color:#fff;line-height:1.3;">${productName}</h2>
      ${priceSection}
      ${releaseSection}
      ${colorwaySection}
      ${styleSection}
      ${sizesSection}
      ${ctaButton}
    </div>

    <!-- Footer -->
    <div style="background:#0d0d0d;padding:14px 28px;border-top:1px solid #222;">
      <p style="margin:0;color:#444;font-size:11px;">Alert triggered: ${new Date(timestamp).toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' })}</p>
      <p style="margin:4px 0 0;color:#333;font-size:10px;">You're receiving this because you set up SpeedBuyer monitoring.</p>
    </div>
  </div>
</body>
</html>`;
}

function formatReleaseDate(iso) {
  try {
    return new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

module.exports = { sendAlert };
