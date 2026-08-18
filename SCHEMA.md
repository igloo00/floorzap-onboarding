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
  ghost_since: "2026-08-04",   // set by dashboard.html when an onboarder manually
                                // flags the account as gone quiet; absent/undefined
                                // when not ghosted. See "Ghost / Stuck" below.
  notes: "Waiting on their accountant to confirm QBO mapping."
         // free-text, dashboard-only. Not shown to the client, not synced to HubSpot.
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

`getStage(client)` in `dashboard.html`:
- `stage === 'graduated'` → `graduated`
- else `state.has_post_golive_meeting` → `post_go_live`
- else fallback: graduation date (from `hs_meeting_dates.graduation`) has
  passed → `post_go_live`
- else → `onboarding`

`getGhostState(client)` in `dashboard.html` — the "Ghost / Stuck" workflow:
- No `state.ghost_since` → not ghosted, returns `null`.
- `state.ghost_since` set, days-since < `GHOST_STUCK_DAYS` (14) → `ghost`
  (onboarder manually flagged the account as gone quiet).
- days-since >= `GHOST_STUCK_DAYS` → `stuck` (surfaced as a red banner
  nudging the onboarder to go update the deal/ticket stage in HubSpot by
  hand — **the dashboard never writes this to HubSpot itself**; only
  `worker.js` holds HubSpot credentials, and this flag isn't part of its
  sync). Cleared by the onboarder (via "Clear ghost status" / "Done, clear")
  once they've logged contact or updated HubSpot, which deletes
  `ghost_since` from `state`.

So a client's Kanban column is a mix of one stored flag (`stage`) and two
computed fallbacks — there's no single "status" column to query directly.
