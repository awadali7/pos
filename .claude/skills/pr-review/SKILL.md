---
name: pr-review
description: Review a diff to main.js, preload.js, renderer.js, or db/schema.sql against this repo's actual conventions rather than generic feedback. Use when asked to review, check, or critique a change to this codebase.
---

Check project-specific conventions before generic style nitpicks — they
catch the bugs that actually happen in this codebase.

## `main.js` (IPC handlers)

- **SQL is parameterized**, never string-built from `payload` fields. Flag
  any template-literal SQL with an interpolated variable that isn't a
  fixed column/table name.
- **Order-total invariant**: any handler that adds/removes/changes an
  `order_items` row or an order's `discount` must call `recalcOrder(orderId)`
  before returning, or totals silently go stale.
- **Discount can't push a bill negative** — `recalcOrder` clamps discount
  to `[0, subtotal + tax]`; a change that bypasses `recalcOrder` to set
  `discount`/`total` directly reopens that bug class.
- **Input validation throws `Error`**, not a silent no-op or a returned
  error object — the renderer's `catch` + `alert(err.message)` is the only
  place errors surface to the user.
- **`menu_item_id`-sourced fields (price/name/hsn/gst) come from the DB**,
  not the caller, whenever a real menu item is referenced (see
  `orders:addItem`) — a handler that trusts client-supplied price for an
  existing menu item is a pricing bug/exploit.
- **Schema changes are idempotent** — `CREATE TABLE IF NOT EXISTS`,
  `INSERT ... ON CONFLICT DO NOTHING`/`WHERE NOT EXISTS`, since
  `schema.sql` reapplies on every launch. A bare `ALTER TABLE ADD COLUMN`
  without a "does it already exist" guard breaks on the second launch of
  an already-migrated DB (see `db.js`'s backfill pattern for the right
  shape).

## `preload.js`

- Every new `main.js` channel has exactly one matching bridge method under
  the right namespace, and vice versa — an orphaned handler or a bridge
  method with no handler is a bug, not dead code to ignore.
- No `ipcRenderer`/`require('electron')` usage anywhere outside this file.

## `src/renderer.js`

- User-supplied strings go through `escapeHtml()` before landing in
  `innerHTML` (check anywhere a template literal builds markup from
  DB-returned `name`/`notes`/free-text fields).
- Async `window.pos.*` calls are wrapped in `try/catch`, failure path
  calls `alert(err.message)` — a missing catch means a rejected promise
  silently does nothing and the UI looks stuck.
- New state that must survive re-render lives in the module-level `let`
  block at the top, not recomputed ad hoc.

## General

- Flag any risky/destructive change (deleting a table, dropping data,
  `RESTAURANT_POS_DATA_DIR` handling) called out without the user's
  explicit request.
- Check whether `PROJECT-STATE.md` needs updating (new channel/table/view/
  setting key) — see the `project-memory` skill.
