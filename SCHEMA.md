# Data model — Supabase `clients` table

There's no migrations folder — this table's shape is *implicit*, built up from
field references scattered across `index.html`, `dashboard.html`, and
`worker.js`. This doc is the one place that states it explicitly. If you add,
rename, or restructure a field, update this file in the same change.

## Columns

| Column | Type | Written by | Notes |
|---|---|---|---|
| `id` | text (PK) | Dashboard, on create | `slugify(name) + '-' + randomSuffix()`. This is the value in the client's URL: `/?c=<id>`. The link *is* the client's auth — there's no login. |
| `name` | text | Dashboard (create/rename); Worker sync overwrites from HubSpot ticket subject when it changes | Display name shown to the client and on the dashboard card. |
| `onboarder` | text | Dashboard | Name of the assigned specialist. Matches an entry in the dashboard's local onboarders list (`localStorage`) — not a foreign key, just a string match. |
| `hubspot_ticket_id` | text, nullable | Dashboard | Links this client to a HubSpot onboarding ticket. Must be a numeric string for the Worker's daily add-on cron to pick it up (`/^\d+$/` check in `worker.js`). |
| `stage` | text, nullable | Dashboard (`markGraduated` / `unmarkGraduated`) | Only two real values: `null` (default) or `'graduated'`. **Not** the same as "post go-live" — see `getStage()` below. |
| `floorzap_url` | text, nullable | Worker sync (from HubSpot ticket property `floorzap_url`) | Shown as the "My Floorzap" launch button on the client page. |
| `last_contact_date` | text (ISO date), nullable | Worker sync / dashboard `logContact()` | Most recent HubSpot engagement (note/call/email) on the ticket. |
| `addons` | jsonb array, nullable | Worker's daily cron (`runDailyAddonSync`), or manually via dashboard add-on modals | `[{ product: '<key>', status: '<status>' }]`. Product keys: `floorzap_payments`, `two_way_sms`, `email_marketing`, `growth_sites`, `consumer_finance`, `floorzap_accounting`, `zapAssist_ai`. **`index.html` never writes this field** — client side is read-only for add-ons (see commit `84fb205`, which removed a bug where the client page could wipe this). |
| `state` | jsonb | Both `index.html` and `dashboard.html` | See below — this is the big one. |
| `created_at` | timestamptz | Supabase default | Used for the dashboard's default sort order. |
| `updated_at` | timestamptz | App-set on every write | Not a DB trigger — every `.update()` call sets this manually. If you add a new write path, set it too or the dashboard's "last updated" context will be stale. |

## `state` (jsonb) shape

```js
{
  sys:      [0, 2, 5],   // ticked task indices — System configuration
  b2b:      [1],         // ticked task indices — B2B integration
  mig:      [4],         // ticked task indices — Data migration
  qs:       [0, 1],      // ticked task indices — Quick start training
  custom:   [{ t: "Call vendor X", d: false }],  // client's own ad-hoc tasks
  meetings: [],           // LEGACY — no longer rendered, see note below
  hs_meetings:      { checkin: { zoom: "https://...", recording: "" } },
  hs_meeting_dates: { kickoff: "1755000000000", checkin: "2026-08-20" },
  has_post_golive_meeting: true,
  ticket_stage: {               // synced by dashboard.html's syncHubSpotDates(), sourced
    id: "1101420075",           // from worker.js reading the ticket's hs_pipeline_stage.
    label: "Final Grad Prep",   // Never hardcoded — label is whatever HubSpot currently
    synced_at: "2026-08-18T18:00:00.000Z"  // calls that stage, resolved live each sync.
  },                             // Drives getStage() and isStuck() — see below.
  ghost_since: "2026-08-04",   // set by dashboard.html when an onboarder manually
                                // flags the account as gone quiet; absent/undefined
                                // when not ghosted. See "Ghost / Stuck" below.
  ghost_stage_label: "Integrations Meeting",  // snapshot of ticket_stage.label taken
                                // at the moment markGhosted() ran — see "Ghost / Stuck".
  notes: [                     // append-only log, dashboard-only — never shown to
    { text: "Waiting on their accountant to confirm QBO mapping.",
      at: "2026-08-18T18:02:00.000Z", author: "Valentin" },
    { text: "Followed up — accountant confirmed, ready for Integrations call.",
      at: "2026-08-19T14:11:00.000Z", author: "Valentin" }
  ]                            // the client or synced to HubSpot. Rendered as a
                                // chat-style log in dashboard.html — `at`/`author`
                                // are stamped automatically on send, never typed
                                // by the onboarder. LEGACY: some rows may still
                                // hold a plain string from before this was a log;
                                // getNotesList() in dashboard.html normalizes a
                                // string into a single entry with at/author null
                                // (shown as "Earlier note") so nothing is lost.
  archived_at: "2026-08-20T16:00:00.000Z"
                                // set by dashboard.html's "Archive" action;
                                // absent/undefined when not archived. Orthogonal
                                // to `stage` — an archived account keeps whatever
                                // stage it was in and returns to it on unarchive.
                                // See "Archived" below.
}
```

**Important — index numbers are durable identity, not display order.**
`sys` / `b2b` / `mig` / `qs` are arrays of *ticked index numbers*, not booleans
and not tied to visual order. `updateSection()` only counts
`STATE[sec].length` vs `TOTALS[sec]` — it doesn't care what order the DOM
renders tasks in. This means:

- You can freely reorder tasks **visually** in `index.html` without touching
  their `id="cb-<sec>-<n>"` index.
- You must **never reuse or shift** an existing index when adding/removing a
  task, or you'll silently reassign an already-ticked box to the wrong task
  for every client with in-progress state. (This is exactly how the "Import
  products to inventory" task was added at index `4` while displaying first —
  see `IDEAS.md`.)
- New tasks get the next unused index for that section, appended to
  `TOTALS.<section>` in the `<script>` block.

`meetings` is legacy — `renderMeetings()` bails out early because
`#meetings-card` no longer exists in the DOM (replaced by the HubSpot-driven
journey cards). Safe to ignore; not worth cleaning up unless you're already
touching that code.

`hs_meeting_dates` is the authoritative source for "next meeting" / status —
it's synced from the Worker's response (`data.meetings[].isoDate`), which
itself prefers the real HubSpot meeting engagement time over the (possibly
stale) ticket property.

## Derived state (not stored, computed on read)

`getStage(client)` in `dashboard.html` — driven by the live HubSpot ticket
status, not meeting-detection heuristics:
- `stage === 'graduated'` → `graduated` (manual override, still wins first)
- else `state.ticket_stage.label` is looked up in `TICKET_STAGE_BUCKET` (a
  plain object, not scattered `if`s, so a HubSpot rename is a one-line fix):
  - Discovery / Kickoff Meeting / 2-Week Meeting / Integrations Meeting /
    Final Grad Prep / New / Pending Payment → `onboarding`
  - Live/Graduated → `post_go_live`
  - OB Complete → `graduated`
- else (no `ticket_stage` synced yet, or an unrecognized/renamed label —
  degrades gracefully instead of miscategorizing) falls back to the old
  heuristic: `state.has_post_golive_meeting`, then whether the graduation
  date in `hs_meeting_dates.graduation` has passed, then `onboarding`.

Two ticket statuses aren't a Kanban stage at all — `Cancelled` and
`OB Incomplete` mean the account isn't onboarding anymore, just not via a
successful graduation. `syncHubSpotDates()` auto-sets `state.archived_at`
for these (see `TICKET_STAGE_AUTO_ARCHIVE`), the same as a manual Archive —
so all the archived behavior below applies with no special-casing. An
onboarder can still manually Unarchive if a status turns out to be wrong.

The STAGE column badge text (`getStageBadgeText()`) isn't always the bucket
name — while `onboarding`, it shows the live sub-stage (e.g. "Integrations
Meeting") since that's the useful signal during a long onboarding; once
`post_go_live` or `graduated` it shows the milestone name instead, since the
sub-stage stops mattering.

`isStuck(client)` in `dashboard.html` — `true` when
`state.ticket_stage.label === 'Stuck'`. This is a live HubSpot read, not a
computed day-count — it can appear at any point in the funnel, and clears
itself on the next sync as soon as the ticket moves off "Stuck" in HubSpot.
Nothing to manually clear on the dashboard side for this one.

`getGhostState(client)` in `dashboard.html` — a separate, purely manual flag:
- No `state.ghost_since` → not ghosted, returns `null`.
- `state.ghost_since` set → ghosted; `days` is days-since for display, and
  `stageLabel` (from `state.ghost_stage_label`) is whatever the ticket
  stage was *at the moment the onboarder flagged it* — frozen on purpose.
  HubSpot's `hs_pipeline_stage` is a single value, so once someone (or the
  onboarder) moves the ticket to "Stuck," the prior stage is gone from
  HubSpot's side; this snapshot is the only place "was at Integrations
  Meeting when they went quiet" survives. Set in `markGhosted()`, cleared
  (both `ghost_since` and `ghost_stage_label`) in `clearGhosted()` — **the
  dashboard never writes either of these to HubSpot itself**; only
  `worker.js` holds HubSpot credentials.

Ghost and Stuck are independent and can both be true at once (e.g. manually
flagged Ghosted three weeks ago, and HubSpot's ticket has since been moved
to "Stuck") — the dashboard stacks both badges when that happens.

`isArchived(client)` in `dashboard.html` — `true` when `state.archived_at` is
set (manually via Archive, or automatically per the Cancelled/OB Incomplete
sync above). Archived accounts are excluded from every filter/stat except
the dedicated "Archived" pill (most-recently-archived first). Ghost/Stuck
and attention flags are suppressed once archived — the account is done, not
in need of a nudge. Toggled via the row menu's "Archive" / "Unarchive"
actions (`archiveClient` / `unarchiveClient`), which only set/delete
`state.archived_at` — nothing else about the row changes, so unarchiving
returns it to whatever `stage` it was already in.

So a client's Kanban column is a mix of one stored override (`stage`), a
live HubSpot read (`state.ticket_stage`), and a meeting-based fallback for
clients that predate the sync or have an unrecognized ticket status — there's
no single "status" column to query directly.
