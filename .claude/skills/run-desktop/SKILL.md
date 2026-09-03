---
name: run-desktop
description: Launch and try out the Restaurant POS Electron desktop app. Use when asked to start the app, verify a UI change works, or troubleshoot why `npm start` won't launch.
---

Restaurant POS is a single-window Electron + better-sqlite3 desktop app
(see main.js / preload.js / src/). There is no automated GUI driver for
it yet (see Limitations) — this skill covers the human/manual launch
path and the gotchas that actually bite in this repo.

## Launch

```bash
npm install   # also runs the postinstall electron-rebuild step for better-sqlite3
npm start     # opens the real Electron window on the Take Order screen
```

For a throwaway run against a scratch database instead of the real
`~/.restaurant-pos/restaurant_pos.db` (e.g. to try something risky):

```bash
RESTAURANT_POS_DATA_DIR=/tmp/pos-scratch npm start
```

## Gotchas

- **`node_modules/electron/dist/` can be missing the actual binary**
  even though `npm install` "succeeded" — the `electron` package's own
  postinstall (which downloads the platform binary) can silently not
  run or not finish. Symptom: `npm start` / `node_modules/.bin/electron
  --version` fails with `spawn .../Electron ENOENT`. Fix:
  ```bash
  node node_modules/electron/install.js
  ```
  then re-check `ls node_modules/electron/dist/` for `Electron.app`
  (mac) or the platform equivalent.

- **`better-sqlite3`'s compiled binary is built for Electron's Node ABI,
  not the system Node.** `require('better-sqlite3')` (and therefore
  `require('./db/db')`, and therefore `main.js`) will throw a
  `NODE_MODULE_VERSION` mismatch if run under plain `node` instead of
  through Electron. This is expected — don't try to fix it by rebuilding
  the real `node_modules` for plain Node, since that would break `npm
  start` again. See the `test-backend-logic` skill for how to test
  business logic without hitting this.

## Limitations (as of this writing)

An agent's own shell in this environment cannot actually drive or
screenshot the real GUI window — even a bare `electron --version` check
hangs indefinitely (0% CPU, no output) rather than erroring, consistent
with the sandbox blocking the WindowServer connection a GUI process
needs. There's no Playwright/`_electron` driver in this repo, and
`playwright-core` isn't installed.

If you need actual automated UI verification (click a button, screenshot
a view), that requires either running outside this sandbox, or building
a Playwright `_electron` driver and running it with the sandbox
deliberately disabled — ask the user first, since it launches a real
window on their live desktop. Don't silently attempt this.
