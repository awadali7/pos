---
name: interview-first
description: Ask clarifying questions before implementing a new feature or business-rule change (order flow, discounts/tax, tables, printing, settings). Use before writing code for anything that changes money math, order status transitions, or printer/receipt behavior in this repo.
---

This app computes real bills (per-line GST, discount, totals) and drives a
physical receipt printer. A silent assumption here doesn't just render a
wrong screen — it produces a wrong invoice or a lost kitchen ticket. Before
implementing a request that touches any of the below, ask the user rather
than guessing:

- **Money/tax edge cases.** Does the change affect `recalcOrder()` or
  `lineTax()` in `main.js` (~line 47)? What should happen at zero
  quantity, a discount larger than the bill, a negative or non-numeric
  price? Discount is currently clamped to `[0, subtotal + tax]` — does
  this request change that invariant, and does the requester know that's
  the current behavior?
- **Order lifecycle.** `orders.status` is `open | paid | cancelled`
  (schema.sql CHECK). Which statuses can trigger this feature? If an order
  is linked to a `restaurant_tables` row, what happens to that table when
  the order is cancelled/paid/edited?
- **Printer behavior.** Does this touch `printerMode` (`dialog | system |
  network`, see `PROJECT-STATE.md`) or the ESC/POS buffer
  (`printer/escpos.js`)? What's the expected behavior if the printer is
  unreachable — fail loudly, or silently skip?
- **Scope.** Is this a new IPC channel (schema + `main.js` handler +
  `preload.js` bridge + `renderer.js` UI — see the `feature-scaffolding`
  skill) or a UI-only change to an existing one?
- **Reports/exports.** Does a change to order/item shape need a matching
  change in `reports:summary` or `reports:exportExcel` (main.js), or will
  it silently under/over-count?

If the answer to any of these isn't obvious from the request, ask a short,
specific question rather than picking a default — this codebase has no
spec doc to fall back on, only `main.js`'s inline comments and
`PROJECT-STATE.md`'s structural index.
