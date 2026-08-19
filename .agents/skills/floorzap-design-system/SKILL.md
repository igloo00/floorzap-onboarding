---
name: floorzap-design-system
description: The actual design tokens and component patterns already in use across index.html and dashboard.html — colors, type, cards, task rows, pills, and the accent-stripe convention. Load before any visual/CSS change to either page, before adding a new UI pattern, or when asked to check UI/UX consistency in this project. Takes precedence over generic design guidance (frontend-design, web-design-guidelines) for anything touching this repo's existing pages.
metadata:
  type: project
---

# Floorzap design system

This repo has no design-token file or component library — the system lives
in the CSS actually written into `index.html` (client checklist) and
`dashboard.html` (internal Kanban). This skill is that system, written
down. Reuse what's below before inventing something new; the two other
design skills installed in this project (`frontend-design`,
`web-design-guidelines`) are general-purpose and don't know any of this —
see "Using this alongside the other design skills" at the bottom.

## Color

| Token | Hex | Used for |
|---|---|---|
| Brand blue | `#116FEA` | Header background, primary accents, sticky header shadow tint |
| Action blue | `#1566C0` | Links (`.task-link`), checkbox checked state, "join meeting" buttons |
| Ink | `#111827` | Primary text |
| Muted | `#6b7280` | Secondary text (`.task-desc`, card meta) |
| Faint | `#9ca3af` | Tertiary text, placeholder-ish labels |
| Page background | `#f0f2f5` | Both pages' `body` |
| Card background | `#fff` | Cards, rows |
| Border/hairline | `#f3f4f6` / `#e5e7eb` | Row dividers, card borders |

Status/semantic colors (kept separate from the brand blue — don't reach for
`#116FEA` to mean "success" or "warning"):

| Status | Background | Foreground | Dot |
|---|---|---|---|
| Success / live / complete | `#f0fdf4` | `#16a34a` (pills) or `#059669`/`#047857` (add-on status) | `#059669` |
| In progress | `#eff6ff` / `#EFF4FE` | `#116FEA` / `#2563EB` | `#2563EB` |
| Warning / amber | `#fffbeb` | `#b45309` / `#92400e` | `#d97706` |
| Danger | — | `#dc2626` | — |
| Neutral / not started | `#F1F5F9` / `#f1f5f9` | `#64748B` / `#94a3b8` | `#94A3B8` |

Per-add-on brand colors (`ADDON_CATALOG` in both files) are the one place
arbitrary hex values are expected — each add-on (Floorzap Payments, 2-Way
SMS, etc.) owns its own color, used only as a tint (`addonTint(hex, alpha)`)
or accent stripe, never as page chrome.

## Type

`"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif` — the
only stack either page uses. No serif, no second family. Weights in
practice: 400 body, 500–600 for names/labels, 700 for titles and pills.
Sizes cluster tightly: 15px base body, 13.5–14px for names, 12–12.5px for
descriptions/meta, 10–11.5px for eyebrows/pills/badges (usually with
`letter-spacing` and `text-transform: uppercase`).

## Component patterns

- **Card** (`.card` / `.meetings-card` / `.office-table-wrap`): white
  background, rounded corners, a two-layer shadow (`0 1px Npx
  rgba(0,0,0,0.06-0.07), 0 0 0 1px rgba(0,0,0,0.05)`) that does double duty
  as both elevation and a crisp 1px edge. **Known inconsistency:** index.html
  uses 14px radius / `0 1px 4px` shadow; dashboard.html uses 12px radius /
  `0 1px 3px`. Match whichever file you're in — don't introduce a third
  value, and flag it if asked to reconcile the two.
- **Task/checklist row** (`.task` in index.html): flex row, 14px gap,
  12px/20px padding, top hairline border, `:first-child` has no border.
  Leading checkbox (20px, 6px radius) + name + description + inline text
  links. Any new row type appended to an existing task list (like the
  add-on rows) must still align its name text with these — see the
  `addon-task` padding-left comment in index.html for why that matters.
- **Pill/badge** (`.pill`, `.stage-badge`, `.addon-tag`, `.kcard-addon-pill`):
  small, fully-rounded (999px or ~20px), 3-4px vertical padding, semantic
  background+foreground pair from the status table above. Never just an
  outline — always a filled tint.
- **Accent stripe for "this is different"**: a 3px colored left border/
  inset-shadow used to flag a row as notable without changing its layout —
  `.office-row.has-alert` in dashboard.html (`box-shadow: inset 3px 0 0
  <color>`) and `.addon-task` in index.html (`border-left: 3px solid
  <color>`). This is the established pattern for "flag this row" — reach
  for it before inventing a new one (e.g. a full-color background wash,
  which was explicitly considered and rejected for the add-on rows — see
  the design iteration below).
- **Collapsible card body**: `.card-body-inner` animates `height` between
  `0` and `scrollHeight`, then snaps to `height: auto` on `transitionend` so
  it can grow/shrink freely afterward (see `toggleCard()` in index.html).
  Any code that injects content into an already-expanded card must account
  for the brief window where height is still a pinned px value, not `auto`.

## Recent design decisions worth knowing

- **Add-on rows in `index.html`** (Aug 2026): three options were mocked up
  — full-color tint wash, left accent stripe, minimal badge-only — before
  picking the accent-stripe version, explicitly *without* a leading
  dot/icon (the stripe alone was judged sufficient as the color break).
  Default to this precedent for any similar "flag this list item" need
  rather than re-proposing the tint-wash or badge-only alternatives.
- Index numbers on checklist tasks are durable identity (see root
  `CLAUDE.md`) — this is a data/behavior rule, not a visual one, but it
  constrains how new checklist-style rows can be added (append-only,
  never reindex, and rows with no checkbox — like add-ons — don't need an
  index at all).

## Using this alongside the other design skills

- **`frontend-design`** is written for greenfield/editorial work — bold,
  distinctive, "take an aesthetic risk." That's the right mode for a
  genuinely new, freestanding surface (a new marketing page, a one-off
  artifact) with no existing system to match. For anything touching
  `index.html` or `dashboard.html`, this skill's tokens/patterns win —
  reuse over reinvention, per the precedence rule both this skill and
  `frontend-design` itself already state (defer to known project context).
- **`web-design-guidelines`** is a generic accessibility/best-practices
  auditor — it fetches Vercel's public interface guidelines live and
  checks files against them. It knows nothing about this project's
  specific system, so treat its findings as generic UX/a11y suggestions to
  reconcile with the patterns above, not as overrides of them. Good to run
  periodically (e.g. after a UI change, or when asked to "audit"/"review
  UX") independent of anything in this file.
