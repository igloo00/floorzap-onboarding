# Ideas & Iteration Log — Floorzap Onboarding

A running log of what's been shipped and what's been floated but not yet built,
so ideas from conversations don't get lost between sessions. Add to this as you
go — doesn't need to be formal, just enough to remember what was decided and why.

## Shipped

- 2026-08-19 — Client-side add-ons overhaul:
  - Fixed the add-on status popup landing away from the clicked pill on a
    scrolled dashboard (`openAddonPopup` was double-counting scroll offset
    against a `position: fixed` element), and fixed add-on pills squishing
    into bare colored circles on a narrow dashboard window (missing
    `flex-shrink: 0`/`white-space: nowrap`) — narrow windows now cleanly
    hide the add-ons column below ~1040px instead.
  - Removed `index.html`'s "Premium Features" tab; add-ons now render
    inline as extra rows at the end of the System configuration checklist
    (left accent-stripe treatment — see `floorzap-design-system` skill for
    why that pattern over the alternatives considered).
  - **Disabled the daily HubSpot→Supabase add-on cron** (`worker.js`'s
    `runDailyAddonSync`, previously scheduled via `wrangler.jsonc`). Add-ons
    are now onboarder-managed only, through dashboard.html's "Manage
    add-ons" modal — see "Proposed / Backlog" below for the plan to bring
    HubSpot-object automation back later, and `CLAUDE.md`'s add-ons gotcha
    for exactly what got turned off and how to reverse it.
  - Added three skills to the project (`frontend-design`,
    `web-design-guidelines`, and a hand-written `floorzap-design-system`
    documenting this repo's actual tokens/patterns) to keep future UI work
    consistent with what's already here.
- 2026-08-18 — Dashboard redesign (OS side): replaced the 3-column Kanban
  board with a single sortable/filterable list (filter pills for
  All/Onboarding/Post Go-Live/Graduated/Stuck + a sort dropdown). Added a
  "Ghost" status an onboarder can set manually when an account goes quiet;
  after 14 days (`GHOST_STUCK_DAYS`) it auto-promotes to "Stuck" with a red
  banner nudging a manual HubSpot stage update (dashboard never writes to
  HubSpot itself — see SCHEMA.md "Ghost / Stuck"). Added a private
  per-account notes field (dashboard-only, not shown to the client). Also
  fixed dead code: `openManageAddonsModal`/`openAddonPopup` existed but were
  never wired to anything — the "+" add-on button and status pills are now
  clickable. Surfaced `getContactDisplay()` (last-contact age/color), which
  was fully implemented but never rendered anywhere before this.
- 2026-08-12 — Added "Import products to inventory" task to Data migration
  (client side). Self-hosts the `.xlsx` template in-repo instead of an external
  CloudFront link that was returning a 403.
- 2026-08-12 — Clarified Bank & credit accounts verbiage — QBO customers are
  told to wait for the Integrations call so account names get confirmed live
  with their specialist instead of risking a mismatch.

## Proposed / Backlog

**Client side (`index.html`)**
- Notifications/reminders — nudge when a task sits incomplete, or a meeting is
  coming up
- "Request this add-on" CTA on an add-on row instead of just read-only status
  (successor to the old "Richer Premium Features tab" idea, now that add-ons
  live in the System configuration list instead of their own tab)
- More task types in Setup/Training (e.g. a dedicated Go-Live checklist tab)

**Add-ons: re-automate from HubSpot (on hold as of 2026-08-19)**
- The daily HubSpot-deal-line-item → Supabase add-on sync
  (`runDailyAddonSync` in `worker.js`) is disabled — add-ons are
  onboarder-managed only for now (see Shipped above and `CLAUDE.md`).
- When it's time to revisit: the sync code, the "return `null` not `[]` on
  fetch failure" safety rule, and the cron wiring in `wrangler.jsonc` are
  all still there, just disconnected — this shouldn't need a rewrite, only
  re-enabling plus a decision on how manual edits and an automated sync
  should reconcile when they disagree (last-write-wins today, which is
  probably not what you want once both are live at once).
- Open question to settle before flipping it back on: should the synced
  HubSpot data be allowed to overwrite an onboarder's manual status change
  on the same add-on, or should manual edits "pin" that add-on against the
  next sync?

**OS side (`dashboard.html`)**
- Bulk actions across clients (bulk-remind, bulk-tag)
- Reporting/analytics — time-to-graduate, stuck-client alerts, add-on attach
  rate
- Log contact directly from the dashboard instead of only reading it from
  HubSpot

## Notes / Open questions

- (add anything that needs a decision before it becomes a real task)
