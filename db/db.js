// Local SQLite database — no server, no credentials, nothing to install.
// The file is created (with schema + starter data) automatically the first
// time the app runs. Override the folder via RESTAURANT_POS_DATA_DIR if needed.
const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const dataDir = process.env.RESTAURANT_POS_DATA_DIR || path.join(os.homedir(), '.restaurant-pos');
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'restaurant_pos.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// SQLite's ALTER TABLE has no "ADD COLUMN IF NOT EXISTS" — for columns added to
// tables that may already exist from an earlier version of this app, patch them
// in by hand instead. A no-op once every install has caught up.
function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

ensureColumn('menu_items', 'hsn_code', 'TEXT');
ensureColumn('menu_items', 'gst_rate', 'NUMERIC(5,2) NOT NULL DEFAULT 5');
ensureColumn('order_items', 'hsn_code', 'TEXT');
ensureColumn('order_items', 'gst_rate', 'NUMERIC(5,2) NOT NULL DEFAULT 0');
ensureColumn('order_items', 'tax_amount', 'NUMERIC(10,2) NOT NULL DEFAULT 0');
ensureColumn('orders', 'invoice_number', 'TEXT');
ensureColumn('orders', 'source', "TEXT NOT NULL DEFAULT 'in-house'");

module.exports = db;
