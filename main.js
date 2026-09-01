const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const ExcelJS = require('exceljs');
const QRCode = require('qrcode');
const db = require('./db/db');

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
function recalcOrder(orderId) {
  const items = db.prepare('SELECT unit_price, quantity, tax_amount FROM order_items WHERE order_id = ?').all(orderId);
  const subtotal = items.reduce((sum, i) => sum + Number(i.unit_price) * i.quantity, 0);
  const taxAmount = +items.reduce((sum, i) => sum + Number(i.tax_amount), 0).toFixed(2);
  const order = db.prepare('SELECT discount FROM orders WHERE id = ?').get(orderId);
  const discount = Number(order.discount) || 0;
  const total = +((subtotal - discount) + taxAmount).toFixed(2);
  db.prepare('UPDATE orders SET subtotal = ?, tax_amount = ?, total = ? WHERE id = ?')
    .run(subtotal.toFixed(2), taxAmount, total, orderId);
}

function lineTax(unitPrice, quantity, gstRate) {
  return +((Number(unitPrice) * quantity * Number(gstRate)) / 100).toFixed(2);
}

function getSettingsMap() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const map = {};
  rows.forEach((r) => { map[r.key] = r.value; });
  return map;
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
    item.gstRate != null ? item.gstRate : 5
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
    item.gstRate != null ? item.gstRate : 5,
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
  const info = categoryId
    ? db.prepare('UPDATE menu_items SET gst_rate = ? WHERE category_id = ?').run(gstRate, categoryId)
    : db.prepare('UPDATE menu_items SET gst_rate = ?').run(gstRate);
  return { success: true, updated: info.changes };
});

// ---------- Orders ----------
ipcMain.handle('orders:listOpen', () => {
  return db.prepare(`SELECT * FROM orders WHERE status = 'open' ORDER BY created_at DESC`).all();
});

ipcMain.handle('orders:listAll', () => {
  return db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
});

ipcMain.handle('orders:create', (_e, { orderType, tableLabel, source }) => {
  return db.prepare('INSERT INTO orders (order_type, table_label, source) VALUES (?, ?, ?) RETURNING *')
    .get(orderType || 'dine-in', tableLabel || null, source || 'in-house');
});

ipcMain.handle('orders:get', (_e, orderId) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return null;
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(orderId);
  return { ...order, items };
});

ipcMain.handle('orders:addItem', (_e, { orderId, menuItemId, name, price, quantity, notes }) => {
  const menuItem = menuItemId
    ? db.prepare('SELECT hsn_code, gst_rate FROM menu_items WHERE id = ?').get(menuItemId)
    : null;
  const hsnCode = menuItem ? menuItem.hsn_code : null;
  const gstRate = menuItem ? Number(menuItem.gst_rate) : 0;
  const qty = quantity || 1;
  db.prepare(
    `INSERT INTO order_items (order_id, menu_item_id, item_name, unit_price, quantity, notes, hsn_code, gst_rate, tax_amount)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(orderId, menuItemId, name, price, qty, notes || null, hsnCode, gstRate, lineTax(price, qty, gstRate));
  recalcOrder(orderId);
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
});

ipcMain.handle('orders:updateItemQty', (_e, { orderItemId, quantity, orderId }) => {
  if (quantity <= 0) {
    db.prepare('DELETE FROM order_items WHERE id = ?').run(orderItemId);
  } else {
    const line = db.prepare('SELECT unit_price, gst_rate FROM order_items WHERE id = ?').get(orderItemId);
    db.prepare('UPDATE order_items SET quantity = ?, tax_amount = ? WHERE id = ?')
      .run(quantity, lineTax(line.unit_price, quantity, line.gst_rate), orderItemId);
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
  db.prepare('UPDATE orders SET discount = ? WHERE id = ?').run(discount || 0, orderId);
  recalcOrder(orderId);
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
});

ipcMain.handle('orders:cancel', (_e, orderId) => {
  return db.prepare(`UPDATE orders SET status = 'cancelled' WHERE id = ? RETURNING *`).get(orderId);
});

// ---------- Billing ----------
ipcMain.handle('billing:finalize', (_e, { orderId, paymentMode }) => {
  const invoiceNumber = getNextInvoiceNumber();
  return db.prepare(
    `UPDATE orders SET status = 'paid', payment_mode = ?, paid_at = CURRENT_TIMESTAMP, invoice_number = ?
     WHERE id = ? RETURNING *`
  ).get(paymentMode, invoiceNumber, orderId);
});

ipcMain.handle('billing:getReceipt', async (_e, orderId) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
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

  const settings = getSettingsMap();
  const business = {
    name: settings.business_name || '',
    address: settings.business_address || '',
    phone: settings.business_phone || '',
    gstin: settings.gstin || '',
    fssaiNo: settings.fssai_no || '',
    footerNote: settings.footer_note || '',
    zomatoRestaurantId: settings.zomato_restaurant_id || '',
  };

  let qrDataUrl = null;
  if (settings.upi_id && order.status === 'paid') {
    const upiUrl = `upi://pay?pa=${encodeURIComponent(settings.upi_id)}&pn=${encodeURIComponent(business.name || 'Merchant')}&am=${order.total}&cu=INR&tn=${encodeURIComponent('Order ' + (order.invoice_number || order.id))}`;
    qrDataUrl = await QRCode.toDataURL(upiUrl, { margin: 1, width: 180 });
  }

  return { ...order, items, gstBreakdown, business, qrDataUrl };
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
