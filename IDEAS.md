# Ideas & Iteration Log — Floorzap Onboarding

A running log of what's been shipped and what's been floated but not yet built,
so ideas from conversations don't get lost between sessions. Add to this as you
go — doesn't need to be formal, just enough to remember what was decided and why.

## Shipped

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
