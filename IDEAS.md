# Ideas & Iteration Log — Floorzap Onboarding

A running log of what's been shipped and what's been floated but not yet built,
so ideas from conversations don't get lost between sessions. Add to this as you
go — doesn't need to be formal, just enough to remember what was decided and why.

## Shipped

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
- Richer Premium Features tab — "request this add-on" CTA instead of
  read-only status
- More task types in Setup/Training (e.g. a dedicated Go-Live checklist tab)

**OS side (`dashboard.html`)**
- Bulk actions across clients (bulk-remind, bulk-tag)
- Reporting/analytics — time-to-graduate, stuck-client alerts, add-on attach
  rate
- Log contact directly from the dashboard instead of only reading it from
  HubSpot

## Notes / Open questions

- (add anything that needs a decision before it becomes a real task)
