---
name: feature-scaffolding
description: Add a new entity, screen, or action following this repo's actual end-to-end pattern (schema.sql → main.js handler → preload.js bridge → renderer.js state/render/listener → style.css). Use when introducing something new rather than editing an existing feature.
---

There's no framework here generating boilerplate — every feature is the
same five-file pattern, done by hand, consistently. Follow it rather than
inventing a new shape; `categories`/`subcategories` (the smallest complete
example) or `tables` are good ones to copy from.

## The pattern

1. **Schema** (`db/schema.sql`) — `CREATE TABLE IF NOT EXISTS`, add
   `CHECK` constraints for enums/ranges the way `orders.status` and
   `menu_items.price` do. This file re-runs on every app start, so any
   `INSERT` must be idempotent (`ON CONFLICT ... DO NOTHING`, or a
   `WHERE NOT EXISTS` guard like the starter menu items). Add an index in
   this file only if the table is new; for a column added to an
   *existing* table, see `db/db.js`'s backfill pattern instead (schema.sql's
   `CREATE TABLE IF NOT EXISTS` is a no-op against a table that already
   exists without the column).

2. **Main-process handler** (`main.js`) — one `ipcMain.handle('ns:action',
   (_e, payload) => { ... })` per operation. Always:
   - use parameterized `db.prepare(...).run(...)/.get(...)/.all(...)` —
     never string-concatenate user input into SQL
   - validate/coerce input and `throw new Error('...')` on bad input
     (the renderer catches this and shows it via `alert()`)
   - if the change affects an order's totals, call `recalcOrder(orderId)`
     before returning, same as `orders:addItem`/`updateItemQty`/`removeItem`
   - return the updated row(s) via `RETURNING *` or a follow-up `SELECT`,
     matching existing handlers, so the renderer doesn't need a second
     round-trip

3. **Preload bridge** (`preload.js`) — add one method under the matching
   namespace in `contextBridge.exposeInMainWorld('pos', {...})`:
   `action: (payload) => ipcRenderer.invoke('ns:action', payload)`. This
   is the *only* path from renderer to main — never reach for
   `require('electron')` or `ipcRenderer` directly inside `renderer.js`.

4. **Renderer wiring** (`src/renderer.js`) — add module-level state if the
   data needs to persist across re-renders (see the `let categories = []`
   block at the top), a `render*()` function that rebuilds the relevant
   DOM subtree from state, and `addEventListener` calls wired to
   `window.pos.ns.action(...)`. Wrap the async call in `try/catch` and
   `alert(err.message)` on failure, matching every existing handler (e.g.
   the `delete-category` handler at ~line 74). Use `escapeHtml()` (bottom
   of `renderer.js`) on any user-supplied string before it goes into
   `innerHTML`.

5. **Markup + styling** (`src/index.html`, `src/style.css`) — add the DOM
   structure a new `render*()` targets, and style it with the existing CSS
   custom properties (`--ink`, `--copper`, `--paper`, etc. — see
   `PROJECT-STATE.md`) rather than introducing new hard-coded colors. See
   the `css-first-ui` skill for show/hide and state-toggle conventions.

Update `PROJECT-STATE.md` (see the `project-memory` skill) once the
channel/table/view exists.
