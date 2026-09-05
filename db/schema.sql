-- Restaurant POS — core schema (SQLite)
-- Applied automatically on every app start (see db/db.js) — nothing to run by hand.

-- Staff accounts. pin_hash/pin_salt are scryptSync output (see main.js
-- hashPin/verifyPin) — never the raw PIN. role gates which IPC handlers in
-- main.js a logged-in session may call (see requireRole): 'owner' can do
-- anything; 'manager' additionally can edit the menu and view reports but
-- not touch Settings or staff accounts; 'staff' is order-taking only.
-- is_active lets an owner disable a former staff member's login without
-- deleting them, since orders.created_by_staff_id/closed_by_staff_id
-- reference this table and must survive their departure.
CREATE TABLE IF NOT EXISTS staff (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    pin_hash   TEXT NOT NULL,
    pin_salt   TEXT NOT NULL,
    role       TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'staff')),
    is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Cash-drawer shifts for the terminal — at most one with closed_at IS NULL
-- at a time (enforced in main.js's shifts:open, not a DB constraint: SQLite
-- can't express "at most one NULL" as a plain UNIQUE index, and this is a
-- single-process app so there's no real race to guard against). Sales
-- figures (cash/card/upi_sales, order_count, expected_cash) are computed
-- from order_payments over [opened_at, closed_at] and snapshotted here at
-- close time rather than recomputed live on every later view — same
-- snapshot reasoning as order_items.item_name, so a shift's historical
-- reconciliation record can't drift if the computation logic changes later.
CREATE TABLE IF NOT EXISTS shifts (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    opened_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    opened_by_staff_id  INTEGER REFERENCES staff(id) ON DELETE SET NULL,
    opened_by_name      TEXT NOT NULL,
    opening_float       NUMERIC(10, 2) NOT NULL DEFAULT 0 CHECK (opening_float >= 0),
    -- The last order_payments.id that existed at the moment this shift
    -- opened; sales counted for this shift are id > this. An id boundary
    -- rather than an opened_at/closed_at time range because created_at only
    -- has second-level resolution (SQLite's CURRENT_TIMESTAMP) — a payment
    -- landing in the same second a shift opens or closes would otherwise be
    -- ambiguously double-counted or dropped. id is monotonic and unique.
    opening_payment_id  INTEGER NOT NULL DEFAULT 0,
    closed_at           TEXT,
    closed_by_staff_id  INTEGER REFERENCES staff(id) ON DELETE SET NULL,
    closed_by_name      TEXT,
    cash_sales          NUMERIC(10, 2),
    card_sales          NUMERIC(10, 2),
    upi_sales           NUMERIC(10, 2),
    order_count         INTEGER,
    expected_cash       NUMERIC(10, 2),
    counted_cash        NUMERIC(10, 2),
    notes               TEXT
);

CREATE INDEX IF NOT EXISTS idx_shifts_closed_at ON shifts(closed_at);

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
    -- NULL = not stock-tracked (every item's default) — behaves exactly as
    -- before this column existed. A real number makes is_available
    -- self-managed: order handlers decrement it on add/increment on
    -- remove-or-cancel and flip is_available at the zero boundary
    -- (adjustStock() in main.js), rather than it being a purely manual toggle.
    stock_quantity  INTEGER CHECK (stock_quantity IS NULL OR stock_quantity >= 0),
    created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- A menu item's configurable options (e.g. "Size": Small/Medium/Large,
-- "Add-ons": Extra cheese/Extra sauce). min_select/max_select bound how many
-- options from this group an order must carry: 1/1 = required single choice,
-- 0/1 = optional single choice, 0/N = optional multi-select. Enforced in
-- orders:addItem (main.js), not by a DB constraint (SQLite can't count sibling
-- rows in a CHECK).
CREATE TABLE IF NOT EXISTS modifier_groups (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    menu_item_id  INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    min_select    INTEGER NOT NULL DEFAULT 0 CHECK (min_select >= 0),
    max_select    INTEGER NOT NULL DEFAULT 1 CHECK (max_select >= 1),
    sort_order    INTEGER NOT NULL DEFAULT 0,
    CHECK (min_select <= max_select)
);

CREATE TABLE IF NOT EXISTS modifier_options (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id    INTEGER NOT NULL REFERENCES modifier_groups(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    price_delta NUMERIC(10, 2) NOT NULL DEFAULT 0,
    sort_order  INTEGER NOT NULL DEFAULT 0
);

-- One row per modifier selected on an order line, named/priced at add-time —
-- same snapshot reasoning as order_items.item_name (menu/modifier edits
-- later must not change history). Deliberately NOT folded into order_items'
-- own price math: orders:addItem already adds each selected option's
-- price_delta into order_items.unit_price at insert time, so every
-- total/tax/report calculation elsewhere in this codebase (recalcOrder,
-- lineTax, reports:summary) needs zero changes — this table exists purely
-- for display (ticket/receipt/KOT show which options were picked).
CREATE TABLE IF NOT EXISTS order_item_modifiers (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    order_item_id  INTEGER NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
    name           TEXT NOT NULL,
    price_delta    NUMERIC(10, 2) NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS restaurant_tables (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    seats       INTEGER,
    sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS orders (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    order_type     TEXT NOT NULL DEFAULT 'dine-in' CHECK (order_type IN ('dine-in', 'takeaway', 'delivery')),
    table_label    TEXT,                          -- free-text table name/number, optional
    table_id       INTEGER REFERENCES restaurant_tables(id) ON DELETE SET NULL,
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
    paid_at        TEXT,
    -- Who rang this order up / who closed it out (paid or cancelled) —
    -- *_name is a snapshot (same reasoning as order_items.item_name) so
    -- attribution survives a staff account being deleted later.
    created_by_staff_id INTEGER REFERENCES staff(id) ON DELETE SET NULL,
    created_by_name     TEXT,
    closed_by_staff_id  INTEGER REFERENCES staff(id) ON DELETE SET NULL,
    closed_by_name      TEXT,
    -- Optional, captured at checkout (see billing:finalize) — customers:lookup
    -- matches on customer_phone across past orders to recognize a repeat
    -- customer and suggest their name.
    customer_phone TEXT,
    customer_name  TEXT
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
    tax_amount    NUMERIC(10, 2) NOT NULL DEFAULT 0,
    kot_fired_at  TEXT                -- set once this line has been sent to the kitchen; NULL = not yet fired
);

-- One row per tender on a paid order. A single-mode payment (the common
-- case) gets exactly one row here matching orders.payment_mode/total; a
-- split payment (e.g. part cash + part card) gets one row per tender and
-- orders.payment_mode is left NULL (already a valid value per its CHECK
-- constraint) since there's no single mode to summarize it as. This table is
-- the source of truth for the breakdown either way — orders.payment_mode is
-- kept only as a cheap single-value display shorthand for the common case.
CREATE TABLE IF NOT EXISTS order_payments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    mode       TEXT NOT NULL CHECK (mode IN ('cash', 'card', 'upi')),
    amount     NUMERIC(10, 2) NOT NULL CHECK (amount > 0),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_order_payments_order_id ON order_payments(order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_modifier_groups_menu_item ON modifier_groups(menu_item_id);
CREATE INDEX IF NOT EXISTS idx_modifier_options_group ON modifier_options(group_id);
CREATE INDEX IF NOT EXISTS idx_order_item_modifiers_order_item ON order_item_modifiers(order_item_id);
CREATE INDEX IF NOT EXISTS idx_menu_items_category ON menu_items(category_id);
CREATE INDEX IF NOT EXISTS idx_menu_items_subcategory ON menu_items(subcategory_id);
CREATE INDEX IF NOT EXISTS idx_subcategories_category ON subcategories(category_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
-- idx_orders_table_id is created in db.js, after the table_id column has been
-- backfilled onto pre-existing installs (this file's CREATE TABLE IF NOT EXISTS
-- is a no-op against an orders table that already existed without it).

INSERT INTO settings (key, value) VALUES ('default_tax_percent', '5')
ON CONFLICT (key) DO NOTHING;

INSERT INTO restaurant_tables (name, seats, sort_order) VALUES
    ('T1', 4, 1), ('T2', 4, 2), ('T3', 2, 3), ('T4', 6, 4)
ON CONFLICT (name) DO NOTHING;

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
