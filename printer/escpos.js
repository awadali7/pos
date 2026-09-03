// Hand-written ESC/POS command builder for raw thermal-printer output sent
// directly over a TCP socket (printer_mode = 'network'). No npm dependency —
// these are standard, widely-documented Epson ESC/POS control codes supported
// by virtually every cheap thermal receipt printer (and its clones).
//
// All text is emitted as Buffer.from(str, 'latin1'): thermal printers almost
// universally default to a single-byte code page (CP437/Latin-1-ish), not
// UTF-8, so multi-byte UTF-8 sequences would print as garbage bytes. This
// means any business/item text outside the Latin-1 range (codepoint > 255)
// will be mangled on paper — an accepted limitation of plain ESC/POS text
// mode, not a bug to fix here.

'use strict';

// ---------- Raw command bytes ----------
const INIT = '\x1B\x40'; // ESC @  - initialize printer (reset formatting/state)
const ALIGN_LEFT = '\x1B\x61\x00'; // ESC a 0
const ALIGN_CENTER = '\x1B\x61\x01'; // ESC a 1
const ALIGN_RIGHT = '\x1B\x61\x02'; // ESC a 2
const BOLD_ON = '\x1B\x45\x01'; // ESC E 1
const BOLD_OFF = '\x1B\x45\x00'; // ESC E 0
const LF = '\x0A'; // line feed
// GS V m — paper cut. m=0 ("full cut") is used rather than m=1 ("partial
// cut") because it is the more universally honored of the two across cheap
// ESC/POS clones; a printer that only supports partial cut typically still
// accepts 0 and just performs its one available cut style.
const CUT = '\x1D\x56\x00';

function textToBuffer(str) {
  return Buffer.from(str, 'latin1');
}

// ---------- Column layouts ----------
// 58mm paper ≈ 32 characters per line, 80mm ≈ 48 characters, at a thermal
// printer's default (font A, 1x) character size. Column widths below are
// CONTENT widths only — tableRow() below joins columns with an explicit
// single-space separator on top of these, so the widths intentionally sum to
// (line width - number of gaps), not the full line width. Packing columns to
// sum exactly to the line width (with no reserved gap) was the original bug
// here: a right-aligned value that exactly fills its column touches the next
// column's value with zero space between them — e.g. qty "1" immediately
// followed by rate "320.00" prints as "1320.00", which for the items table
// happens for essentially any 3-digit rupee price (the common case, not an
// edge case). The explicit separator makes that impossible regardless of
// content width.
const LAYOUTS = {
  '58': {
    width: 32,
    items: { item: 12, qty: 3, rate: 6, amt: 8 }, // sum 29 + 3 gaps = 32
    gst: { hsn: 8, rate: 5, cgst: 8, sgst: 8 }, // sum 29 + 3 gaps = 32
  },
  '80': {
    width: 48,
    items: { item: 20, qty: 4, rate: 8, amt: 13 }, // sum 45 + 3 gaps = 48
    gst: { hsn: 11, rate: 7, cgst: 13, sgst: 14 }, // sum 45 + 3 gaps = 48
  },
};

function getLayout(paperWidthMm) {
  return LAYOUTS[String(paperWidthMm)] || LAYOUTS['80'];
}

// ---------- Small text helpers ----------
function money(n) {
  return Number(n || 0).toFixed(2);
}

function padEnd(str, width) {
  const s = String(str == null ? '' : str).slice(0, width);
  return s.padEnd(width, ' ');
}

// Right-aligned numeric fields must never be truncated from the front —
// slicing to `width` here would drop the least-significant digits (and/or
// the decimal point) of a Rate/Amt/CGST/SGST figure, printing a garbled,
// factually wrong number. If the value doesn't fit, let it overflow the
// column (pushing later columns right) rather than corrupt it.
function padStart(str, width) {
  const s = String(str == null ? '' : str);
  return s.length >= width ? s : s.padStart(width, ' ');
}

// Joins column {text, width, align} entries with a single guaranteed space
// between each — see the LAYOUTS comment above for why the gap must be
// explicit rather than left to the column widths summing to the line width.
function tableRow(cols) {
  return cols
    .map((c) => (c.align === 'right' ? padStart(c.text, c.width) : padEnd(c.text, c.width)))
    .join(' ');
}

// Lays `label` and `value` out flush-left / flush-right within `width`,
// truncating the label (never the value) if the two would overlap.
function kv(label, value, width) {
  const valueStr = String(value == null ? '' : value);
  const maxLabelLen = Math.max(0, width - valueStr.length);
  const labelStr = String(label == null ? '' : label).slice(0, maxLabelLen);
  const padding = Math.max(0, width - labelStr.length - valueStr.length);
  return labelStr + ' '.repeat(padding) + valueStr;
}

function formatDate(timestamp) {
  if (!timestamp) return '';
  try {
    return new Date(String(timestamp).replace(' ', 'T') + 'Z').toLocaleString();
  } catch (e) {
    return String(timestamp);
  }
}

// Shared with main.js's payment-breakdown text (see buildReceiptHtml there)
// so "cash"/"card"/"upi" render as "Cash"/"Card"/"Upi" in exactly one place
// instead of each caller re-implementing the same one-liner.
function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------- Full receipt builder ----------
// Mirrors renderReceipt() in src/renderer.js content-for-content (business
// header, invoice/order #, date, order type + table, items table, totals,
// GST HSN/rate/CGST/SGST breakdown, payment mode, footer note) with two
// deliberate differences: money is prefixed "Rs." instead of "₹" (plain
// ESC/POS text mode on cheap thermal printers generally can't render "₹"
// without a special code page), and the UPI QR code is omitted — rendering
// a raster image via ESC/POS (GS v 0 and friends) is meaningfully bigger
// scope than plain text and is left for a future enhancement.
function buildReceiptBuffer({ business = {}, order = {}, items = [], gstBreakdown = [], payments = [], paperWidthMm } = {}) {
  const layout = getLayout(paperWidthMm);
  const W = layout.width;
  const rule = '-'.repeat(W);

  let out = INIT;

  // Header: business info, centered.
  out += ALIGN_CENTER;
  if (business.name) out += BOLD_ON + business.name + LF + BOLD_OFF;
  if (business.address) out += business.address + LF;
  if (business.phone) out += 'Ph: ' + business.phone + LF;
  if (business.gstin) out += 'GSTIN: ' + business.gstin + LF;
  if (business.fssaiNo) out += 'FSSAI: ' + business.fssaiNo + LF;
  out += LF;

  // Meta: invoice/order #, date, type + table, source.
  out += ALIGN_LEFT;
  const invoiceLabel = order.invoice_number ? 'Invoice #' : 'Order #';
  const invoiceValue = order.invoice_number || String(order.id != null ? order.id : '');
  out += kv(invoiceLabel, invoiceValue, W) + LF;
  out += kv('Date', formatDate(order.paid_at || order.created_at), W) + LF;
  const typeValue = (order.order_type || '') + (order.table_label ? ' - ' + order.table_label : '');
  out += kv('Type', typeValue, W) + LF;
  if (order.source === 'zomato') {
    const zomatoValue = 'Zomato' + (business.zomatoRestaurantId ? ' - ' + business.zomatoRestaurantId : '');
    out += kv('Source', zomatoValue, W) + LF;
  }
  out += rule + LF;

  // Items table: Item / Qty / Rate / Amt.
  const ic = layout.items;
  out += BOLD_ON + tableRow([
    { text: 'Item', width: ic.item },
    { text: 'Qty', width: ic.qty, align: 'right' },
    { text: 'Rate', width: ic.rate, align: 'right' },
    { text: 'Amt', width: ic.amt, align: 'right' },
  ]) + LF + BOLD_OFF;
  items.forEach((i) => {
    const qty = Number(i.quantity) || 0;
    const rate = Number(i.unit_price) || 0;
    out += tableRow([
      { text: i.item_name, width: ic.item },
      { text: String(qty), width: ic.qty, align: 'right' },
      { text: money(rate), width: ic.rate, align: 'right' },
      { text: money(rate * qty), width: ic.amt, align: 'right' },
    ]) + LF;
    const modNames = (i.modifiers || []).map((m) => m.name).join(', ');
    if (modNames) out += '  ' + modNames + LF;
  });
  out += rule + LF;

  // Totals.
  out += kv('Subtotal', 'Rs.' + money(order.subtotal), W) + LF;
  if (Number(order.discount) > 0) {
    out += kv('Discount', '-Rs.' + money(order.discount), W) + LF;
  }
  out += kv('Tax (GST)', 'Rs.' + money(order.tax_amount), W) + LF;
  out += BOLD_ON + kv('TOTAL', 'Rs.' + money(order.total), W) + LF + BOLD_OFF;
  out += rule + LF;

  // GST HSN/rate/CGST/SGST breakdown.
  const gstRows = (gstBreakdown || []).filter((g) => Number(g.gstRate) > 0);
  if (gstRows.length) {
    const gc = layout.gst;
    out += 'GST Details' + LF;
    out += BOLD_ON + tableRow([
      { text: 'HSN', width: gc.hsn },
      { text: 'Tax%', width: gc.rate, align: 'right' },
      { text: 'CGST', width: gc.cgst, align: 'right' },
      { text: 'SGST', width: gc.sgst, align: 'right' },
    ]) + LF + BOLD_OFF;
    gstRows.forEach((g) => {
      out += tableRow([
        { text: g.hsnCode || '-', width: gc.hsn },
        { text: String(g.gstRate), width: gc.rate, align: 'right' },
        { text: money(g.cgst), width: gc.cgst, align: 'right' },
        { text: money(g.sgst), width: gc.sgst, align: 'right' },
      ]) + LF;
    });
    out += rule + LF;
  }

  // Payment mode — a breakdown line per tender for a split payment (more
  // than one row in `payments`), the plain single-mode line otherwise
  // (unchanged, and the only option for a paid order predating this
  // feature, which has no order_payments rows at all).
  if (payments.length > 1) {
    out += 'Paid via: ' + payments.map((p) => `${capitalize(p.mode)} Rs.${money(p.amount)}`).join(', ') + LF;
  } else if (order.payment_mode) {
    out += 'Paid via ' + order.payment_mode + LF;
  }

  // NOTE: the UPI "Scan and Pay" QR code shown on-screen/in the dialog and
  // system print paths is intentionally not rendered here — see file header.

  // Footer note, centered.
  if (business.footerNote) {
    out += LF + ALIGN_CENTER + business.footerNote + LF;
  }

  out += LF + LF + LF + CUT;

  return textToBuffer(out);
}

// ---------- Kitchen Order Ticket builder ----------
// Kitchen-facing ticket: item name + qty (bold, large) and notes only — no
// prices, no GST. Deliberately separate from buildReceiptBuffer() above:
// the kitchen needs to read this from across a pass-through window, and
// showing prices there would leak pricing info to kitchen staff. Caller is
// responsible for passing only the order_items that haven't been fired yet
// (see receipt:printKot in main.js) so re-firing an order only sends what's
// new since the last ticket.
function buildKotBuffer({ order = {}, items = [], paperWidthMm } = {}) {
  const layout = getLayout(paperWidthMm);
  const W = layout.width;
  const rule = '-'.repeat(W);

  let out = INIT;
  out += ALIGN_CENTER + BOLD_ON + 'KITCHEN ORDER TICKET' + LF + BOLD_OFF;
  const typeValue = (order.order_type || '') + (order.table_label ? ' - ' + order.table_label : '');
  if (typeValue.trim()) out += typeValue + LF;
  if (order.id != null) out += 'Order #' + String(order.id) + LF;
  out += new Date().toLocaleString() + LF;
  out += ALIGN_LEFT + rule + LF;

  items.forEach((i) => {
    const qty = Number(i.quantity) || 0;
    out += BOLD_ON + tableRow([
      { text: i.item_name, width: W - 5 },
      { text: 'x' + String(qty), width: 4, align: 'right' },
    ]) + LF + BOLD_OFF;
    const modNames = (i.modifiers || []).map((m) => m.name).join(', ');
    if (modNames) out += '  ' + modNames + LF;
    if (i.notes) out += '  ' + i.notes + LF;
  });
  out += rule + LF + LF + LF + CUT;

  return textToBuffer(out);
}

module.exports = {
  INIT,
  ALIGN_LEFT,
  ALIGN_CENTER,
  ALIGN_RIGHT,
  BOLD_ON,
  BOLD_OFF,
  LF,
  CUT,
  getLayout,
  capitalize,
  buildReceiptBuffer,
  buildKotBuffer,
};
