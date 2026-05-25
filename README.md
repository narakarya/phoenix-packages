# Phoenix Package Manager — Porta Extension

View, update, and **diagnose** Mix dependency conflicts for Phoenix/Elixir apps,
straight from Porta.

## Install

In Porta: **Settings → Extensions → Install from GitHub**, then paste this repo
(`owner/repo`). Activates on apps detected as `phoenix` or `elixir`.

Or **Install from folder…** and select this directory.

## Features

- Lists Mix dependencies via `mix hex.outdated`, with current/latest/constraint
  and update type (patch/minor/major).
- One-click **Update** (with review gate for major bumps) and **Bump** (edits the
  `mix.exs` constraint, then `mix deps.update`).
- **Conflict diagnostics** — when a dep can't reach its latest version, it reads
  the target release's requirements (Hex API), cross-references the locked
  sub-dep versions in `mix.lock`, and finds which installed package pins the
  blocker below the needed range. Each pinner is classified **fixable**
  (its latest release relaxes the constraint) or **hard-blocked**, and offers a
  combined "Update together" when resolvable.
- Hex diff preview, release links, and package metadata inline.

## Files

- `porta.json` — extension manifest
- `index.html` — self-contained UI + logic (runs in Porta's sandboxed iframe via `window.__portaBridge`)
