# Project State (index)

Generated reference for Restaurant POS's structure — kept current by the
[project-memory](.claude/skills/project-memory/SKILL.md) skill. Regenerate
the relevant section any time an IPC channel, table/column, view, or
settings key is added, removed, or renamed. This file is a map, not
documentation — see [README.md](README.md) for what the app does.

## IPC channels (`main.js` handlers, exposed via `preload.js` as `window.pos.*`)

| Namespace | Channels |
|---|---|
| `staff` | `needsSetup`, `createFirstOwner`, `login`, `logout`, `whoAmI`, `list`, `add`, `update`, `delete` |
| `categories` | `list`, `add`, `delete` |
| `subcategories` | `list`, `add`, `delete` |
| `menu` | `list`, `add`, `update`, `delete`, `toggleAvailability`, `bulkSetGstRate`, `updateStock` |
| `modifiers` | `listGroups`, `addGroup`, `deleteGroup`, `addOption`, `deleteOption` |
| `tables` | `list`, `add`, `delete` |
| `orders` | `listOpen`, `listAll`, `create`, `get`, `addItem`, `updateItemQty`, `removeItem`, `setDiscount`, `cancel` |
| `billing` | `finalize`, `getReceipt` |
| `customers` | `lookup` |
| `shifts` | `current`, `open`, `preview`, `close`, `history` |
| `printers` | `listSystem` |
| `receipt` | `print`, `testPrint`, `printKot`, `confirmKotPrinted`, `testPrintKot` |
| `reports` | `summary`, `exportExcel` |
| `settings` | `get`, `update` |
| `mobile` | `getServerInfo` |
| `backup` | `create`, `list` |

`billing:finalize` takes either `paymentMode` (single tender, unchanged since v1) or `payments: [{mode, amount}]` (split payment — must sum to the order total within 1 paisa). `orders:addItem` takes an optional `modifierOptionIds: [id, ...]` — server re-fetches each option's name/price and validates it against the menu item's modifier groups' min/max-select bounds. `billing:finalize` also takes optional `customerPhone`/`customerName` (captured at checkout, see `orders.customer_phone`/`customer_name` below); `customers:lookup(phone)` returns `{name, visitCount}` (visitCount excludes cancelled orders) or `null` if that phone has no history — used to recognize a repeat customer at checkout.

**Access control**: `main.js` holds an in-memory `currentStaff` session (`{id, name, role}`, set by `staff:login`/`staff:createFirstOwner`, cleared by `staff:logout`) and every privileged handler calls `requireRole(...roles)` or `requireLogin()` before doing anything — this is the *real* enforcement, not just UI. Role gates: `owner` only — `settings:update`, all `staff:*` management (add/update/delete/list), `backup:*`; `owner`+`manager` — menu/category/subcategory/modifier writes, `reports:*`, `shifts:history`; any logged-in role — `orders:create`, `billing:finalize`, `orders:cancel`, `shifts:open`, `shifts:close` (order handlers also stamp `orders.created_by_*`/`closed_by_*`). Reads (list/get endpoints) are ungated. The renderer's own role check (`applyRolePermissions()` in `renderer.js`) only hides tabs — it is not a security boundary by itself. `requireRole`/`requireLogin` are thin wrappers around session-parameterized `requireRoleFor`/`requireLoginFor` that read the global `currentStaff` — the mobile ordering server (below) calls the `*For` versions directly with its own per-device session instead, so a phone logging in can never stomp the desktop's session or vice versa.

**Shifts**: one open shift (`shifts` row with `closed_at IS NULL`) at a time for the whole terminal — not per staff member, since the cash drawer is one physical thing. "Sales during a shift" is computed from `order_payments` bounded by `shifts.opening_payment_id` (an id, not a timestamp range — `computeShiftSales()` in `main.js`; see the comment on that column for why a time range doesn't work: `created_at` only has second-level resolution). Figures (`cash_sales`/`card_sales`/`upi_sales`/`order_count`/`expected_cash`) are snapshotted onto the row at `shifts:close`, not recomputed live afterward.

Every channel above has a 1:1 `ipcMain.handle('ns:action', ...)` in
`main.js` and a matching `ns.action(...)` method in `preload.js`. There is
no other path from renderer to main process.

## Database tables (`db/schema.sql`)

- `staff` (id, name, pin_hash, pin_salt, role [`owner`\|`manager`\|`staff`], is_active, created_at) — `pin_hash`/`pin_salt` are `crypto.scryptSync` output, never the raw PIN. `is_active` soft-disables a login without deleting the row, since orders reference staff by id.
- `shifts` (id, opened_at, opened_by_staff_id → staff, opened_by_name, opening_float, opening_payment_id, closed_at, closed_by_staff_id → staff, closed_by_name, cash_sales, card_sales, upi_sales, order_count, expected_cash, counted_cash, notes) — cash-drawer shift/reconciliation. At most one row with `closed_at IS NULL` (enforced in `shifts:open`, app-level). `opening_payment_id` is the last `order_payments.id` that existed when the shift opened — the boundary for "this shift's sales", not a timestamp.
- `categories` (id, name, sort_order)
- `subcategories` (id, name, category_id → categories, sort_order)
- `menu_items` (id, name, price, category_id, subcategory_id, is_available, hsn_code, gst_rate, stock_quantity, created_at) — `stock_quantity` is nullable: NULL means untracked (every item's default, behaves exactly as before this column existed). A real number makes `is_available` self-managed — `adjustStock()` in `main.js` decrements it when an order line is added and restores it when removed/qty-reduced/the order is cancelled, flipping `is_available` at the zero boundary each time. `menu:updateStock` is the dedicated action that sets it (or clears back to untracked); `menu:add`/`menu:update` don't touch it. Because availability is self-managed once tracked, `menu:toggleAvailability` refuses stock-tracked items (throws — use `menu:updateStock` instead) so a manual flip can't be silently reverted by the next order that touches the item's stock.
- `restaurant_tables` (id, name, seats, sort_order)
- `orders` (id, order_type, table_label, table_id → restaurant_tables, source, status, subtotal, tax_percent, tax_amount, discount, total, payment_mode, invoice_number, created_at, paid_at, created_by_staff_id → staff, created_by_name, closed_by_staff_id → staff, closed_by_name, customer_phone, customer_name) — `created_by_name`/`closed_by_name` are snapshots (same reasoning as `order_items.item_name`) so attribution survives a staff account being deleted. `customer_phone`/`customer_name` are optional, set at checkout (`billing:finalize`) — no separate customers table; `customers:lookup` just matches on `customer_phone` across past orders.
- `order_items` (id, order_id → orders, menu_item_id → menu_items, item_name, unit_price, quantity, notes, hsn_code, gst_rate, tax_amount, kot_fired_at) — `item_name`/`hsn_code` are snapshots at add-time, deliberately not live joins, so order history survives later menu edits. `unit_price` already includes any selected modifiers' price deltas (folded in at add-time). `kot_fired_at` (nullable) marks whether/when this line was sent to the kitchen — NULL means not yet fired. In `printer_mode: 'dialog'`, marking is a two-step handshake: `receipt:printKot` returns the candidate `itemIds` without marking them, and only `receipt:confirmKotPrinted` (called by the renderer after its own `window.print()` returns) actually sets `kot_fired_at` — so a cancelled print dialog leaves the items resendable instead of silently marking them fired. `system`/`network` modes mark fired immediately inside `receipt:printKot` itself, since those already perform real I/O before returning.
- `order_payments` (id, order_id → orders, mode, amount, created_at) — one row per tender on a paid order (one row for a single-mode payment, 2+ for a split payment). Source of truth for the payment breakdown; `orders.payment_mode` is kept only as a single-value display shorthand (NULL for a genuine split).
- `modifier_groups` (id, menu_item_id → menu_items, name, min_select, max_select, sort_order) — a configurable option group on a menu item (e.g. "Size", "Toppings"). 1/1 = required single choice, 0/1 = optional single choice, 0/N = optional multi-select.
- `modifier_options` (id, group_id → modifier_groups, name, price_delta, sort_order) — one selectable option within a group, with its price adjustment.
- `order_item_modifiers` (id, order_item_id → order_items, name, price_delta) — snapshot of which modifier options were picked on an order line, for display (ticket/receipt/KOT) only — not read by any total/tax calculation, since `order_items.unit_price` already has the deltas folded in.
- `settings` (key, value) — flat key/value store, see Settings keys below

`orders.status` is one of `open | paid | cancelled` (schema CHECK). All
money mutation (add/remove item, qty change, discount edit) funnels
through `recalcOrder()` in `main.js` (~line 121), which also clamps
discount to `[0, subtotal + tax]`. The same four mutation points
(`addOrderItem`, `updateOrderItemQty`, `removeOrderItem`, `orders:cancel`)
also call `adjustStock()` for any line whose menu item is stock-tracked —
consuming stock when a line is added/increased, restoring it when
removed/decreased/the order is cancelled. `billing:finalize` does not
touch stock — it was already deducted at add-time, and a paid order's
items are never edited afterward.

## Views (`src/renderer.js` `VIEWS` array / `src/index.html` `#view-*`)

`order`, `tables`, `orders`, `reports`, `menu`, `settings` — switched via
`switchToView()`, tab buttons carry `data-view="<name>"`, each view's root
element is `#view-<name>` toggled with the `.hidden` class.

`#auth-screen` (`src/index.html`) sits outside `#app` and covers the whole
window until `staff:login`/`staff:createFirstOwner` succeeds — see
`initAuth()`/`onLoggedIn()` in `renderer.js`.

Take Order's context row has two mutually-exclusive table fields, toggled by
`updateTableFieldVisibility()` on `order-type` change: `#table-select`
(dine-in — a real `restaurant_tables` id, wired the same way as tapping a
tile on the Tables tab, so occupancy tracking works) and `#table-label`
(takeaway/delivery — free text, no table link). `resetTableFields()` clears
both wherever an order concludes.

## Settings keys (`settings:get` / `settings:update`, see `SETTINGS_FIELDS` map in `main.js` ~line 1522)

`defaultTaxPercent`, `businessName`, `businessAddress`, `businessPhone`,
`gstin`, `fssaiNo`, `invoicePrefix`, `upiId`, `footerNote`,
`zomatoRestaurantId`, `printerMode` (`dialog | system | network`),
`printerSystemName`, `printerNetworkHost`, `printerNetworkPort`,
`printerPaperWidth`, `kotPrinterMode` (`'' | dialog | system | network`),
`kotPrinterSystemName`, `kotPrinterNetworkHost`, `kotPrinterNetworkPort`,
`kotPrinterPaperWidth`, `mobileServerEnabled`, `mobileServerPort`.

## Printer (`printer/escpos.js` + `main.js` `printBufferToNetworkPrinter`)

Two independent printer roles, same three `printerMode`s each: `dialog`
(OS print dialog via Electron), `system` (named OS printer, see
`printers:listSystem`), `network` (raw ESC/POS bytes over TCP to
`<host>:<port>`). `getPrinterSettings()` is the **receipt** printer (bills,
used by `printReceipt()`); `getKotPrinterSettings()` is the **KOT**
printer (kitchen tickets, used by `printKot()`) — its `kotPrinterMode`
empty/unset means "same printer as receipts" (`getKotPrinterSettings()`
falls back to `getPrinterSettings()` in that case), so every existing
install keeps working unchanged until an owner explicitly configures a
separate kitchen printer in Settings. `receipt:testPrintKot` exercises the
KOT path the same way `receipt:testPrint` exercises the receipt path.
`escpos.js` has no Electron/DB dependency — see the `test-backend-logic`
skill for testing it standalone.

## Mobile ordering server (`main.js`, "Mobile ordering server" section near the end)

A plain `http` server, in the same process, gated by `mobileServerEnabled`
(default off) and bound to `0.0.0.0:mobileServerPort` so phones/tablets on
the same LAN can reach it — started/restarted by `syncMobileServer()` (at
app boot and at the end of every `settings:update`), stopped by
`stopMobileServer()` on `window-all-closed`. Serves the static client in
`src/mobile/` (`index.html`/`mobile.css`/`app.js`, no build step) plus a
JSON API under `/api/mobile/*` (`MOBILE_ROUTES` in `main.js`), authenticated
per-device via `Authorization: Bearer <token>` looked up in the `sessions`
map (see Access control above) — `POST /api/mobile/login` (PIN, via
`findStaffByPin`) is the only unauthenticated route.

Scope is deliberately narrow: dine-in orders tied to a table, plus firing
KOT — no billing/payment, discounts, takeaway/delivery, or settings/reports/
staff admin (those routes simply don't exist here). Routes call the same
extracted core functions the desktop IPC handlers use (`createOrder`,
`addOrderItem`, `updateOrderItemQty`, `removeOrderItem`, `fireKot`,
`listOpenTables`, `listOpenOrders`, `getOrderDetail`, `listMenu`,
`listModifierGroups`), so money/tax/modifier/table-locking logic is
identical, not reimplemented. `POST /api/mobile/orders/:id/fire-kot`
rejects with 409 when the *effective* KOT printer mode
(`getKotPrinterSettings().mode`, see the Printer section below) is
`dialog`, since that mode only works via the desktop renderer's own
`window.print()` — there is no equivalent on a phone.

`mobile:getServerInfo` (IPC) returns `{enabled, port, lanIp, url,
qrDataUrl}` for the Settings screen's "Mobile ordering" section — `lanIp`
via `os.networkInterfaces()` (first non-internal IPv4), `qrDataUrl` via the
same `qrcode` package already used for the UPI receipt QR.

## Backups (`main.js`, "Database backups" section near the top)

`backupDatabase()` uses `better-sqlite3`'s own `db.backup(destPath)` (SQLite's
online-backup API) rather than copying the `.db` file directly — the live DB
runs in WAL mode (`db.pragma('journal_mode = WAL')` in `db/db.js`), so a raw
file copy can miss recent commits still sitting in the `-wal` file. Backups
land in a `backups/` folder next to the live database (`path.dirname(db.name)`
— `db.name` is the exact path `db.js` opened, so this doesn't re-derive
`dataDir`), named `restaurant_pos-<ISO timestamp>.db`; `pruneOldBackups()`
keeps only the newest `BACKUP_RETENTION_COUNT` (30) afterward, one shared pool
across every trigger. Triggered automatically at app startup and at the end of
`shifts:close`, plus on demand via `backup:create` (Settings screen's "Back up
now" button) — all three are fire-and-forget (`.catch(console.error)` on the
two automatic ones) so a backup failure never blocks the app opening or a
shift closing. `backup:list` feeds the "Last backup: ..." line in Settings.
Restoring is manual/undocumented-in-app by design: stop the app, copy a
backup file over `restaurant_pos.db`, restart — an automated restore risks
picking the wrong file while the app is still writing.

## Design tokens (`src/style.css` `:root`)

Color/font CSS variables: `--ink`, `--ink-soft`, `--paper`, `--paper-dim`,
`--line`, `--line-on-paper`, `--copper`, `--copper-deep`, `--sage`,
`--brick`, `--text-on-ink`, `--text-on-ink-dim`, `--text-on-paper`,
`--text-on-paper-dim`, `--font-display`, `--font-body`, `--font-mono`.
