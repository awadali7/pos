const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const net = require('net');
const ExcelJS = require('exceljs');
const QRCode = require('qrcode');
const db = require('./db/db');
const escpos = require('./printer/escpos');

let mainWindow;

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

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
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

  return { order, items, gstBreakdown, business };
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
function buildReceiptHtml({ business = {}, order = {}, items = [], gstBreakdown = [], paperWidthMm } = {}) {
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

  const itemsRows = items.map((i) => `
    <tr>
      <td>${escapeHtml(i.item_name)}</td>
      <td class="num">${Number(i.quantity) || 0}</td>
      <td class="num">${money(i.unit_price)}</td>
      <td class="num">${money(Number(i.unit_price) * Number(i.quantity))}</td>
    </tr>`).join('');

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

  const paymentHtml = order.payment_mode ? `<div class="center">Paid via ${escapeHtml(order.payment_mode)}</div>` : '';
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
async function printReceipt({ order, items, gstBreakdown, business }) {
  const { mode, systemName, networkHost, networkPort, paperWidthMm } = getPrinterSettings();

  if (mode === 'system') {
    if (!systemName) throw new Error('No system printer selected — choose one in Settings first');
    const html = buildReceiptHtml({ business, order, items, gstBreakdown, paperWidthMm });
    await printHtmlToSystemPrinter(html, { deviceName: systemName, paperWidthMm });
    return { mode: 'system' };
  }

  if (mode === 'network') {
    if (!networkHost) throw new Error('No network printer host configured — set one in Settings first');
    const buffer = escpos.buildReceiptBuffer({ business, order, items, gstBreakdown, paperWidthMm });
    await printBufferToNetworkPrinter(buffer, { host: networkHost, port: networkPort });
    return { mode: 'network' };
  }

  // mode === 'dialog' (or unset/unrecognized) — behavior-preserving default.
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

// ---------- Menu: Categories ----------
ipcMain.handle('categories:list', () => {
  return db.prepare('SELECT * FROM categories ORDER BY sort_order, name').all();
});

ipcMain.handle('categories:add', (_e, name) => {
  return db.prepare('INSERT INTO categories (name) VALUES (?) RETURNING *').get(name);
});

ipcMain.handle('categories:delete', (_e, id) => {
  db.prepare('DELETE FROM categories WHERE id = ?').run(id);
  return { success: true };
});

// ---------- Menu: Subcategories ----------
ipcMain.handle('subcategories:list', () => {
  return db.prepare('SELECT * FROM subcategories ORDER BY sort_order, name').all();
});

ipcMain.handle('subcategories:add', (_e, { name, categoryId }) => {
  return db.prepare('INSERT INTO subcategories (name, category_id) VALUES (?, ?) RETURNING *')
    .get(name, categoryId);
});

ipcMain.handle('subcategories:delete', (_e, id) => {
  db.prepare('DELETE FROM subcategories WHERE id = ?').run(id);
  return { success: true };
});

// ---------- Menu: Items ----------
ipcMain.handle('menu:list', () => {
  return db.prepare(`
    SELECT m.*, c.name AS category_name, sc.name AS subcategory_name
    FROM menu_items m
    LEFT JOIN categories c ON c.id = m.category_id
    LEFT JOIN subcategories sc ON sc.id = m.subcategory_id
    ORDER BY c.sort_order NULLS LAST, m.name
  `).all();
});

ipcMain.handle('menu:add', (_e, item) => {
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
  db.prepare('DELETE FROM menu_items WHERE id = ?').run(id);
  return { success: true };
});

ipcMain.handle('menu:toggleAvailability', (_e, id) => {
  return db.prepare('UPDATE menu_items SET is_available = NOT is_available WHERE id = ? RETURNING *').get(id);
});

ipcMain.handle('menu:bulkSetGstRate', (_e, { gstRate, categoryId }) => {
  const rate = assertValidGstRate(gstRate);
  const info = categoryId
    ? db.prepare('UPDATE menu_items SET gst_rate = ? WHERE category_id = ?').run(rate, categoryId)
    : db.prepare('UPDATE menu_items SET gst_rate = ?').run(rate);
  return { success: true, updated: info.changes };
});

// ---------- Tables ----------
ipcMain.handle('tables:list', () => {
  return db.prepare(`
    SELECT t.*, o.id AS order_id, o.total AS order_total, o.created_at AS order_created_at
    FROM restaurant_tables t
    LEFT JOIN orders o ON o.table_id = t.id AND o.status = 'open'
    ORDER BY t.sort_order, t.name
  `).all();
});

ipcMain.handle('tables:add', (_e, { name, seats }) => {
  const cleanName = String(name || '').trim();
  if (!cleanName) throw new Error('Table name is required');
  const seatCount = seats != null && seats !== '' ? Number(seats) : null;
  if (seatCount != null && (!Number.isInteger(seatCount) || seatCount <= 0)) {
    throw new Error('Seats must be a positive whole number');
  }
  return db.prepare('INSERT INTO restaurant_tables (name, seats) VALUES (?, ?) RETURNING *').get(cleanName, seatCount);
});

ipcMain.handle('tables:delete', (_e, id) => {
  const openOrder = db.prepare(`SELECT id FROM orders WHERE table_id = ? AND status = 'open'`).get(id);
  if (openOrder) throw new Error('This table has an open order — close or cancel it first');
  db.prepare('DELETE FROM restaurant_tables WHERE id = ?').run(id);
  return { success: true };
});

// ---------- Orders ----------
ipcMain.handle('orders:listOpen', () => {
  return db.prepare(`SELECT * FROM orders WHERE status = 'open' ORDER BY created_at DESC`).all();
});

ipcMain.handle('orders:listAll', () => {
  return db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
});

ipcMain.handle('orders:create', (_e, { orderType, tableLabel, source, tableId }) => {
  let label = tableLabel || null;
  let linkedTableId = tableId || null;
  if (linkedTableId) {
    const table = db.prepare('SELECT * FROM restaurant_tables WHERE id = ?').get(linkedTableId);
    if (!table) throw new Error('Table not found');
    const existing = db.prepare(`SELECT id FROM orders WHERE table_id = ? AND status = 'open'`).get(linkedTableId);
    if (existing) throw new Error(`Table "${table.name}" already has an open order`);
    label = table.name;
  }
  return db.prepare('INSERT INTO orders (order_type, table_label, table_id, source) VALUES (?, ?, ?, ?) RETURNING *')
    .get(orderType || 'dine-in', label, linkedTableId, source || 'in-house');
});

ipcMain.handle('orders:get', (_e, orderId) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return null;
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(orderId);
  return { ...order, items };
});

ipcMain.handle('orders:addItem', (_e, { orderId, menuItemId, name, price, quantity, notes }) => {
  // Price/name/HSN/GST always come from the menu server-side when a real
  // menuItemId is given — the caller's own price/name are only trusted for a
  // one-off custom line (no menuItemId), and even then must be a sane number.
  const menuItem = menuItemId
    ? db.prepare('SELECT name, price, hsn_code, gst_rate FROM menu_items WHERE id = ?').get(menuItemId)
    : null;
  if (menuItemId && !menuItem) throw new Error('Menu item not found');

  const itemName = menuItem ? menuItem.name : String(name || '').trim();
  if (!itemName) throw new Error('Item name is required');

  const unitPrice = menuItem ? Number(menuItem.price) : Number(price);
  if (!Number.isFinite(unitPrice) || unitPrice < 0) throw new Error('Invalid price');

  const hsnCode = menuItem ? menuItem.hsn_code : null;
  const gstRate = menuItem ? Number(menuItem.gst_rate) : 0;

  const qty = quantity == null ? 1 : Number(quantity);
  if (!Number.isInteger(qty) || qty <= 0) throw new Error('Quantity must be a positive whole number');

  db.prepare(
    `INSERT INTO order_items (order_id, menu_item_id, item_name, unit_price, quantity, notes, hsn_code, gst_rate, tax_amount)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(orderId, menuItemId, itemName, unitPrice, qty, notes || null, hsnCode, gstRate, lineTax(unitPrice, qty, gstRate));
  recalcOrder(orderId);
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
});

ipcMain.handle('orders:updateItemQty', (_e, { orderItemId, quantity, orderId }) => {
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
});

ipcMain.handle('orders:removeItem', (_e, { orderItemId, orderId }) => {
  db.prepare('DELETE FROM order_items WHERE id = ?').run(orderItemId);
  recalcOrder(orderId);
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
});

ipcMain.handle('orders:setDiscount', (_e, { orderId, discount }) => {
  const value = Number(discount);
  const safeDiscount = Number.isFinite(value) && value > 0 ? value : 0;
  // recalcOrder clamps this down further to at most subtotal + tax, so the
  // total can never go negative regardless of what was requested here.
  db.prepare('UPDATE orders SET discount = ? WHERE id = ?').run(safeDiscount, orderId);
  recalcOrder(orderId);
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
});

ipcMain.handle('orders:cancel', (_e, orderId) => {
  const order = db.prepare(`UPDATE orders SET status = 'cancelled' WHERE id = ? AND status = 'open' RETURNING *`).get(orderId);
  if (!order) throw new Error('Only open orders can be cancelled');
  return order;
});

// ---------- Billing ----------
ipcMain.handle('billing:finalize', (_e, { orderId, paymentMode }) => {
  const order = db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId);
  if (!order) throw new Error('Order not found');
  if (order.status !== 'open') throw new Error('Only open orders can be charged');
  // Status is checked before consuming an invoice number, so a rejected
  // charge (already paid/cancelled) never burns a gap in the sequence.
  const invoiceNumber = getNextInvoiceNumber();
  return db.prepare(
    `UPDATE orders SET status = 'paid', payment_mode = ?, paid_at = CURRENT_TIMESTAMP, invoice_number = ?
     WHERE id = ? RETURNING *`
  ).get(paymentMode, invoiceNumber, orderId);
});

ipcMain.handle('billing:getReceipt', async (_e, orderId) => {
  const { order, items, gstBreakdown, business } = assembleReceiptData(orderId);
  const settings = getSettingsMap();

  let qrDataUrl = null;
  if (settings.upi_id && order.status === 'paid') {
    const upiUrl = `upi://pay?pa=${encodeURIComponent(settings.upi_id)}&pn=${encodeURIComponent(business.name || 'Merchant')}&am=${order.total}&cu=INR&tn=${encodeURIComponent('Order ' + (order.invoice_number || order.id))}`;
    qrDataUrl = await QRCode.toDataURL(upiUrl, { margin: 1, width: 180 });
  }

  return { ...order, items, gstBreakdown, business, qrDataUrl };
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
  const { order, items, gstBreakdown, business } = assembleReceiptData(orderId);
  return printReceipt({ order, items, gstBreakdown, business });
});

// Prints a synthetic, made-up receipt (current business settings + two fake
// line items) so the owner can validate printer settings from the Settings
// screen without ringing up and paying a real order. Same three-way
// mode/{mode} contract as receipt:print.
ipcMain.handle('receipt:testPrint', async () => {
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

// ---------- Reports ----------
ipcMain.handle('reports:summary', (_e, { startDate, endDate }) => {
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
  };
});

ipcMain.handle('settings:update', (_e, payload) => {
  const upsert = db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value
  `);
  Object.entries(payload).forEach(([field, value]) => {
    const key = SETTINGS_FIELDS[field];
    if (key) upsert.run(key, String(value ?? ''));
  });
  return { success: true };
});
