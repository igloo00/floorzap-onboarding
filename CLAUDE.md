# CLAUDE.md — Floorzap Onboarding

Instructions for AI coding sessions working in this repo. Also useful for any
human picking this up cold.

## What this is

Three pieces sharing one Supabase database — see `SCHEMA.md` for the data
model:

- `index.html` — client-facing onboarding checklist. No login; the URL
  (`/?c=<client_id>`) is the auth.
- `dashboard.html` — internal Kanban dashboard for onboarding specialists.
- `worker.js` — Cloudflare Worker. The *only* thing with HubSpot credentials;
  both HTML pages call it (or Supabase directly) but never call HubSpot
  themselves. It *used to* also run a daily cron syncing add-ons from
  HubSpot deal line items into Supabase — **disabled as of 2026-08-19**, see
  the add-ons gotcha below and `IDEAS.md`. The sync code is still in
  `worker.js`, just unreachable without a `triggers.crons` entry in
  `wrangler.jsonc`.

## Deploy model — read this before pushing

This repo is Git-integrated with **Cloudflare Pages**, separately from the
Worker:

- Pushing any branch other than `main` → builds a **Preview** deployment at a
  throwaway `*.pages.dev` URL. Isolated, safe, invisible to customers.
- Pushing/merging to `main` → builds **Production** — the real site every
  customer's checklist link points to.
- `worker.js` is a *separate* deploy path (`wrangler deploy`), not tied to the
  Pages Git integration. Its secrets (`HUBSPOT_API_KEY`, `SUPABASE_URL`,
  `SUPABASE_ANON_KEY`) are set via `wrangler secret put` and are never in the
  repo. Note: `index.html`/`dashboard.html` also embed a `SUPABASE_URL` /
  `SUPABASE_ANON_KEY` pair directly in client-side JS — that's intentional
  (Supabase anon keys are meant to be public, RLS does the enforcing) and is
  a *different* pair of secrets from the Worker's, despite the similar names.

**Because of this, treat `main` as production for real customers.** Standard
flow used in this project:

```
git checkout -b <short-branch-name>
# make changes
git add -A && git commit -m "..."
git push -u origin <short-branch-name>     # → preview build, safe to check
# after review/approval:
git checkout main && git pull
git merge --ff-only <short-branch-name>
git push origin main                        # → production build, live now
git push origin --delete <short-branch-name> && git branch -d <short-branch-name>
```

Only skip the branch step if explicitly told to push straight to `main`.

## Gotchas that have already bitten this project once

- **Checklist progress is stored by index number, not display order.** See
  `SCHEMA.md` → "Index numbers are durable identity." Adding/removing a task
  in `index.html` must never reindex an existing task, or every in-progress
  client's saved checkboxes silently point at the wrong task. New tasks get
  a new, unused index — even if they display first.
- **The client-facing page must never write `addons`.** It caused data loss
  once (commit `84fb205`) — `index.html` only *reads* add-on status.
- **Add-ons are onboarder-managed only, by design, as of 2026-08-19.**
  `dashboard.html`'s "Manage add-ons" modal is currently the *only* writer of
  `clients.addons`. `worker.js` still has a HubSpot-deal-line-item sync
  (`runDailyAddonSync`) that used to run on a daily cron and write `addons`
  too, but that cron trigger was removed from `wrangler.jsonc` on purpose —
  see `IDEAS.md` for why and what bringing it back should look like. If
  you're re-enabling it: restore `"triggers": { "crons": [...] }` in
  `wrangler.jsonc`, re-read the two gotchas below (both still apply, code
  untouched), and update this note + `IDEAS.md`.
- **HubSpot fetch failures must return `null`, not `[]`, in `worker.js`'s
  add-on sync** (relevant again only once the cron above is re-enabled).
  `runDailyAddonSync` treats `null` as "unknown, skip" and `[]` as
  "confirmed empty, overwrite." Getting this backwards wipes a client's real
  add-ons on a transient API error.
- **Meeting slots only render when a real meeting exists behind them** — a
  ticket property with a date but no matching calendar engagement or Zoom
  link is intentionally hidden rather than shown as a "ghost" upcoming
  meeting. See `buildSlot()` in `worker.js`.
- **Multiple local checkouts exist on this machine.** There's at least one
  older, out-of-sync clone of this repo elsewhere on disk in addition to the
  one under active development. Before editing, confirm you're in the
  tracked repo (`git remote -v`, `git log -1`) — don't assume the first
  `floorzap-onboarding` folder found is the right one.

## Where to look for more context

- `SCHEMA.md` — the Supabase `clients` table shape.
- `IDEAS.md` — shipped changes + proposed/backlog ideas from ongoing
  collaboration, so context survives across sessions.
