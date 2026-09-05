const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const ExcelJS = require('exceljs');
const QRCode = require('qrcode');
const db = require('./db/db');
const escpos = require('./printer/escpos');

let mainWindow;

// ---------- Staff session (in-memory, main-process-only) ----------
// This is deliberately not stored anywhere the renderer can read or set
// directly — every privileged ipcMain.handle below checks it via
// requireRole() before doing anything, which is what makes "staff can't
// touch Menu/Settings" a real restriction rather than just a hidden tab: a
// staff member opening DevTools and calling window.pos.menu.delete(...)
// directly would otherwise bypass any renderer-side-only check entirely.
let currentStaff = null; // { id, name, role } while logged in, else null

// Mobile ordering clients (phones/tablets over LAN, see the "Mobile
// ordering server" section near the end of this file) each get their own
// session here instead of sharing currentStaff — otherwise one phone
// logging in would silently log out the desktop (and vice versa), since
// there'd be only one global session for the whole process. Token -> {id,
// name, role}, in-memory only, cleared on app restart — same lifetime
// model currentStaff itself already has.
const sessions = new Map();

function requireLoginFor(session) {
  if (!session) throw new Error('Not logged in');
}

function requireRoleFor(session, ...roles) {
  if (!session || !roles.includes(session.role)) {
    throw new Error('Not authorized for this action');
  }
}

// Desktop IPC handlers keep calling these zero-arg forms unchanged — they
// just delegate to currentStaff, so every existing requireRole(...)/
// requireLogin() call site behaves exactly as before.
function requireRole(...roles) {
  requireRoleFor(currentStaff, ...roles);
}

function requireLogin() {
  requireLoginFor(currentStaff);
}

// scrypt, not bcrypt — Node's built-in crypto covers this without adding a
// dependency (this repo has exactly three: better-sqlite3, exceljs,
// qrcode). Salt is per-staff and random; verifyPin uses a fixed-length,
// timing-safe comparison rather than ===, since a PIN is compared against
// attacker-controllable input here (whoever is standing at the terminal).
function hashPin(pin, salt) {
  return crypto.scryptSync(String(pin), salt, 64).toString('hex');
}

function verifyPin(pin, salt, expectedHash) {
  const actual = Buffer.from(hashPin(pin, salt), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// Shared by staff:login and the mobile server's own login route — a PIN
// isn't scoped to a particular name, so this scans every active staff
// member's hash, same as staff:login always has.
function findStaffByPin(pin) {
  const candidates = db.prepare('SELECT * FROM staff WHERE is_active = 1').all();
  return candidates.find((s) => verifyPin(pin, s.pin_salt, s.pin_hash)) || null;
}

function toStaffView(row) {
  return { id: row.id, name: row.name, role: row.role, isActive: !!row.is_active };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 680,
    title: 'Restaurant POS',
    backgroundColor: '#1C1B19',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  syncMobileServer();
});

app.on('window-all-closed', () => {
  stopMobileServer();
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ---------- Helpers ----------
// GST is computed per line item (each menu item carries its own rate), so an
// order's tax is the sum of its lines — there's no single order-level rate to
// apply. Discount is a flat deduction from (subtotal + tax); it does not
// reduce the taxable value per line. This is a simplification, not certified
// tax software — verify against your accountant's requirements before relying
// on it for GST filing.
// Discount is clamped to [0, subtotal + tax] here — the one place every order
// mutation (item add/remove/qty change, discount edit) funnels through —
// so a bill can never be pushed negative regardless of what was requested.
function recalcOrder(orderId) {
  const items = db.prepare('SELECT unit_price, quantity, tax_amount FROM order_items WHERE order_id = ?').all(orderId);
  const subtotal = items.reduce((sum, i) => sum + Number(i.unit_price) * i.quantity, 0);
  const taxAmount = +items.reduce((sum, i) => sum + Number(i.tax_amount), 0).toFixed(2);
  const order = db.prepare('SELECT discount FROM orders WHERE id = ?').get(orderId);
  const maxDiscount = +(subtotal + taxAmount).toFixed(2);
  const discount = Math.min(Math.max(Number(order.discount) || 0, 0), maxDiscount);
  const total = +((subtotal - discount) + taxAmount).toFixed(2);
  db.prepare('UPDATE orders SET subtotal = ?, tax_amount = ?, discount = ?, total = ? WHERE id = ?')
    .run(subtotal.toFixed(2), taxAmount, discount, total, orderId);
}

function lineTax(unitPrice, quantity, gstRate) {
  return +((Number(unitPrice) * quantity * Number(gstRate)) / 100).toFixed(2);
}

function assertValidGstRate(rate) {
  const n = Number(rate);
  if (!Number.isFinite(n) || n < 0) throw new Error('GST rate must be a non-negative number');
  return n;
}

function getSettingsMap() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const map = {};
  rows.forEach((r) => { map[r.key] = r.value; });
  return map;
}

function getBusinessSettings(settings = getSettingsMap()) {
  return {
    name: settings.business_name || '',
    address: settings.business_address || '',
    phone: settings.business_phone || '',
    gstin: settings.gstin || '',
    fssaiNo: settings.fssai_no || '',
    footerNote: settings.footer_note || '',
    zomatoRestaurantId: settings.zomato_restaurant_id || '',
  };
}

// Shared by billing:getReceipt and receipt:print/testPrint: assembles an
// order's items, GST HSN/rate/CGST/SGST breakdown (grouped exactly like
// billing:getReceipt always has), and the current business header info —
// everything a receipt needs except the payment-QR data URL, which only
// billing:getReceipt attaches (async, and only for a paid order).
function assembleReceiptData(orderId) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) throw new Error('Order not found');
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(orderId);
  const payments = db.prepare('SELECT mode, amount FROM order_payments WHERE order_id = ? ORDER BY id').all(orderId);

  // Group lines by (HSN code, GST rate) — CGST/SGST assume a single, intra-state
  // business (no inter-state IGST handling).
  const groups = new Map();
  items.forEach((i) => {
    const key = `${i.hsn_code || ''}|${i.gst_rate}`;
    if (!groups.has(key)) {
      groups.set(key, { hsnCode: i.hsn_code || '', gstRate: Number(i.gst_rate), taxableAmount: 0, cgst: 0, sgst: 0 });
    }
    const g = groups.get(key);
    g.taxableAmount += Number(i.unit_price) * i.quantity;
    g.cgst += Number(i.tax_amount) / 2;
    g.sgst += Number(i.tax_amount) / 2;
  });
  const gstBreakdown = Array.from(groups.values()).map((g) => ({
    hsnCode: g.hsnCode,
    gstRate: g.gstRate,
    taxableAmount: +g.taxableAmount.toFixed(2),
    cgst: +g.cgst.toFixed(2),
    sgst: +g.sgst.toFixed(2),
  }));

  const business = getBusinessSettings();

  return { order, items: attachModifiers(items), gstBreakdown, business, payments };
}

// Server-side equivalent of the escapeHtml() in src/renderer.js — that one
// relies on a DOM element and can't be required across the main/renderer
// process boundary, so the receipt-print HTML built here gets its own copy.
function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// printer_mode defaults to 'dialog' whenever unset/empty — every existing
// install has no such setting yet and must keep behaving exactly as before
// this feature existed (renderer falls back to window.print()) until the
// owner explicitly opts into 'system' or 'network' printing in Settings.
function getPrinterSettings(settings = getSettingsMap()) {
  return {
    mode: settings.printer_mode || 'dialog',
    systemName: settings.printer_system_name || '',
    networkHost: settings.printer_network_host || '',
    networkPort: settings.printer_network_port ? Number(settings.printer_network_port) : 9100,
    paperWidthMm: settings.printer_paper_width || '80',
  };
}

// Minimal, receipt-only HTML document for the 'system' print path — NOT the
// full app UI (src/index.html). Mirrors renderReceipt() in src/renderer.js
// content-for-content (business header, invoice/order #, date, order type +
// table, items table, subtotal/discount/tax/total, GST HSN/rate/CGST/SGST
// breakdown, payment mode, footer note); the UPI QR code is intentionally
// left out here too, to keep this generated page's content identical to
// what printer/escpos.js's ESC/POS builder produces for the network path.
function paymentBreakdownText(order, payments) {
  if (payments && payments.length > 1) {
    return 'Paid via: ' + payments.map((p) => `${escpos.capitalize(p.mode)} ₹${Number(p.amount).toFixed(2)}`).join(', ');
  }
  return order.payment_mode ? 'Paid via ' + order.payment_mode : '';
}

function buildReceiptHtml({ business = {}, order = {}, items = [], gstBreakdown = [], payments = [], paperWidthMm } = {}) {
  const widthMm = paperWidthMm === '58' ? 58 : 80;
  const money = (n) => Number(n || 0).toFixed(2);
  const rawDate = order.paid_at || order.created_at;
  const dateStr = rawDate ? new Date(String(rawDate).replace(' ', 'T') + 'Z').toLocaleString() : '';

  const row = (label, value, cls) =>
    `<div class="row${cls ? ' ' + cls : ''}"><span>${escapeHtml(label)}</span><span>${value}</span></div>`;

  const headerHtml = [
    business.name ? `<div class="biz-name">${escapeHtml(business.name)}</div>` : '',
    business.address ? `<div>${escapeHtml(business.address)}</div>` : '',
    business.phone ? `<div>Ph: ${escapeHtml(business.phone)}</div>` : '',
    business.gstin ? `<div>GSTIN: ${escapeHtml(business.gstin)}</div>` : '',
    business.fssaiNo ? `<div>FSSAI: ${escapeHtml(business.fssaiNo)}</div>` : '',
  ].join('');

  const metaHtml = [
    row(order.invoice_number ? 'Invoice #' : 'Order #', escapeHtml(order.invoice_number || String(order.id != null ? order.id : ''))),
    row('Date', escapeHtml(dateStr)),
    row('Type', escapeHtml((order.order_type || '') + (order.table_label ? ' - ' + order.table_label : ''))),
    order.source === 'zomato'
      ? row('Source', escapeHtml('Zomato' + (business.zomatoRestaurantId ? ' - ' + business.zomatoRestaurantId : '')))
      : '',
  ].join('');

  const itemsRows = items.map((i) => {
    const modNames = (i.modifiers || []).map((m) => m.name).join(', ');
    return `
    <tr>
      <td>${escapeHtml(i.item_name)}${modNames ? `<div class="item-mods">${escapeHtml(modNames)}</div>` : ''}</td>
      <td class="num">${Number(i.quantity) || 0}</td>
      <td class="num">${money(i.unit_price)}</td>
      <td class="num">${money(Number(i.unit_price) * Number(i.quantity))}</td>
    </tr>`;
  }).join('');

  const gstRows = (gstBreakdown || []).filter((g) => Number(g.gstRate) > 0);
  const gstHtml = gstRows.length ? `
    <div class="section-title">GST Details</div>
    <table class="tbl">
      <thead><tr><th>HSN</th><th class="num">Tax%</th><th class="num">CGST</th><th class="num">SGST</th></tr></thead>
      <tbody>${gstRows.map((g) => `
        <tr>
          <td>${escapeHtml(g.hsnCode || '-')}</td>
          <td class="num">${g.gstRate}</td>
          <td class="num">${money(g.cgst)}</td>
          <td class="num">${money(g.sgst)}</td>
        </tr>`).join('')}</tbody>
    </table>` : '';

  const paymentText = paymentBreakdownText(order, payments);
  const paymentHtml = paymentText ? `<div class="center">${escapeHtml(paymentText)}</div>` : '';
  const footerHtml = business.footerNote ? `<div class="center footer">${escapeHtml(business.footerNote)}</div>` : '';

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  @page { size: ${widthMm}mm auto; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    width: ${widthMm}mm;
    padding: 2mm;
    font-family: 'Courier New', Courier, monospace;
    font-size: 11px;
    line-height: 1.35;
    color: #000;
    background: #fff;
  }
  .center { text-align: center; }
  .biz-name { font-weight: bold; font-size: 14px; }
  .row { display: flex; justify-content: space-between; gap: 4px; }
  .total-line { font-weight: bold; font-size: 12px; }
  .section-title { font-weight: bold; margin-top: 4px; }
  hr { border: none; border-top: 1px dashed #000; margin: 3px 0; }
  table.tbl { width: 100%; border-collapse: collapse; margin-top: 2px; }
  table.tbl th, table.tbl td { text-align: left; padding: 1px 2px; font-size: 10px; }
  table.tbl th.num, table.tbl td.num { text-align: right; }
  .item-mods { font-size: 9px; font-style: italic; }
  .footer { margin-top: 6px; }
</style>
</head>
<body>
  <div class="center">${headerHtml}</div>
  <hr>
  ${metaHtml}
  <hr>
  <div class="section-title">Items</div>
  <table class="tbl">
    <thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Amt</th></tr></thead>
    <tbody>${itemsRows}</tbody>
  </table>
  <hr>
  ${row('Subtotal', '₹' + money(order.subtotal))}
  ${Number(order.discount) > 0 ? row('Discount', '−₹' + money(order.discount)) : ''}
  ${row('Tax (GST)', '₹' + money(order.tax_amount))}
  ${row('Total', '₹' + money(order.total), 'total-line')}
  ${gstHtml}
  ${paymentHtml}
  ${footerHtml}
</body>
</html>`;
}

// Minimal, kitchen-only HTML document for the 'system' print path — no
// prices or GST (see buildKotBuffer() in printer/escpos.js for why). Mirrors
// that function content-for-content.
function buildKotHtml({ order = {}, items = [], paperWidthMm } = {}) {
  const widthMm = paperWidthMm === '58' ? 58 : 80;
  const typeValue = (order.order_type || '') + (order.table_label ? ' - ' + order.table_label : '');

  const itemsHtml = items.map((i) => {
    const modNames = (i.modifiers || []).map((m) => m.name).join(', ');
    return `
    <div class="kot-item">
      <div class="kot-item-row"><span>${escapeHtml(i.item_name)}</span><span>x${Number(i.quantity) || 0}</span></div>
      ${modNames ? `<div class="kot-item-notes">${escapeHtml(modNames)}</div>` : ''}
      ${i.notes ? `<div class="kot-item-notes">${escapeHtml(i.notes)}</div>` : ''}
    </div>`;
  }).join('');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  @page { size: ${widthMm}mm auto; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    width: ${widthMm}mm;
    padding: 2mm;
    font-family: 'Courier New', Courier, monospace;
    color: #000;
    background: #fff;
  }
  .center { text-align: center; }
  .kot-title { font-weight: bold; font-size: 16px; }
  .kot-meta { font-size: 11px; margin: 2px 0; }
  hr { border: none; border-top: 1px dashed #000; margin: 3px 0; }
  .kot-item { margin: 6px 0; }
  .kot-item-row { display: flex; justify-content: space-between; font-weight: bold; font-size: 15px; }
  .kot-item-notes { font-size: 12px; font-style: italic; padding-left: 4px; }
</style>
</head>
<body>
  <div class="center kot-title">KITCHEN ORDER TICKET</div>
  <div class="center kot-meta">${escapeHtml(typeValue)}${order.id != null ? ' &middot; Order #' + escapeHtml(String(order.id)) : ''}</div>
  <div class="center kot-meta">${escapeHtml(new Date().toLocaleString())}</div>
  <hr>
  ${itemsHtml}
</body>
</html>`;
}

// Prints a self-contained HTML string to an OS-installed printer via a
// hidden, offscreen BrowserWindow. Closes that window in both the success
// and failure paths so nothing leaks.
function printHtmlToSystemPrinter(html, { deviceName, paperWidthMm }) {
  return new Promise((resolve, reject) => {
    const widthMicrons = (paperWidthMm === '58' ? 58 : 80) * 1000;
    // Electron's custom pageSize can't express unbounded roll-paper length,
    // so a generous fixed height (~297mm, i.e. about an A4 sheet's worth) is
    // used instead — comfortably longer than any real receipt.
    const heightMicrons = 297 * 1000;

    const printWin = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });

    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      printWin.close();
      if (err) reject(err); else resolve();
    };

    // Fail-fast guard mirroring the network path's socket.setTimeout: if the
    // OS print subsystem never invokes the print() callback (offline printer,
    // stuck driver/spooler, etc.) or the hidden renderer never finishes/fails
    // loading, the IPC call would otherwise hang forever with a leaked window.
    const timeoutId = setTimeout(() => {
      finish(new Error(`Timed out printing to system printer "${deviceName}"`));
    }, 10000);

    printWin.webContents.once('render-process-gone', (_e, details) => {
      finish(new Error(`Printer window render process gone: ${details && details.reason}`));
    });

    printWin.webContents.once('did-finish-load', () => {
      printWin.webContents.print(
        {
          silent: true,
          printBackground: true,
          deviceName,
          margins: { marginType: 'none' },
          pageSize: { width: widthMicrons, height: heightMicrons },
        },
        (success, failureReason) => {
          if (success) finish();
          else finish(new Error(`Print failed: ${failureReason}`));
        }
      );
    });
    printWin.webContents.once('did-fail-load', (_e, _errorCode, errorDescription) => {
      finish(new Error(`Failed to prepare receipt for printing: ${errorDescription}`));
    });

    printWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  });
}

// Sends a pre-built ESC/POS buffer to a network (JetDirect/raw-port) thermal
// printer over TCP. Fails fast — via 'error' or a 5s connect/idle timeout —
// rather than letting the IPC call hang indefinitely when the printer is off
// or unreachable.
function printBufferToNetworkPrinter(buffer, { host, port }) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err); else resolve();
    };

    socket.setTimeout(5000, () => {
      finish(new Error(`Timed out connecting to network printer at ${host}:${port}`));
    });
    socket.on('error', (err) => {
      finish(new Error(`Could not reach network printer at ${host}:${port}: ${err.message}`));
    });
    socket.on('connect', () => {
      socket.write(buffer);
      socket.end();
    });
    socket.on('close', () => {
      finish();
    });

    socket.connect(Number(port) || 9100, host);
  });
}

// Shared by receipt:print and receipt:testPrint: branches on printer_mode
// and either prints for real (system/network) or leaves it to the renderer
// (dialog). Always resolves to { mode } so the renderer knows which of the
// three paths ran — for 'dialog' it must then call window.print() itself,
// exactly as it did before this feature existed.
async function printReceipt({ order, items, gstBreakdown, business, payments = [] }) {
  const { mode, systemName, networkHost, networkPort, paperWidthMm } = getPrinterSettings();

  if (mode === 'system') {
    if (!systemName) throw new Error('No system printer selected — choose one in Settings first');
    const html = buildReceiptHtml({ business, order, items, gstBreakdown, payments, paperWidthMm });
    await printHtmlToSystemPrinter(html, { deviceName: systemName, paperWidthMm });
    return { mode: 'system' };
  }

  if (mode === 'network') {
    if (!networkHost) throw new Error('No network printer host configured — set one in Settings first');
    const buffer = escpos.buildReceiptBuffer({ business, order, items, gstBreakdown, payments, paperWidthMm });
    await printBufferToNetworkPrinter(buffer, { host: networkHost, port: networkPort });
    return { mode: 'network' };
  }

  // mode === 'dialog' (or unset/unrecognized) — behavior-preserving default.
  return { mode: 'dialog' };
}

// Same three-way mode contract as printReceipt (see its comment) — resolves
// to { mode }. 'dialog' means the renderer must build and print its own
// on-screen KOT content via window.print(), same fallback as receipts.
async function printKot({ order, items }) {
  const { mode, systemName, networkHost, networkPort, paperWidthMm } = getPrinterSettings();

  if (mode === 'system') {
    if (!systemName) throw new Error('No system printer selected — choose one in Settings first');
    const html = buildKotHtml({ order, items, paperWidthMm });
    await printHtmlToSystemPrinter(html, { deviceName: systemName, paperWidthMm });
    return { mode: 'system' };
  }

  if (mode === 'network') {
    if (!networkHost) throw new Error('No network printer host configured — set one in Settings first');
    const buffer = escpos.buildKotBuffer({ order, items, paperWidthMm });
    await printBufferToNetworkPrinter(buffer, { host: networkHost, port: networkPort });
    return { mode: 'network' };
  }

  return { mode: 'dialog' };
}

function getFinancialYear(date = new Date()) {
  const year = date.getFullYear();
  const month = date.getMonth() + 1; // 1-12
  const fyStart = month >= 4 ? year : year - 1;
  const fyEndShort = String((fyStart + 1) % 100).padStart(2, '0');
  return `${fyStart}-${fyEndShort}`;
}

function getNextInvoiceNumber() {
  const fy = getFinancialYear();
  const seqKey = `invoice_seq_${fy}`;
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(seqKey);
  const next = row ? Number(row.value) + 1 : 1;
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value
  `).run(seqKey, String(next));
  const prefix = getSettingsMap().invoice_prefix || 'INV';
  return `${prefix}/${fy}/${String(next).padStart(5, '0')}`;
}

// ---------- Staff ----------
// No auth required: this is the bootstrap check the renderer makes before
// it knows whether to show "create the first owner account" or "log in".
ipcMain.handle('staff:needsSetup', () => {
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM staff').get();
  return count === 0;
});

// No auth required, but only does anything while the staff table is truly
// empty — guards against this being called later (e.g. from DevTools) to
// mint a rogue extra owner account once the restaurant is already set up.
ipcMain.handle('staff:createFirstOwner', (_e, { name, pin }) => {
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM staff').get();
  if (count > 0) throw new Error('Setup has already been completed');

  const cleanName = String(name || '').trim();
  if (!cleanName) throw new Error('Name is required');
  if (!/^\d{4,6}$/.test(String(pin || ''))) throw new Error('PIN must be 4-6 digits');

  const salt = crypto.randomBytes(16).toString('hex');
  const row = db.prepare(
    'INSERT INTO staff (name, pin_hash, pin_salt, role) VALUES (?, ?, ?, ?) RETURNING *'
  ).get(cleanName, hashPin(pin, salt), salt, 'owner');

  currentStaff = { id: row.id, name: row.name, role: row.role };
  return currentStaff;
});

// No auth required (this IS the login) — matches any active staff member's
// PIN, not scoped to a particular name, since a shared PIN pad doesn't know
// who's about to type until the PIN identifies them.
ipcMain.handle('staff:login', (_e, { pin }) => {
  const match = findStaffByPin(pin);
  if (!match) throw new Error('Incorrect PIN');
  currentStaff = { id: match.id, name: match.name, role: match.role };
  return currentStaff;
});

ipcMain.handle('staff:logout', () => {
  currentStaff = null;
  return { success: true };
});

// No auth required — this is what the renderer checks on every load so a
// window reload (Ctrl+R/F5, which restarts the renderer but not this main
// process) doesn't force a re-login: the session actually lives here, in
// main.js, not in the renderer's own currentStaff variable. A real app
// restart still clears this (it's in-memory only, never persisted to disk),
// which is intentional — that should still require a PIN.
ipcMain.handle('staff:whoAmI', () => {
  return currentStaff;
});

ipcMain.handle('staff:list', () => {
  requireRole('owner');
  return db.prepare('SELECT * FROM staff ORDER BY is_active DESC, name').all().map(toStaffView);
});

ipcMain.handle('staff:add', (_e, { name, pin, role }) => {
  requireRole('owner');
  const cleanName = String(name || '').trim();
  if (!cleanName) throw new Error('Name is required');
  if (!/^\d{4,6}$/.test(String(pin || ''))) throw new Error('PIN must be 4-6 digits');
  if (!['owner', 'manager', 'staff'].includes(role)) throw new Error('Invalid role');

  const salt = crypto.randomBytes(16).toString('hex');
  const row = db.prepare(
    'INSERT INTO staff (name, pin_hash, pin_salt, role) VALUES (?, ?, ?, ?) RETURNING *'
  ).get(cleanName, hashPin(pin, salt), salt, role);
  return toStaffView(row);
});

// Renaming/re-roling/reactivating and changing a PIN are both "update" —
// pin is optional so an owner can fix a name or role without also having
// to know/reset the PIN.
ipcMain.handle('staff:update', (_e, { id, name, pin, role, isActive }) => {
  requireRole('owner');
  const existing = db.prepare('SELECT * FROM staff WHERE id = ?').get(id);
  if (!existing) throw new Error('Staff member not found');

  const cleanName = name != null ? String(name).trim() : existing.name;
  if (!cleanName) throw new Error('Name is required');
  const nextRole = role != null ? role : existing.role;
  if (!['owner', 'manager', 'staff'].includes(nextRole)) throw new Error('Invalid role');
  const nextActive = isActive != null ? (isActive ? 1 : 0) : existing.is_active;

  // Demoting/deactivating the last owner would lock everyone out of
  // Settings/Staff management permanently — same reasoning as the
  // tables:delete guard against deleting a table with an open order.
  if (existing.role === 'owner' && (nextRole !== 'owner' || !nextActive)) {
    const { count } = db.prepare(`SELECT COUNT(*) AS count FROM staff WHERE role = 'owner' AND is_active = 1 AND id != ?`).get(id);
    if (count === 0) throw new Error('Cannot remove the last active owner account');
  }

  let salt = existing.pin_salt;
  let pinHash = existing.pin_hash;
  if (pin != null && pin !== '') {
    if (!/^\d{4,6}$/.test(String(pin))) throw new Error('PIN must be 4-6 digits');
    salt = crypto.randomBytes(16).toString('hex');
    pinHash = hashPin(pin, salt);
  }

  const row = db.prepare(
    'UPDATE staff SET name = ?, pin_hash = ?, pin_salt = ?, role = ?, is_active = ? WHERE id = ? RETURNING *'
  ).get(cleanName, pinHash, salt, nextRole, nextActive, id);

  // currentStaff is a separate in-memory copy (see the note at its
  // declaration) — editing your OWN row here doesn't otherwise touch it, so
  // without this an owner who demotes/deactivates themselves keeps every
  // owner-only requireRole('owner') check passing for the rest of their
  // session. Deactivating self ends the session outright, matching what
  // staff:login would refuse to grant it fresh; otherwise it's kept in
  // sync so a self-demotion (with another owner still present) takes effect
  // immediately rather than after the next login.
  if (currentStaff && currentStaff.id === id) {
    currentStaff = nextActive ? { id: row.id, name: row.name, role: row.role } : null;
  }

  return toStaffView(row);
});

ipcMain.handle('staff:delete', (_e, id) => {
  requireRole('owner');
  const existing = db.prepare('SELECT * FROM staff WHERE id = ?').get(id);
  if (!existing) return { success: true };
  if (existing.role === 'owner') {
    // is_active = 1 here, matching staff:update's guard — an inactive
    // owner row doesn't count as "another owner", or deleting the last
    // *active* owner while a deactivated one still exists would pass this
    // check and lock everyone out of Settings/Staff management.
    const { count } = db.prepare(`SELECT COUNT(*) AS count FROM staff WHERE role = 'owner' AND is_active = 1 AND id != ?`).get(id);
    if (count === 0) throw new Error('Cannot delete the last active owner account');
  }
  db.prepare('DELETE FROM staff WHERE id = ?').run(id);
  // Deleting your OWN account must end the session — otherwise currentStaff
  // keeps pointing at a row that no longer exists, and the next action that
  // references it (e.g. orders:create writing created_by_staff_id) throws a
  // raw FOREIGN KEY constraint error instead of a clean "please log in".
  if (currentStaff && currentStaff.id === id) currentStaff = null;
  return { success: true };
});

// ---------- Shifts ----------
// Sums order_payments by tender for a shift, identified by id boundary —
// shared by shifts:preview (the still-open shift) and shifts:close (the
// same computation, snapshotted permanently onto the row). id rather than a
// timestamp range: see the comment on shifts.opening_payment_id in
// schema.sql for why. Split payments are handled correctly since each
// tender is its own order_payments row; order_count is DISTINCT so a split
// payment's two rows don't double-count its one order.
function computeShiftSales(sincePaymentId) {
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN op.mode = 'cash' THEN op.amount ELSE 0 END), 0) AS cash_sales,
      COALESCE(SUM(CASE WHEN op.mode = 'card' THEN op.amount ELSE 0 END), 0) AS card_sales,
      COALESCE(SUM(CASE WHEN op.mode = 'upi'  THEN op.amount ELSE 0 END), 0) AS upi_sales,
      COUNT(DISTINCT op.order_id) AS order_count
    FROM order_payments op
    WHERE op.id > ?
  `).get(sincePaymentId);
  return {
    cashSales: +Number(row.cash_sales).toFixed(2),
    cardSales: +Number(row.card_sales).toFixed(2),
    upiSales: +Number(row.upi_sales).toFixed(2),
    orderCount: row.order_count,
  };
}

ipcMain.handle('shifts:current', () => {
  return db.prepare('SELECT * FROM shifts WHERE closed_at IS NULL').get() || null;
});

ipcMain.handle('shifts:open', (_e, { openingFloat }) => {
  requireLogin();
  const existing = db.prepare('SELECT id FROM shifts WHERE closed_at IS NULL').get();
  if (existing) throw new Error('A shift is already open');
  const float = Number(openingFloat);
  if (!Number.isFinite(float) || float < 0) throw new Error('Opening float must be a non-negative number');
  const { maxId } = db.prepare('SELECT COALESCE(MAX(id), 0) AS maxId FROM order_payments').get();
  return db.prepare(
    'INSERT INTO shifts (opened_by_staff_id, opened_by_name, opening_float, opening_payment_id) VALUES (?, ?, ?, ?) RETURNING *'
  ).get(currentStaff.id, currentStaff.name, float, maxId);
});

// Read-only preview of what closing right now would look like — lets the
// Close Shift screen show the expected-cash figure before anyone commits to
// closing. Same computation as shifts:close, just not written anywhere.
ipcMain.handle('shifts:preview', () => {
  const shift = db.prepare('SELECT * FROM shifts WHERE closed_at IS NULL').get();
  if (!shift) throw new Error('No shift is currently open');
  const sales = computeShiftSales(shift.opening_payment_id);
  const expectedCash = +(Number(shift.opening_float) + sales.cashSales).toFixed(2);
  return { shift, ...sales, expectedCash };
});

ipcMain.handle('shifts:close', (_e, { countedCash, notes }) => {
  requireLogin();
  const shift = db.prepare('SELECT * FROM shifts WHERE closed_at IS NULL').get();
  if (!shift) throw new Error('No shift is currently open');
  const counted = Number(countedCash);
  if (!Number.isFinite(counted) || counted < 0) throw new Error('Counted cash must be a non-negative number');

  const sales = computeShiftSales(shift.opening_payment_id);
  const expectedCash = +(Number(shift.opening_float) + sales.cashSales).toFixed(2);

  return db.prepare(`
    UPDATE shifts SET
      closed_at = CURRENT_TIMESTAMP, closed_by_staff_id = ?, closed_by_name = ?,
      cash_sales = ?, card_sales = ?, upi_sales = ?, order_count = ?,
      expected_cash = ?, counted_cash = ?, notes = ?
    WHERE id = ? RETURNING *
  `).get(
    currentStaff.id, currentStaff.name,
    sales.cashSales, sales.cardSales, sales.upiSales, sales.orderCount,
    expectedCash, counted, String(notes || '').trim() || null,
    shift.id
  );
});

ipcMain.handle('shifts:history', () => {
  requireRole('owner', 'manager');
  return db.prepare('SELECT * FROM shifts WHERE closed_at IS NOT NULL ORDER BY closed_at DESC LIMIT 100').all();
});

// ---------- Menu: Categories ----------
ipcMain.handle('categories:list', () => {
  return db.prepare('SELECT * FROM categories ORDER BY sort_order, name').all();
});

ipcMain.handle('categories:add', (_e, name) => {
  requireRole('owner', 'manager');
  return db.prepare('INSERT INTO categories (name) VALUES (?) RETURNING *').get(name);
});

ipcMain.handle('categories:delete', (_e, id) => {
  requireRole('owner', 'manager');
  db.prepare('DELETE FROM categories WHERE id = ?').run(id);
  return { success: true };
});

// ---------- Menu: Subcategories ----------
ipcMain.handle('subcategories:list', () => {
  return db.prepare('SELECT * FROM subcategories ORDER BY sort_order, name').all();
});

ipcMain.handle('subcategories:add', (_e, { name, categoryId }) => {
  requireRole('owner', 'manager');
  return db.prepare('INSERT INTO subcategories (name, category_id) VALUES (?, ?) RETURNING *')
    .get(name, categoryId);
});

ipcMain.handle('subcategories:delete', (_e, id) => {
  requireRole('owner', 'manager');
  db.prepare('DELETE FROM subcategories WHERE id = ?').run(id);
  return { success: true };
});

// ---------- Menu: Items ----------
function listMenu() {
  return db.prepare(`
    SELECT m.*, c.name AS category_name, sc.name AS subcategory_name,
           (SELECT COUNT(*) FROM modifier_groups mg WHERE mg.menu_item_id = m.id) AS modifier_group_count
    FROM menu_items m
    LEFT JOIN categories c ON c.id = m.category_id
    LEFT JOIN subcategories sc ON sc.id = m.subcategory_id
    ORDER BY c.sort_order NULLS LAST, m.name
  `).all();
}

ipcMain.handle('menu:list', () => listMenu());

ipcMain.handle('menu:add', (_e, item) => {
  requireRole('owner', 'manager');
  return db.prepare(
    `INSERT INTO menu_items (name, price, category_id, subcategory_id, is_available, hsn_code, gst_rate)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`
  ).get(
    item.name,
    item.price,
    item.categoryId || null,
    item.subcategoryId || null,
    item.isAvailable !== false ? 1 : 0,
    item.hsnCode || null,
    item.gstRate != null ? assertValidGstRate(item.gstRate) : 5
  );
});

ipcMain.handle('menu:update', (_e, item) => {
  requireRole('owner', 'manager');
  return db.prepare(
    `UPDATE menu_items SET name = ?, price = ?, category_id = ?, subcategory_id = ?, is_available = ?, hsn_code = ?, gst_rate = ?
     WHERE id = ? RETURNING *`
  ).get(
    item.name,
    item.price,
    item.categoryId || null,
    item.subcategoryId || null,
    item.isAvailable ? 1 : 0,
    item.hsnCode || null,
    item.gstRate != null ? assertValidGstRate(item.gstRate) : 5,
    item.id
  );
});

ipcMain.handle('menu:delete', (_e, id) => {
  requireRole('owner', 'manager');
  db.prepare('DELETE FROM menu_items WHERE id = ?').run(id);
  return { success: true };
});

ipcMain.handle('menu:toggleAvailability', (_e, id) => {
  requireRole('owner', 'manager');
  return db.prepare('UPDATE menu_items SET is_available = NOT is_available WHERE id = ? RETURNING *').get(id);
});

ipcMain.handle('menu:bulkSetGstRate', (_e, { gstRate, categoryId }) => {
  requireRole('owner', 'manager');
  const rate = assertValidGstRate(gstRate);
  const info = categoryId
    ? db.prepare('UPDATE menu_items SET gst_rate = ? WHERE category_id = ?').run(rate, categoryId)
    : db.prepare('UPDATE menu_items SET gst_rate = ?').run(rate);
  return { success: true, updated: info.changes };
});

// ---------- Menu: Item modifiers ----------
function listModifierGroups(menuItemId) {
  const groups = db.prepare('SELECT * FROM modifier_groups WHERE menu_item_id = ? ORDER BY sort_order, id').all(menuItemId);
  // Called on every tap of a modifier-bearing item in Take Order plus every
  // render of the Menu's modifier-management modal — most items have no
  // modifier groups at all, so skip the options query (and the redundant
  // menu_item_id subquery scan it used to run) in that common case, and use
  // the group ids already fetched above instead of re-deriving them.
  if (!groups.length) return [];
  const groupIds = groups.map((g) => g.id);
  const options = db.prepare(
    `SELECT * FROM modifier_options WHERE group_id IN (${groupIds.map(() => '?').join(',')}) ORDER BY sort_order, id`
  ).all(...groupIds);
  return groups.map((g) => ({ ...g, options: options.filter((o) => o.group_id === g.id) }));
}

ipcMain.handle('modifiers:listGroups', (_e, menuItemId) => listModifierGroups(menuItemId));

ipcMain.handle('modifiers:addGroup', (_e, { menuItemId, name, minSelect, maxSelect }) => {
  requireRole('owner', 'manager');
  const trimmedName = String(name || '').trim();
  if (!trimmedName) throw new Error('Group name is required');
  const max = Number(maxSelect);
  if (!Number.isInteger(max) || max < 1) throw new Error('Max selections must be a whole number of at least 1');
  const min = minSelect == null ? 0 : Number(minSelect);
  if (!Number.isInteger(min) || min < 0 || min > max) throw new Error('Min selections must be a whole number between 0 and max selections');
  return db.prepare(
    'INSERT INTO modifier_groups (menu_item_id, name, min_select, max_select) VALUES (?, ?, ?, ?) RETURNING *'
  ).get(menuItemId, trimmedName, min, max);
});

ipcMain.handle('modifiers:deleteGroup', (_e, groupId) => {
  requireRole('owner', 'manager');
  db.prepare('DELETE FROM modifier_groups WHERE id = ?').run(groupId); // cascades to modifier_options
  return { success: true };
});

ipcMain.handle('modifiers:addOption', (_e, { groupId, name, priceDelta }) => {
  requireRole('owner', 'manager');
  const trimmedName = String(name || '').trim();
  if (!trimmedName) throw new Error('Option name is required');
  const delta = priceDelta == null || priceDelta === '' ? 0 : Number(priceDelta);
  if (!Number.isFinite(delta)) throw new Error('Price adjustment must be a number');
  return db.prepare(
    'INSERT INTO modifier_options (group_id, name, price_delta) VALUES (?, ?, ?) RETURNING *'
  ).get(groupId, trimmedName, delta);
});

ipcMain.handle('modifiers:deleteOption', (_e, optionId) => {
  requireRole('owner', 'manager');
  const option = db.prepare('SELECT group_id FROM modifier_options WHERE id = ?').get(optionId);
  if (!option) return { success: true };
  const group = db.prepare('SELECT name, min_select FROM modifier_groups WHERE id = ?').get(option.group_id);
  // A required group (min_select > 0) left with fewer options than it
  // requires becomes permanently un-orderable — orders:addItem's own
  // min/max check would reject every attempt to add the item, with no
  // warning anywhere that this state exists until a cashier hits it live.
  if (group && group.min_select > 0) {
    const { count } = db.prepare('SELECT COUNT(*) AS count FROM modifier_options WHERE group_id = ?').get(option.group_id);
    if (count - 1 < group.min_select) {
      throw new Error(`Can't remove this option — "${group.name}" requires at least ${group.min_select}, and this is one of only ${count}. Add a replacement first, or delete the whole group instead.`);
    }
  }
  db.prepare('DELETE FROM modifier_options WHERE id = ?').run(optionId);
  return { success: true };
});

// ---------- Tables ----------
function listOpenTables() {
  return db.prepare(`
    SELECT t.*, o.id AS order_id, o.total AS order_total, o.created_at AS order_created_at
    FROM restaurant_tables t
    LEFT JOIN orders o ON o.table_id = t.id AND o.status = 'open'
    ORDER BY t.sort_order, t.name
  `).all();
}

ipcMain.handle('tables:list', () => listOpenTables());

ipcMain.handle('tables:add', (_e, { name, seats }) => {
  requireLogin();
  const cleanName = String(name || '').trim();
  if (!cleanName) throw new Error('Table name is required');
  const seatCount = seats != null && seats !== '' ? Number(seats) : null;
  if (seatCount != null && (!Number.isInteger(seatCount) || seatCount <= 0)) {
    throw new Error('Seats must be a positive whole number');
  }
  return db.prepare('INSERT INTO restaurant_tables (name, seats) VALUES (?, ?) RETURNING *').get(cleanName, seatCount);
});

ipcMain.handle('tables:delete', (_e, id) => {
  requireLogin();
  const openOrder = db.prepare(`SELECT id FROM orders WHERE table_id = ? AND status = 'open'`).get(id);
  if (openOrder) throw new Error('This table has an open order — close or cancel it first');
  db.prepare('DELETE FROM restaurant_tables WHERE id = ?').run(id);
  return { success: true };
});

// ---------- Orders ----------
function listOpenOrders() {
  return db.prepare(`SELECT * FROM orders WHERE status = 'open' ORDER BY created_at DESC`).all();
}

ipcMain.handle('orders:listOpen', () => listOpenOrders());

ipcMain.handle('orders:listAll', () => {
  return db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
});

function createOrder(session, { orderType, tableLabel, source, tableId }) {
  requireLoginFor(session);
  let label = tableLabel || null;
  let linkedTableId = tableId || null;
  if (linkedTableId) {
    const table = db.prepare('SELECT * FROM restaurant_tables WHERE id = ?').get(linkedTableId);
    if (!table) throw new Error('Table not found');
    const existing = db.prepare(`SELECT id FROM orders WHERE table_id = ? AND status = 'open'`).get(linkedTableId);
    if (existing) throw new Error(`Table "${table.name}" already has an open order`);
    label = table.name;
  }
  return db.prepare(
    `INSERT INTO orders (order_type, table_label, table_id, source, created_by_staff_id, created_by_name)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING *`
  ).get(orderType || 'dine-in', label, linkedTableId, source || 'in-house', session.id, session.name);
}

ipcMain.handle('orders:create', (_e, payload) => createOrder(currentStaff, payload));

// Attaches each order_item's chosen modifiers (order_item_modifiers) as a
// nested `.modifiers` array — shared by orders:get and anywhere else that
// needs a full order-with-items-with-modifiers shape.
function attachModifiers(items) {
  if (!items.length) return items;
  const ids = items.map((i) => i.id);
  const modifiers = db.prepare(
    `SELECT * FROM order_item_modifiers WHERE order_item_id IN (${ids.map(() => '?').join(',')})`
  ).all(...ids);
  return items.map((i) => ({ ...i, modifiers: modifiers.filter((m) => m.order_item_id === i.id) }));
}

function getOrderDetail(orderId) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return null;
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(orderId);
  return { ...order, items: attachModifiers(items) };
}

ipcMain.handle('orders:get', (_e, orderId) => getOrderDetail(orderId));

function addOrderItem(session, { orderId, menuItemId, name, price, quantity, notes, modifierOptionIds }) {
  requireLoginFor(session);
  // Price/name/HSN/GST always come from the menu server-side when a real
  // menuItemId is given — the caller's own price/name are only trusted for a
  // one-off custom line (no menuItemId), and even then must be a sane number.
  const menuItem = menuItemId
    ? db.prepare('SELECT name, price, hsn_code, gst_rate FROM menu_items WHERE id = ?').get(menuItemId)
    : null;
  if (menuItemId && !menuItem) throw new Error('Menu item not found');

  const itemName = menuItem ? menuItem.name : String(name || '').trim();
  if (!itemName) throw new Error('Item name is required');

  // Selected modifiers are re-fetched by id server-side (never trust a
  // client-supplied name/price for them, same reasoning as menuItemId's
  // price above) and cross-checked against menuItemId so an id belonging to
  // a different item's modifier group can't be smuggled in. A one-off
  // custom line (no menuItemId) has no modifier groups to apply.
  let selectedOptions = [];
  if (menuItemId && modifierOptionIds && modifierOptionIds.length) {
    const placeholders = modifierOptionIds.map(() => '?').join(',');
    selectedOptions = db.prepare(`
      SELECT mo.id, mo.group_id, mo.name, mo.price_delta
      FROM modifier_options mo
      JOIN modifier_groups mg ON mg.id = mo.group_id
      WHERE mo.id IN (${placeholders}) AND mg.menu_item_id = ?
    `).all(...modifierOptionIds, menuItemId);
    if (selectedOptions.length !== modifierOptionIds.length) {
      throw new Error('One or more selected options are invalid for this item');
    }
  }
  if (menuItemId) {
    const groups = db.prepare('SELECT id, name, min_select, max_select FROM modifier_groups WHERE menu_item_id = ?').all(menuItemId);
    groups.forEach((g) => {
      const count = selectedOptions.filter((o) => o.group_id === g.id).length;
      if (count < g.min_select || count > g.max_select) {
        throw new Error(`"${g.name}" requires between ${g.min_select} and ${g.max_select} selection(s)`);
      }
    });
  }

  // Modifier price deltas are folded straight into unit_price here rather
  // than kept as a separate charge — see the comment on order_item_modifiers
  // in schema.sql for why: every downstream total/tax/report calculation
  // then needs zero changes, since they already operate on unit_price.
  const modifierTotal = selectedOptions.reduce((sum, o) => sum + Number(o.price_delta), 0);
  const baseUnitPrice = menuItem ? Number(menuItem.price) : Number(price);
  const unitPrice = +(baseUnitPrice + modifierTotal).toFixed(2);
  if (!Number.isFinite(unitPrice) || unitPrice < 0) throw new Error('Invalid price');

  const hsnCode = menuItem ? menuItem.hsn_code : null;
  const gstRate = menuItem ? Number(menuItem.gst_rate) : 0;

  const qty = quantity == null ? 1 : Number(quantity);
  if (!Number.isInteger(qty) || qty <= 0) throw new Error('Quantity must be a positive whole number');

  // One transaction, not three independent statements — without this, a
  // failure between the order_items insert and the order_item_modifiers
  // inserts (e.g. a disk/lock error on the 2nd of 2 selected options) would
  // leave a line item priced with both modifiers folded into unit_price but
  // only one of them recorded, so the kitchen ticket and receipt silently
  // drop a modifier the customer was actually charged for.
  const addItem = db.transaction(() => {
    const orderItem = db.prepare(
      `INSERT INTO order_items (order_id, menu_item_id, item_name, unit_price, quantity, notes, hsn_code, gst_rate, tax_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
    ).get(orderId, menuItemId, itemName, unitPrice, qty, notes || null, hsnCode, gstRate, lineTax(unitPrice, qty, gstRate));

    if (selectedOptions.length) {
      const insertMod = db.prepare('INSERT INTO order_item_modifiers (order_item_id, name, price_delta) VALUES (?, ?, ?)');
      selectedOptions.forEach((o) => insertMod.run(orderItem.id, o.name, o.price_delta));
    }

    recalcOrder(orderId);
    return db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  });

  return addItem();
}

ipcMain.handle('orders:addItem', (_e, payload) => addOrderItem(currentStaff, payload));

function updateOrderItemQty(session, { orderItemId, quantity, orderId }) {
  requireLoginFor(session);
  const qty = Number(quantity);
  if (qty <= 0) {
    db.prepare('DELETE FROM order_items WHERE id = ?').run(orderItemId);
  } else {
    if (!Number.isInteger(qty)) throw new Error('Quantity must be a whole number');
    const line = db.prepare('SELECT unit_price, gst_rate FROM order_items WHERE id = ?').get(orderItemId);
    db.prepare('UPDATE order_items SET quantity = ?, tax_amount = ? WHERE id = ?')
      .run(qty, lineTax(line.unit_price, qty, line.gst_rate), orderItemId);
  }
  recalcOrder(orderId);
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
}

ipcMain.handle('orders:updateItemQty', (_e, payload) => updateOrderItemQty(currentStaff, payload));

function removeOrderItem(session, { orderItemId, orderId }) {
  requireLoginFor(session);
  db.prepare('DELETE FROM order_items WHERE id = ?').run(orderItemId);
  recalcOrder(orderId);
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
}

ipcMain.handle('orders:removeItem', (_e, payload) => removeOrderItem(currentStaff, payload));

ipcMain.handle('orders:setDiscount', (_e, { orderId, discount }) => {
  requireLogin();
  const value = Number(discount);
  const safeDiscount = Number.isFinite(value) && value > 0 ? value : 0;
  // recalcOrder clamps this down further to at most subtotal + tax, so the
  // total can never go negative regardless of what was requested here.
  db.prepare('UPDATE orders SET discount = ? WHERE id = ?').run(safeDiscount, orderId);
  recalcOrder(orderId);
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
});

ipcMain.handle('orders:cancel', (_e, orderId) => {
  requireLogin();
  const order = db.prepare(
    `UPDATE orders SET status = 'cancelled', closed_by_staff_id = ?, closed_by_name = ?
     WHERE id = ? AND status = 'open' RETURNING *`
  ).get(currentStaff.id, currentStaff.name, orderId);
  if (!order) throw new Error('Only open orders can be cancelled');
  return order;
});

// ---------- Billing ----------
// Two ways to pay: a single `paymentMode` covering the full total (unchanged
// since v1), or a `payments` array of { mode, amount } tenders for a split
// payment (e.g. part cash + part card) — exactly one of the two is given.
ipcMain.handle('billing:finalize', (_e, { orderId, paymentMode, payments, customerPhone, customerName }) => {
  requireLogin();
  const order = db.prepare('SELECT status, total FROM orders WHERE id = ?').get(orderId);
  if (!order) throw new Error('Order not found');
  if (order.status !== 'open') throw new Error('Only open orders can be charged');

  // Both optional — most walk-in cash customers won't give a phone number,
  // and that's fine. Validated loosely (digits, 7-15 long) rather than
  // strictly to a 10-digit Indian mobile format, since this field also has
  // to accept a landline or a number with a country code.
  const cleanPhone = customerPhone != null ? String(customerPhone).replace(/\s+/g, '') : '';
  if (cleanPhone && !/^\d{7,15}$/.test(cleanPhone)) throw new Error('Enter a valid phone number');
  const cleanCustomerName = customerName != null ? String(customerName).trim() : '';

  let tenders;
  if (payments && payments.length) {
    tenders = payments.map((p) => {
      const amount = Number(p.amount);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error('Each payment amount must be a positive number');
      if (!['cash', 'card', 'upi'].includes(p.mode)) throw new Error(`Invalid payment mode "${p.mode}"`);
      return { mode: p.mode, amount };
    });
    const sum = +tenders.reduce((s, p) => s + p.amount, 0).toFixed(2);
    // 1-paisa tolerance mirrors the rounding recalcOrder already does on
    // subtotal/tax/total — without it a fully-covered split could be
    // rejected over a stray fractional-rupee rounding mismatch.
    if (Math.abs(sum - Number(order.total)) > 0.01) {
      throw new Error(`Payments total ₹${sum.toFixed(2)} does not match order total ₹${Number(order.total).toFixed(2)}`);
    }
  } else if (paymentMode) {
    // Validated here too, not just left to the orders.payment_mode CHECK
    // constraint — a constraint failure would surface as a raw SqliteError
    // instead of a clean message, and (before the transaction wrap below)
    // would burn an invoice number on the way to that failure.
    if (!['cash', 'card', 'upi'].includes(paymentMode)) throw new Error(`Invalid payment mode "${paymentMode}"`);
    tenders = [{ mode: paymentMode, amount: Number(order.total) }];
  } else {
    throw new Error('A payment mode or a list of payments is required');
  }

  // payment_mode stays a single value for display/backward-compat: the
  // tender's mode when there's exactly one, NULL for a genuine split (NULL
  // is already a valid value here per the column's CHECK constraint, same
  // as any unpaid order). order_payments below is the source of truth for
  // the actual breakdown either way — see billing:getReceipt.
  const displayMode = tenders.length === 1 ? tenders[0].mode : null;

  // Invoice number + order update + every payment row committed as one
  // transaction — getNextInvoiceNumber() itself writes to `settings`, so
  // without this, a failure partway through (e.g. the 2nd of 3 split
  // tenders) would leave the order permanently 'paid' with an invoice
  // number already consumed but incomplete/missing payment rows, silently
  // corrupting shift reconciliation with no way to re-finalize the order.
  const finalize = db.transaction(() => {
    const invoiceNumber = getNextInvoiceNumber();
    const updated = db.prepare(
      `UPDATE orders SET status = 'paid', payment_mode = ?, paid_at = CURRENT_TIMESTAMP, invoice_number = ?,
       closed_by_staff_id = ?, closed_by_name = ?,
       customer_phone = COALESCE(NULLIF(?, ''), customer_phone), customer_name = COALESCE(NULLIF(?, ''), customer_name)
       WHERE id = ? RETURNING *`
    ).get(displayMode, invoiceNumber, currentStaff.id, currentStaff.name, cleanPhone, cleanCustomerName, orderId);

    const insertPayment = db.prepare('INSERT INTO order_payments (order_id, mode, amount) VALUES (?, ?, ?)');
    tenders.forEach((p) => insertPayment.run(orderId, p.mode, p.amount));

    return updated;
  });

  return finalize();
});

ipcMain.handle('billing:getReceipt', async (_e, orderId) => {
  const { order, items, gstBreakdown, business, payments } = assembleReceiptData(orderId);
  const settings = getSettingsMap();

  let qrDataUrl = null;
  if (settings.upi_id && order.status === 'paid') {
    const upiUrl = `upi://pay?pa=${encodeURIComponent(settings.upi_id)}&pn=${encodeURIComponent(business.name || 'Merchant')}&am=${order.total}&cu=INR&tn=${encodeURIComponent('Order ' + (order.invoice_number || order.id))}`;
    qrDataUrl = await QRCode.toDataURL(upiUrl, { margin: 1, width: 180 });
  }

  return { ...order, items, gstBreakdown, business, qrDataUrl, payments };
});

// ---------- Customers ----------
// No dedicated customers table — a repeat customer is just "this phone
// number appears on an earlier order". visitCount excludes cancelled
// orders (those weren't really a visit); name is whichever name was most
// recently entered for this phone, so a typo gets self-corrected next time
// it's entered right, rather than a stale name sticking forever.
ipcMain.handle('customers:lookup', (_e, phone) => {
  requireLogin(); // returns a customer's name — PII, same bar as every other order/billing handler
  // Strip everything but digits, not just whitespace — billing:finalize
  // validates customer_phone as digits-only before it's ever stored (see
  // its cleanPhone), so the stored value never has dashes/parens/spaces.
  // Only stripping whitespace here would fail to match a phone the cashier
  // types back with different formatting (e.g. "98765-43210" vs "9876543210"
  // stored), silently missing a real repeat customer.
  const cleanPhone = String(phone || '').replace(/\D/g, '');
  if (!cleanPhone) return null;

  // One query, not two: order.customer_phone is indexed (idx_orders_customer_phone),
  // and this fires on every keystroke once a phone number reaches 10 digits
  // (see lookupCustomerByPhone in renderer.js), so it's on an interactive
  // typing path, not a background job. created_at only has second-level
  // resolution (SQLite's CURRENT_TIMESTAMP), so id is the tiebreaker that
  // actually reflects creation order for same-second rows.
  const rows = db.prepare(
    `SELECT customer_name FROM orders WHERE customer_phone = ? AND status != 'cancelled' ORDER BY created_at DESC, id DESC`
  ).all(cleanPhone);
  if (!rows.length) return null;

  const latestNamed = rows.find((r) => r.customer_name);
  return { name: latestNamed ? latestNamed.customer_name : null, visitCount: rows.length };
});

// ---------- Printing ----------
// Lists OS-installed printers (name, displayName, isDefault, etc. — the full
// Electron.PrinterInfo shape) for the Settings screen's printer picker.
ipcMain.handle('printers:listSystem', async () => {
  return mainWindow.webContents.getPrintersAsync();
});

// Prints a real order's receipt. Resolves to { mode: 'dialog' | 'system' | 'network' }.
// mode: 'dialog' means "do nothing here" — the renderer must fall back to its
// existing window.print() call itself, exactly as it did before this feature
// existed. mode: 'system' | 'network' means printing has already happened.
ipcMain.handle('receipt:print', async (_e, { orderId }) => {
  const { order, items, gstBreakdown, business, payments } = assembleReceiptData(orderId);
  return printReceipt({ order, items, gstBreakdown, business, payments });
});

// Prints a synthetic, made-up receipt (current business settings + two fake
// line items) so the owner can validate printer settings from the Settings
// screen without ringing up and paying a real order. Same three-way
// mode/{mode} contract as receipt:print.
ipcMain.handle('receipt:testPrint', async () => {
  requireRole('owner'); // only reachable from the owner-only Settings screen — settings:update is gated the same way
  const business = getBusinessSettings();

  const testItems = [
    { item_name: 'Test Item A', unit_price: 120, quantity: 2, hsn_code: '2106', gst_rate: 5 },
    { item_name: 'Test Item B', unit_price: 75, quantity: 1, hsn_code: '2106', gst_rate: 5 },
  ].map((i) => ({ ...i, tax_amount: lineTax(i.unit_price, i.quantity, i.gst_rate) }));

  const subtotal = +testItems.reduce((sum, i) => sum + i.unit_price * i.quantity, 0).toFixed(2);
  const taxAmount = +testItems.reduce((sum, i) => sum + i.tax_amount, 0).toFixed(2);

  const order = {
    id: 0,
    invoice_number: null,
    order_type: 'dine-in',
    table_label: 'Test',
    source: 'in-house',
    subtotal: subtotal.toFixed(2),
    discount: 0,
    tax_amount: taxAmount,
    total: +(subtotal + taxAmount).toFixed(2),
    payment_mode: null,
    created_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
    paid_at: null,
  };

  const gstBreakdown = [{
    hsnCode: '2106',
    gstRate: 5,
    taxableAmount: subtotal,
    cgst: +(taxAmount / 2).toFixed(2),
    sgst: +(taxAmount / 2).toFixed(2),
  }];

  return printReceipt({ order, items: testItems, gstBreakdown, business });
});

// Prints only the order_items not yet sent to the kitchen (kot_fired_at IS
// NULL) — repeated taps only fire what's new since the last KOT, so the
// kitchen never re-cooks an already-fired line. Resolves to { mode, count };
// mode:'none' (count:0) means there was nothing new to send — the renderer
// should treat that as a quiet no-op, not an error. The exact set of item
// ids printed is captured before the print await and reused for the update
// below, rather than re-querying "still NULL" after — an item added to this
// order while the print is in flight (e.g. a slow network printer) must not
// be silently marked fired without ever having been printed.
//
// For system/network mode, printKot() has already awaited a real print
// attempt by the time we get here (and throws on failure, which skips the
// UPDATE below entirely) — so marking fired now is correct. For 'dialog'
// mode nothing has actually been printed yet: main.js just hands the item
// list back and the renderer prints it later via window.print(). Marking
// fired here too would lose the KOT for good if that print is cancelled or
// fails, with no unfired items left to retry — so 'dialog' instead returns
// itemIds and leaves the marking to receipt:confirmKotPrinted, called by the
// renderer only after window.print() actually returns.
async function fireKot(session, orderId) {
  requireLoginFor(session);
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) throw new Error('Order not found');
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ? AND kot_fired_at IS NULL ORDER BY id').all(orderId);
  if (!items.length) return { mode: 'none', count: 0 };

  const result = await printKot({ order, items: attachModifiers(items) });
  const ids = items.map((i) => i.id);

  if (result.mode === 'dialog') {
    return { ...result, count: items.length, itemIds: ids };
  }

  db.prepare(`UPDATE order_items SET kot_fired_at = CURRENT_TIMESTAMP WHERE id IN (${ids.map(() => '?').join(',')})`)
    .run(...ids);

  return { ...result, count: items.length };
}

ipcMain.handle('receipt:printKot', (_e, { orderId }) => fireKot(currentStaff, orderId));

// Companion to receipt:printKot's 'dialog' branch — see the comment there.
// Called by the renderer once window.print() for the KOT has returned.
// kot_fired_at IS NULL in the WHERE guards against marking an item that was
// somehow already fired by another path in the meantime.
ipcMain.handle('receipt:confirmKotPrinted', (_e, { itemIds }) => {
  requireLogin();
  if (!itemIds || !itemIds.length) return { success: true };
  db.prepare(`UPDATE order_items SET kot_fired_at = CURRENT_TIMESTAMP WHERE kot_fired_at IS NULL AND id IN (${itemIds.map(() => '?').join(',')})`)
    .run(...itemIds);
  return { success: true };
});

// ---------- Reports ----------
ipcMain.handle('reports:summary', (_e, { startDate, endDate }) => {
  requireRole('owner', 'manager');
  const dateFilter = startDate && endDate ? "AND date(o.paid_at, 'localtime') BETWEEN date(?) AND date(?)" : '';
  const dateParams = startDate && endDate ? [startDate, endDate] : [];

  const summary = db.prepare(`
    SELECT COUNT(*) AS order_count,
           COALESCE(SUM(o.total), 0) AS revenue,
           COALESCE(SUM(o.discount), 0) AS discount_total,
           COALESCE(SUM(o.tax_amount), 0) AS tax_total
    FROM orders o
    WHERE o.status = 'paid' ${dateFilter}
  `).get(...dateParams);

  const { items_sold: itemsSold } = db.prepare(`
    SELECT COALESCE(SUM(oi.quantity), 0) AS items_sold
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE o.status = 'paid' ${dateFilter}
  `).get(...dateParams);

  const topItems = db.prepare(`
    SELECT oi.item_name AS name,
           SUM(oi.quantity) AS quantity,
           SUM(oi.unit_price * oi.quantity) AS revenue
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE o.status = 'paid' ${dateFilter}
    GROUP BY oi.item_name
    ORDER BY revenue DESC
    LIMIT 8
  `).all(...dateParams);

  const byCategory = db.prepare(`
    SELECT COALESCE(c.name, 'Uncategorized') AS name,
           SUM(oi.unit_price * oi.quantity) AS revenue
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    LEFT JOIN menu_items m ON m.id = oi.menu_item_id
    LEFT JOIN categories c ON c.id = m.category_id
    WHERE o.status = 'paid' ${dateFilter}
    GROUP BY COALESCE(c.name, 'Uncategorized')
    ORDER BY revenue DESC
  `).all(...dateParams);

  return {
    orderCount: summary.order_count,
    revenue: summary.revenue,
    discountTotal: summary.discount_total,
    taxTotal: summary.tax_total,
    itemsSold,
    topItems,
    byCategory,
  };
});

ipcMain.handle('reports:exportExcel', async (_e, { startDate, endDate }) => {
  requireRole('owner', 'manager');
  const dateFilter = startDate && endDate ? "AND date(paid_at, 'localtime') BETWEEN date(?) AND date(?)" : '';
  const dateParams = startDate && endDate ? [startDate, endDate] : [];

  const orders = db.prepare(`
    SELECT * FROM orders
    WHERE status = 'paid' ${dateFilter}
    ORDER BY paid_at ASC
  `).all(...dateParams);

  const defaultName = startDate && endDate
    ? `orders_${startDate}_to_${endDate}.xlsx`
    : 'orders_all_time.xlsx';

  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Export orders to Excel',
    defaultPath: defaultName,
    filters: [{ name: 'Excel Workbook', extensions: ['xlsx'] }],
  });
  if (canceled || !filePath) return { success: false, canceled: true };

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Orders');
  sheet.columns = [
    { header: 'Date', key: 'date', width: 20 },
    { header: 'Order #', key: 'id', width: 10 },
    { header: 'Type', key: 'type', width: 12 },
    { header: 'Table / Ref', key: 'table', width: 14 },
    { header: 'Items', key: 'items', width: 44 },
    { header: 'Subtotal', key: 'subtotal', width: 12 },
    { header: 'Tax', key: 'tax', width: 10 },
    { header: 'Discount', key: 'discount', width: 10 },
    { header: 'Total', key: 'total', width: 12 },
    { header: 'Payment mode', key: 'payment', width: 14 },
  ];
  sheet.getRow(1).font = { bold: true };

  const itemsStmt = db.prepare('SELECT item_name, quantity FROM order_items WHERE order_id = ? ORDER BY id');

  orders.forEach((o) => {
    const items = itemsStmt.all(o.id);
    const itemsText = items.map((i) => `${i.item_name} x${i.quantity}`).join(', ');
    sheet.addRow({
      date: o.paid_at,
      id: o.id,
      type: o.order_type,
      table: o.table_label || '',
      items: itemsText,
      subtotal: Number(o.subtotal),
      tax: Number(o.tax_amount),
      discount: Number(o.discount),
      total: Number(o.total),
      payment: o.payment_mode || '',
    });
  });

  ['subtotal', 'tax', 'discount', 'total'].forEach((key) => {
    sheet.getColumn(key).numFmt = '#,##0.00';
  });

  if (orders.length > 0) {
    const totalsRow = sheet.addRow({
      items: 'TOTAL',
      subtotal: orders.reduce((s, o) => s + Number(o.subtotal), 0),
      tax: orders.reduce((s, o) => s + Number(o.tax_amount), 0),
      discount: orders.reduce((s, o) => s + Number(o.discount), 0),
      total: orders.reduce((s, o) => s + Number(o.total), 0),
    });
    totalsRow.font = { bold: true };
  }

  await workbook.xlsx.writeFile(filePath);
  return { success: true, filePath, orderCount: orders.length };
});

// ---------- Settings ----------
// Maps the JS-side field name to its row key in the settings table.
const SETTINGS_FIELDS = {
  defaultTaxPercent: 'default_tax_percent',
  businessName: 'business_name',
  businessAddress: 'business_address',
  businessPhone: 'business_phone',
  gstin: 'gstin',
  fssaiNo: 'fssai_no',
  invoicePrefix: 'invoice_prefix',
  upiId: 'upi_id',
  footerNote: 'footer_note',
  zomatoRestaurantId: 'zomato_restaurant_id',
  // Printer settings. printerMode defaults to 'dialog' (see settings:get)
  // whenever unset/empty — every existing install has no such setting yet
  // and must keep using the browser print dialog exactly as today until the
  // owner explicitly opts into 'system' or 'network' printing.
  printerMode: 'printer_mode', // 'dialog' | 'system' | 'network'
  printerSystemName: 'printer_system_name',
  printerNetworkHost: 'printer_network_host',
  printerNetworkPort: 'printer_network_port',
  printerPaperWidth: 'printer_paper_width', // '58' | '80' (mm)
  // Mobile ordering server (see the "Mobile ordering server" section near
  // the end of this file) — off by default, same reasoning as printerMode
  // defaulting to 'dialog': existing installs must not suddenly start
  // listening on the network.
  mobileServerEnabled: 'mobile_server_enabled',
  mobileServerPort: 'mobile_server_port',
};

ipcMain.handle('settings:get', () => {
  const map = getSettingsMap();
  return {
    defaultTaxPercent: Number(map.default_tax_percent ?? 5),
    businessName: map.business_name || '',
    businessAddress: map.business_address || '',
    businessPhone: map.business_phone || '',
    gstin: map.gstin || '',
    fssaiNo: map.fssai_no || '',
    invoicePrefix: map.invoice_prefix || 'INV',
    upiId: map.upi_id || '',
    footerNote: map.footer_note || '',
    zomatoRestaurantId: map.zomato_restaurant_id || '',
    printerMode: map.printer_mode || 'dialog',
    printerSystemName: map.printer_system_name || '',
    printerNetworkHost: map.printer_network_host || '',
    printerNetworkPort: Number(map.printer_network_port || 9100),
    printerPaperWidth: map.printer_paper_width || '80',
    mobileServerEnabled: map.mobile_server_enabled === '1',
    mobileServerPort: Number(map.mobile_server_port || 8080),
  };
});

ipcMain.handle('settings:update', (_e, payload) => {
  requireRole('owner');
  const upsert = db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value
  `);
  Object.entries(payload).forEach(([field, value]) => {
    const key = SETTINGS_FIELDS[field];
    if (key) upsert.run(key, String(value ?? ''));
  });
  // Applies an enable/port change live, same as printer settings already
  // apply live (getPrinterSettings() re-reads fresh on every print call).
  syncMobileServer();
  return { success: true };
});

// mobile_server_enabled is stored as '1'/'0' text like every other
// settings-table value (see settings:update's upsert above), not a real
// boolean column — settings is a flat key/value store (schema.sql).
function getMobileServerSettings(map = getSettingsMap()) {
  return {
    enabled: map.mobile_server_enabled === '1',
    port: Number(map.mobile_server_port || 8080),
  };
}

// First non-internal IPv4 address of any network interface — good enough
// for "the WiFi this laptop is on" in the common single-NIC case; if a
// machine has several active interfaces this just picks one, which is a
// reasonable default for a feature whose whole premise is "same WiFi".
function getLanIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return null;
}

ipcMain.handle('mobile:getServerInfo', async () => {
  const { enabled, port } = getMobileServerSettings();
  const lanIp = getLanIp();
  const url = enabled && lanIp ? `http://${lanIp}:${port}` : null;
  const qrDataUrl = url ? await QRCode.toDataURL(url, { margin: 1, width: 180 }) : null;
  return { enabled, port, lanIp, url, qrDataUrl };
});

// ---------- Mobile ordering server ----------
// A small HTTP+static-file server, in this same process, so waiters can
// take dine-in orders and fire KOTs from their own phone/tablet over the
// same WiFi as this machine. It reuses the exact same core functions (and
// therefore the exact same money/tax/modifier/table-locking logic) as the
// IPC handlers above — the only new thing is a second way to reach them,
// authenticated by a per-device token (see `sessions`, near currentStaff)
// instead of the desktop's single global currentStaff.
//
// Deliberately NOT built here: billing/payment, discounts, takeaway/
// delivery, settings/reports/staff admin — all of that stays desktop-only
// by simply never exposing a route for it.

function sendJson(res, statusCode, body) {
  const data = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) { reject(new Error('Request body too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

// Fixed whitelist of static files, not a general static-file server — the
// mobile client is exactly these three files, so there's no path to serve
// (and no path-traversal surface) beyond them.
const MOBILE_STATIC_FILES = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/mobile.css': { file: 'mobile.css', type: 'text/css; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'application/javascript; charset=utf-8' },
};

function serveMobileStatic(res, pathname) {
  const entry = MOBILE_STATIC_FILES[pathname];
  if (!entry) return false;
  fs.readFile(path.join(__dirname, 'src', 'mobile', entry.file), (err, data) => {
    if (err) return sendJson(res, 500, { error: 'Failed to load mobile client' });
    res.writeHead(200, { 'Content-Type': entry.type });
    res.end(data);
  });
  return true;
}

// Every route here requires a valid session token EXCEPT login — this is
// the HTTP-layer equivalent of "you can't reach this screen without being
// logged in", the same gate the desktop UI relies on for its own ungated
// reads (tables:list, orders:listOpen, orders:get, menu:list,
// modifiers:listGroups, all called via IPC with no per-handler check).
const MOBILE_ROUTES = [
  { method: 'GET', regex: /^\/api\/mobile\/tables$/, handler: () => listOpenTables() },
  { method: 'GET', regex: /^\/api\/mobile\/orders\/open$/, handler: () => listOpenOrders() },
  { method: 'GET', regex: /^\/api\/mobile\/orders\/(?<id>\d+)$/, handler: (session, params) => getOrderDetail(Number(params.id)) },
  {
    method: 'POST',
    regex: /^\/api\/mobile\/orders$/,
    // Hard-coded 'dine-in' + a required tableId — mobile only ever creates
    // dine-in orders tied to a table, never takeaway/delivery, regardless
    // of what a client sends (this is a server-side scope boundary, not
    // just a UI choice in src/mobile/app.js).
    handler: (session, params, body) => {
      if (!body.tableId) { const err = new Error('A table is required'); err.statusCode = 400; throw err; }
      return createOrder(session, { orderType: 'dine-in', tableId: Number(body.tableId), source: 'in-house' });
    },
  },
  {
    method: 'POST',
    regex: /^\/api\/mobile\/orders\/(?<id>\d+)\/items$/,
    handler: (session, params, body) => addOrderItem(session, { ...body, orderId: Number(params.id) }),
  },
  {
    method: 'PATCH',
    regex: /^\/api\/mobile\/orders\/(?<id>\d+)\/items\/(?<itemId>\d+)$/,
    handler: (session, params, body) => updateOrderItemQty(session, {
      orderId: Number(params.id), orderItemId: Number(params.itemId), quantity: body.quantity,
    }),
  },
  {
    method: 'DELETE',
    regex: /^\/api\/mobile\/orders\/(?<id>\d+)\/items\/(?<itemId>\d+)$/,
    handler: (session, params) => removeOrderItem(session, { orderId: Number(params.id), orderItemId: Number(params.itemId) }),
  },
  { method: 'GET', regex: /^\/api\/mobile\/menu$/, handler: () => listMenu() },
  { method: 'GET', regex: /^\/api\/mobile\/menu\/(?<id>\d+)\/modifiers$/, handler: (session, params) => listModifierGroups(Number(params.id)) },
  {
    method: 'POST',
    regex: /^\/api\/mobile\/orders\/(?<id>\d+)\/fire-kot$/,
    // printerMode: 'dialog' only works because the desktop renderer calls
    // window.print() itself (src/renderer.js) — there's no equivalent on a
    // phone, so this is refused loudly here rather than silently no-op'ing
    // or leaving items half-fired.
    handler: (session, params) => {
      if (getPrinterSettings().mode === 'dialog') {
        const err = new Error('Kitchen printing is set to Dialog mode, which only works from the desktop app — ask the desktop to fire this KOT, or switch Settings > Printer to System/Network mode.');
        err.statusCode = 409;
        throw err;
      }
      return fireKot(session, Number(params.id));
    },
  },
];

function createMobileServer() {
  return http.createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, 'http://localhost');

      if (req.method === 'GET' && serveMobileStatic(res, pathname)) return;

      if (req.method === 'POST' && pathname === '/api/mobile/login') {
        const body = await readJsonBody(req);
        const staff = findStaffByPin(body.pin);
        if (!staff) return sendJson(res, 401, { error: 'Incorrect PIN' });
        const token = crypto.randomBytes(24).toString('hex');
        const session = { id: staff.id, name: staff.name, role: staff.role };
        sessions.set(token, session);
        return sendJson(res, 200, { token, staff: session });
      }

      const route = MOBILE_ROUTES.find((r) => r.method === req.method && r.regex.test(pathname));
      if (!route) return sendJson(res, 404, { error: 'Not found' });

      const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const session = sessions.get(token);
      if (!session) return sendJson(res, 401, { error: 'Not logged in — please log in again' });

      const params = route.regex.exec(pathname).groups || {};
      const body = (req.method === 'POST' || req.method === 'PATCH') ? await readJsonBody(req) : {};
      const result = await route.handler(session, params, body);
      sendJson(res, 200, result == null ? { success: true } : result);
    } catch (err) {
      sendJson(res, err.statusCode || 400, { error: err.message || 'Something went wrong' });
    }
  });
}

let mobileServer = null;

function stopMobileServer() {
  if (mobileServer) {
    mobileServer.close();
    mobileServer = null;
  }
}

// Called at startup and again at the end of every settings:update — safe
// to call unconditionally since it's idempotent (always stops whatever is
// currently running first). Restarting drops in-flight HTTP connections
// but NOT the `sessions` map itself, so logged-in staff stay logged in
// across a settings save that happens to touch an unrelated field.
function syncMobileServer() {
  stopMobileServer();
  const { enabled, port } = getMobileServerSettings();
  if (!enabled) return;
  mobileServer = createMobileServer();
  mobileServer.on('error', (err) => {
    dialog.showErrorBox('Mobile ordering', `Could not start the mobile ordering server on port ${port}: ${err.message}`);
    mobileServer = null;
  });
  mobileServer.listen(port, '0.0.0.0');
}
