---
name: test-backend-logic
description: Test or verify main.js's IPC handler logic, db/schema.sql, or a schema migration in this repo without launching Electron. Use when asked to test, verify, or debug backend/database behavior (orders, discounts, tables, settings, printing) rather than the UI.
---

`main.js` registers `ipcMain.handle(...)` closures — it can't be
`require()`'d outside Electron (`require('electron')` returns a bare
string under plain Node, so `app`/`ipcMain`/`BrowserWindow` are all
`undefined` and the file throws immediately). And `node_modules/better-sqlite3`
is compiled against Electron's Node ABI, so `require('better-sqlite3')`
(and therefore `db/db.js`) also fails under plain `node` with a
`NODE_MODULE_VERSION` mismatch. Don't try to work around this by
rebuilding the real `node_modules` for plain Node — that breaks `npm
start`. Use an isolated scratch copy instead:

```bash
SCRATCH=/tmp/pos-test-$$   # or wherever's convenient
mkdir -p "$SCRATCH/db"
cp db/db.js db/schema.sql "$SCRATCH/db/"
cd "$SCRATCH" && npm init -y >/dev/null 2>&1 && npm install better-sqlite3 --no-audit --no-fund
```

This gives you a `better-sqlite3` built for plain Node, wired to the
real `db.js`/`schema.sql` (byte-identical to the repo's). Then in a test
script:

```js
process.env.RESTAURANT_POS_DATA_DIR = '/tmp/pos-test-data-' + Date.now(); // fresh DB each run
const db = require('/path/to/scratch/db/db.js');
```

Since `main.js`'s handlers can't be required, **replicate the exact SQL
and logic from main.js verbatim** in the test script (copy-paste the
relevant `ipcMain.handle` body) rather than re-deriving it from memory —
the goal is testing the real logic, not a guess at it. Re-copy from the
actual current `main.js` each time; it changes.

## Things that don't need the DB at all

- `printer/escpos.js` has zero Electron/DB dependencies — `require()`
  it directly from anywhere and call `buildReceiptBuffer(...)` to unit
  test ESC/POS output.
- The network print path (`printer_mode = 'network'`) can be
  integration-tested for real: spin up `net.createServer(...)` on
  `127.0.0.1` with a random port, and exercise the same socket logic
  `main.js`'s `printBufferToNetworkPrinter` uses (copy it verbatim, same
  reasoning as above) against it. This catches real bugs — e.g. a
  connection-refused case failing fast vs. hanging the full timeout.

## After testing

Clean up the scratch directory; it's not part of the repo. Re-run
`node --check <file>` on anything you edited in the real repo before
calling it done — the scratch copy only exists to exercise DB-backed
logic, not to replace basic syntax verification of the real files.
