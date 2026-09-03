# Restaurant POS (local desktop app)

A basic point-of-sale system for a restaurant counter: manage the menu, take
orders, and bill them out. Runs entirely on your own machine — Electron for
the app window, an embedded SQLite database for storage. No internet, no
separate database server, and no credentials to configure — the data file is
created automatically the first time the app runs.

## What's included (v1)

- **Menu management** — add, edit, delete items; toggle available/unavailable; organize by category
- **Take order** — tap items into a running ticket, adjust quantity, add a discount and tax %, dine-in/takeaway/delivery + table label
- **Table layout** — a grid of tables (add/remove your own, with optional seat counts); tap a free one to start its order, tap an occupied one to resume it, freed automatically once it's paid or cancelled
- **Billing** — charge the ticket (cash/card/UPI), see a receipt, close out the order
- **Reports** — revenue/order KPIs, top items, sales by category, date-range filtering, Excel export

Kitchen display was left out of this v1 on purpose — say the word if you want it added next.

## 1. Prerequisites

- [Node.js](https://nodejs.org) (v18 or later)

That's it — no database server to install or configure.

## 2. Install and run

```bash
cd pos-system
npm install
npm start
```

`npm install` also compiles the SQLite engine for Electron (via the `postinstall` step) — this can take a minute the first time. `npm start` then opens the Electron window straight into the **Take Order** screen. The very first launch creates the database file automatically, seeded with a few starter categories and menu items so the screen isn't empty.

### Where the data lives

By default the database file is stored at `~/.restaurant-pos/restaurant_pos.db` (i.e. `C:\Users\<you>\.restaurant-pos\restaurant_pos.db` on Windows). To use a different folder (e.g. a shared network drive), set `RESTAURANT_POS_DATA_DIR` before running `npm start`. Back up that one file to back up all of the restaurant's data.

## How it works day-to-day

- **Take Order tab**: pick order type + table, tap dishes from the menu grid on the left — they land on the ticket on the right. Adjust quantity with the +/− buttons, set a discount or tax %, then **Charge & Close Ticket** to pick a payment method and get a receipt.
- **Menu tab**: add/edit/delete items and toggle availability (unavailable items are greyed out and can't be tapped into an order).

## Project structure

```
pos-system/
  main.js          Electron main process + all database logic (IPC handlers)
  preload.js        Safe bridge exposing window.pos.* to the UI
  db/
    schema.sql       Table definitions + starter data (applied automatically on every start)
    db.js            SQLite connection + auto schema setup
  src/
    index.html        App shell (Take Order + Menu views, modals)
    style.css          Visual design
    renderer.js         UI logic, talks to main process via window.pos
```

## Giving this to someone else (Windows installer)

For a friend or another machine that shouldn't need Node.js, npm, or any
command-line steps at all — build a real Windows installer once, then just
hand them the one `.exe` file:

```bash
npm install
npm run dist
```

This produces `dist/Restaurant POS Setup 1.0.0.exe` (an NSIS installer,
~80 MB, since it bundles Electron and everything the app needs). Send that
one file to your friend — they double-click it, click through the install
wizard (it lets them pick the install folder and adds a desktop shortcut),
and the app is ready to use. No Node.js, no `npm install`, nothing else
required on their machine.

A few things worth knowing:

- **Windows SmartScreen may warn on first run** ("Windows protected your PC")
  since the installer isn't signed with a paid code-signing certificate —
  that's expected for an app shared directly rather than through an app
  store. Click **More info → Run anyway**.
- Each install gets its **own separate database** — nothing is shared
  between your machine and your friend's. See "Where the data lives" above
  for where that file ends up on each machine.
- Rebuild (`npm run dist`) any time you want to hand out a newer version;
  it overwrites the file in `dist/`.

## Building a macOS version

`better-sqlite3` (the database engine) has to be compiled on the same OS
it'll run on, so a `.dmg` can't be built from Windows — it needs to happen
on an actual Mac, or on a Mac-hosted CI runner. This repo has a GitHub
Actions workflow (`.github/workflows/build.yml`) set up for the second
option, so no Mac hardware is required:

1. Push a version tag: `git tag v1.0.0 && git push origin v1.0.0` — or
   trigger it manually from the repo's **Actions** tab → "Build installers" →
   **Run workflow** (no tag needed for a manual run).
2. GitHub builds the app on a Windows runner, an Apple Silicon Mac runner,
   and an Intel Mac runner in parallel.
3. Once it finishes, open that workflow run on GitHub — the `.exe` and both
   `.dmg` builds are attached under **Artifacts** at the bottom of the page,
   ready to download and hand out.

The Mac build isn't signed/notarized by Apple either (that needs a paid
Apple Developer account), so opening it the first time will need
**right-click → Open → Open** (or System Settings → Privacy & Security →
"Open Anyway") instead of a normal double-click, similar to the Windows
SmartScreen prompt.

## Troubleshooting

- **`npm install` fails while building `better-sqlite3`** — this step compiles a small native module against Electron and needs a C++ build toolchain the first time there's no matching prebuilt binary for your machine. On Windows, install the "Desktop development with C++" workload from [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) and re-run `npm install`.
- **Blank menu grid on first run** — shouldn't happen (starter data is seeded automatically), but if it does, close the app and delete the database file (see "Where the data lives" above) to let it recreate from scratch.
- **Electron window is blank** — open DevTools (Ctrl+Shift+I / Cmd+Opt+I) and check the console for errors.
