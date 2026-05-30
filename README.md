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
- **Conflict diagnostics** — when a dep can't reach its latest version, it
  diagnoses both directions:
  - *Reverse (dependents)* — finds installed packages whose own requirement on
    the dep forbids the latest release. This is the usual reason a lone
    `mix deps.update <pkg>` is a no-op (Mix won't unlock the package holding it
    back), and is exactly what the old "block is in the solver" dead-end missed.
  - *Forward (sub-deps)* — reads the target release's requirements (Hex API),
    cross-references the locked sub-dep versions in `mix.lock`, and finds which
    installed package pins a needed sub-dep below range.

  Each blocker is classified **fixable** (its latest release relaxes/drops the
  constraint) or **hard-blocked**, and offers a combined "Update together" that
  unlocks every fixable package at once when the conflict is resolvable.
- **Security audit** — flags packages with known advisories (`mix deps.audit`
  via the optional [`mix_audit`](https://hex.pm/packages/mix_audit) dep) and
  packages **retired** on Hex (`mix hex.audit`). Vulnerable deps get a top
  banner with a one-click "Update all" and sort to the top of the list; a
  `vuln`/`retired` badge appears next to the package name and in the review
  panel. (If `mix_audit` isn't installed, the advisory check is skipped
  silently — retirement still works.)
- **Update safe** — a toolbar button that updates only patch + minor releases,
  skipping major bumps, for routine no-surprise updates.
- **Unused deps** — detects entries left in `mix.lock` that nothing depends on
  (`mix deps.unlock --check-unused`) and offers a one-click prune.
- **Changelog preview** — fetches the package's `CHANGELOG.md` from its GitHub
  repo and renders just the entries between your version and the latest, inline
  in the review panel (no browser round-trip).
- **Required-by graph** — the review panel shows which installed packages pull a
  dependency in (and whether your app depends on it directly), parsed from
  `mix.lock`.
- Hex diff preview, release links, and package metadata inline.

## Updating

Porta installs an extension by fetching a **branch** zip from GitHub (tags and
releases are ignored) and replaces any installed extension with the same
`porta.json` `id`. To update:

- **From GitHub:** Settings → Extensions → **Update** (re-fetches the stored
  source ref), or re-run *Install from GitHub* with the same `owner/repo`.
- **Pin a channel** with a branch, e.g. install `owner/repo@stable` and
  fast-forward `stable` only when you cut a release.
- **Local dev:** *Install from folder* re-reads this directory each time — the
  fastest iteration loop, no push needed.

The `version` field below is metadata for display; keep `id` stable so updates
replace in place.

## Files

- `porta.json` — extension manifest
- `index.html` — self-contained UI + logic (runs in Porta's sandboxed iframe via `window.__portaBridge`)
