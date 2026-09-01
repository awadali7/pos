-- Restaurant POS — core schema (SQLite)
-- Applied automatically on every app start (see db/db.js) — nothing to run by hand.

CREATE TABLE IF NOT EXISTS categories (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS subcategories (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    UNIQUE (category_id, name)
);

CREATE TABLE IF NOT EXISTS menu_items (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    price           NUMERIC(10, 2) NOT NULL CHECK (price >= 0),
    category_id     INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    subcategory_id  INTEGER REFERENCES subcategories(id) ON DELETE SET NULL,
    is_available    INTEGER NOT NULL DEFAULT 1 CHECK (is_available IN (0, 1)),
    hsn_code        TEXT,
    gst_rate        NUMERIC(5, 2) NOT NULL DEFAULT 5,
    created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS orders (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    order_type     TEXT NOT NULL DEFAULT 'dine-in' CHECK (order_type IN ('dine-in', 'takeaway', 'delivery')),
    table_label    TEXT,                          -- free-text table name/number, optional
    source         TEXT NOT NULL DEFAULT 'in-house' CHECK (source IN ('in-house', 'zomato')),
    status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'cancelled')),
    subtotal       NUMERIC(10, 2) NOT NULL DEFAULT 0,
    tax_percent    NUMERIC(5, 2) NOT NULL DEFAULT 5,
    tax_amount     NUMERIC(10, 2) NOT NULL DEFAULT 0,
    discount       NUMERIC(10, 2) NOT NULL DEFAULT 0,
    total          NUMERIC(10, 2) NOT NULL DEFAULT 0,
    payment_mode   TEXT CHECK (payment_mode IN ('cash', 'card', 'upi', NULL)),
    invoice_number TEXT,
    created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    paid_at        TEXT
);

CREATE TABLE IF NOT EXISTS order_items (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id      INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    menu_item_id  INTEGER REFERENCES menu_items(id) ON DELETE SET NULL,
    item_name     TEXT NOT NULL,      -- snapshot, so history stays correct if menu changes later
    unit_price    NUMERIC(10, 2) NOT NULL,
    quantity      INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
    notes         TEXT,
    hsn_code      TEXT,               -- snapshot from the menu item, same reasoning as item_name
    gst_rate      NUMERIC(5, 2) NOT NULL DEFAULT 0,
    tax_amount    NUMERIC(10, 2) NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_menu_items_category ON menu_items(category_id);
CREATE INDEX IF NOT EXISTS idx_menu_items_subcategory ON menu_items(subcategory_id);
CREATE INDEX IF NOT EXISTS idx_subcategories_category ON subcategories(category_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

INSERT INTO settings (key, value) VALUES ('default_tax_percent', '5')
ON CONFLICT (key) DO NOTHING;

-- Seed a few starter categories + items so the app isn't empty on first run.
-- Every INSERT below is written to be a no-op on repeat runs, since this file
-- is applied on every app start.
INSERT INTO categories (name, sort_order) VALUES
    ('Starters', 1), ('Main Course', 2), ('Beverages', 3), ('Desserts', 4)
ON CONFLICT (name) DO NOTHING;

INSERT INTO subcategories (name, category_id, sort_order)
SELECT v.name, c.id, v.sort_order FROM (
    SELECT 'Vegetarian' AS name, 'Main Course' AS cat_name, 1 AS sort_order
    UNION ALL SELECT 'Non-Vegetarian', 'Main Course', 2
    UNION ALL SELECT 'Hot', 'Beverages', 1
    UNION ALL SELECT 'Cold', 'Beverages', 2
) AS v
JOIN categories c ON c.name = v.cat_name
ON CONFLICT (category_id, name) DO NOTHING;

INSERT INTO menu_items (name, price, category_id, subcategory_id)
SELECT v.name, v.price, c.id, sc.id FROM (
    SELECT 'Veg Spring Rolls' AS name, 180.00 AS price, 'Starters' AS cat_name, NULL AS subcat_name
    UNION ALL SELECT 'Paneer Tikka', 220.00, 'Starters', NULL
    UNION ALL SELECT 'Butter Chicken', 320.00, 'Main Course', 'Non-Vegetarian'
    UNION ALL SELECT 'Dal Makhani', 240.00, 'Main Course', 'Vegetarian'
    UNION ALL SELECT 'Masala Chai', 40.00, 'Beverages', 'Hot'
    UNION ALL SELECT 'Cold Coffee', 90.00, 'Beverages', 'Cold'
    UNION ALL SELECT 'Gulab Jamun', 90.00, 'Desserts', NULL
) AS v
JOIN categories c ON c.name = v.cat_name
LEFT JOIN subcategories sc ON sc.name = v.subcat_name AND sc.category_id = c.id
WHERE NOT EXISTS (SELECT 1 FROM menu_items WHERE menu_items.name = v.name);
