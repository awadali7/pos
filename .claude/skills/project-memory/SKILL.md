---
name: project-memory
description: Read PROJECT-STATE.md first for a fast map of IPC channels, DB tables, views, settings keys, and design tokens — then keep it current whenever a change adds, removes, or renames any of them. Use at the start of any non-trivial task and again before finishing one that touches structure.
---

`PROJECT-STATE.md` at the repo root is a generated index of this codebase's
shape — not a description of what the app does (that's `README.md`), and
not a place for prose. Read it before exploring `main.js`/`renderer.js`
cold; it's faster and less error-prone than re-deriving the IPC channel
list or schema from scratch, and other skills (`feature-scaffolding`,
`pr-review`) assume it's accurate.

## When to update it

Any change that does one of the following must update the matching section
of `PROJECT-STATE.md` in the same commit:

- Add/remove/rename an `ipcMain.handle('ns:action', ...)` in `main.js`
  (and its `preload.js` mirror) → **IPC channels** table
- Add/remove/rename a table or column in `db/schema.sql` → **Database
  tables** section
- Add/remove/rename a view in the `VIEWS` array (`renderer.js`) or its
  `#view-*` element → **Views** section
- Add/remove/rename a key in `SETTINGS_FIELDS` (`main.js`) → **Settings
  keys** section
- Change `printerMode` values or add a new print path → **Printer**
  section
- Add/remove a CSS custom property in `:root` (`src/style.css`) →
  **Design tokens** section

## How to update it

Keep entries terse — one line per item, table form where it already uses
one. Don't narrate the change or add a changelog; the file always
describes current state only, git history is the changelog. If a section
would need more than a small edit to stay accurate, regenerate it by
re-reading the relevant source file rather than patching around drift.
