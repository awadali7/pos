---
name: css-first-ui
description: Prefer native CSS (classes, :hover/:disabled, transitions, the .hidden toggle, CSS custom properties) over JS-computed inline styles when changing UI behavior in src/renderer.js or src/style.css. Use for show/hide, active/selected states, and any visual-only behavior.
---

This app has no CSS framework or component library — `style.css` is
hand-written and `renderer.js` manipulates plain DOM. The existing
convention is already CSS-first; match it rather than reaching for
`element.style.xxx = ...` in JS.

## Patterns already in use — follow these, don't reinvent

- **Show/hide**: toggle the `.hidden` class (`display: none !important`),
  e.g. `classList.toggle('hidden', view !== v)` in `switchToView()`. Never
  set `element.style.display` from JS.
- **Active/selected state**: toggle a state class and let CSS own the
  visual, e.g. `.tab-btn.active`, `classList.toggle('active', ...)` for
  category/subcategory chips. JS decides *which* class applies; CSS
  decides what it *looks like*.
- **Design tokens**: colors and fonts come from the `:root` custom
  properties in `style.css` (`--ink`, `--paper`, `--copper`, `--sage`,
  `--brick`, `--font-display`, `--font-body`, `--font-mono` — full list in
  `PROJECT-STATE.md`). Don't hardcode a new hex color or font-family
  inline; add/reuse a variable instead so light/dark-adjacent surfaces
  (`--ink` vs `--ink-soft`, `--paper` vs `--paper-dim`) stay consistent.
- **Danger/status styling**: use existing modifier classes (e.g.
  `.link-btn.danger`, `.status-pill`) rather than inline color overrides
  for delete buttons or availability toggles.

## When JS state is unavoidable

Some things genuinely need JS (grid contents depend on `menuItems`/
`categories` state, receipt content depends on order data) — that's fine,
but the *visual* behavior (hover, transition, disabled look) should still
be CSS driven off a class or `:disabled`/`data-*` attribute the JS sets,
not computed style values. If a change needs a new visual state, add a
class + CSS rule in `style.css` first, then toggle that class from
`renderer.js` — don't compute colors/sizes/positions in JS and assign
`.style` directly unless the value is genuinely dynamic (e.g. a
percentage width that can't be expressed as a fixed class).
