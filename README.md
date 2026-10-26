# Chores – synced household chores (core version)

A small, mobile-first web app for the apartment chore schedule. It uses exactly the same rules as
`Apartment_Tasks.xlsx` (Saturday snapping, calendar months, planned/stagger dates, Admin on Monday,
seasons, the 300-minute weekend cap) – tested against the workbook recalculated by LibreOffice.

* **This weekend** – laundry routine at the top, then the capped list (Safety → Hygiene → Nice-to-have),
  planned catch-up/one-offs, Monday admin, carry over. Tap ✓ = done today; long-press or ⋯ = pick a date; Undo.
* **All tasks** – grouped by room or priority, filter All / To do / Done; **+ Add task**, ⚙ settings; retired tasks at the bottom.
* **Task sheet** – tap a task's name anywhere: room, frequency, effort, priority, season, next due, last few completions,
  *How to* notes, supplies; **✓ Done today**, **Not this weekend** (snooze), **✎ Edit** (add / edit / retire via the *Active* toggle).
* **Away mode** – ⚙ (header button or All tasks) → *Away* from–to. Banner *Away dd/mm–dd/mm – tasks shifted* with Delete.
* **You'll need** – collapsible line on This weekend: unique supplies of the capped + planned tasks.
* **Catch-up** – Fri 23 – Tue 27 Oct with ticks (hidden two weeks after the catch-up).
* Add to home screen (PWA). No build step: plain HTML/CSS/JS.

### v12
* **Weekend planner**: after the Safety → Hygiene → Nice-to-have fill, smaller tasks that still fit go into the leftover minutes,
  and a task due two or more weekends ago (its 3rd weekend on the list) moves up right after Safety (`thisWeekend`, `AGED_DAYS`;
  `{ strict: true }` = the original workbook rule, still tested against the workbook). The CLI uses the same code.
* **Sign-in with a code**: after *Send sign-in email* a code field appears (`verifyOtp` type `email`); the link still works.
  For the code to be in the email, the Supabase *Magic Link* template must include `{{ .Token }}` – see
  `supabase/email_template_magic_link.html`. With a link-only template the app works exactly as before (use the link).
* **Paused / unreachable database**: friendly message with a link to the Supabase project and **Retry** (loads time out after 15 s).
* **Offline**: the last loaded data is kept per user in localStorage and shown straight away (*updating…* in the header) while the
  app refreshes; supabase-js is vendored (`vendor/supabase.js`) and cached by the service worker, so the app opens offline.
  Ticks and edits while offline show an error instead of seeming to save (no offline queue).
* **Backup**: Settings → *Download backup* saves `chores-backup-YYYY-MM-DD.json` (tasks, completions, away periods, catch-up items,
  settings). Keep it private – never commit it (this repo is public).
  *Restore* (not built in): in a new/empty project run `supabase/schema.sql` (+ migrations), then insert the rows with the service
  key, parents first – `tasks`, then `completions`, `catchup_items`, `away_periods`, `settings` – e.g.
  `POST /rest/v1/<table>` with `Prefer: resolution=merge-duplicates` (upsert on `id`), setting `owner_id` to the signed-in user's id.
* This weekend: *Planned* and *Carry over* are collapsed (heading, count, minutes); the open/closed state is remembered.
* Contrast: grey text ≥ 5:1, grey chips ≥ 5.7:1, empty tick border ≥ 3.4:1; small rows ≥ 44 px.

## Files
| Path | What |
|---|---|
| `index.html`, `styles.css`, `src/app.js` | the app (screens, tap/long-press/undo) |
| `src/schedule.js` | pure scheduling rules (port of the workbook formulas) |
| `src/data.js` | data layer: `MockBackend` (localStorage, seeded from `data/seed.json`) and `SupabaseBackend` (supabase-js via CDN, magic link) |
| `config.js` | Supabase URL + anon key (placeholders = local mock) |
| `manifest.webmanifest`, `sw.js`, `icons/` | PWA |
| `supabase/schema.sql` | tables `tasks`, `completions`, `catchup_items`, `settings`, `away_periods` + row-level security (fresh installs) |
| `supabase/migrations/002_features.sql` | v7 upgrade for an existing database: `tasks.snooze_until`, `tasks.supplies`, `away_periods`, supplies for obvious tasks (idempotent) |
| `supabase/seed.sql`, `data/seed.json` | your 123 tasks, Done log and catch-up plan (generated) |
| `scripts/export_seed.py` | regenerate the seed from the workbook |
| `scripts/make_truth.py` | LibreOffice ground truth for the tests |
| `scripts/assistant_cli/cli.mjs` | helper for the assistant (REST + service key, or a mock file) |
| `tests/` | `node --test tests/` (schedule parity, planner, snooze/away, CLI), `tests/smoke_features.py` (mock) + `tests/smoke_supabase.py` (fake Supabase: code sign-in, cache, paused, offline, backup) |
| `vendor/supabase.js` | supabase-js 2.118.0 UMD build (MIT), served from the app so it works offline |
| `review/` | workload proposal + simulation (`node review/proposal.mjs snapshot.json`) |

## Run locally
```bash
python3 -m http.server 8080      # then open http://localhost:8080/
# handy: ?today=2026-11-06 simulates a date; the "Mock data" button resets the local data
node --test tests/               # schedule parity (8 scenarios x 123 tasks) + CLI tests
python3 scripts/make_truth.py    # re-create ground truth after changing the workbook (needs LibreOffice)
```

## Deploy (about 20 minutes, free tiers)
### 1. Supabase (database + login)
1. Sign up at <https://supabase.com> → **New project** (region: *West EU (Ireland)*). Save the database password somewhere safe.
2. **SQL Editor → New query**: paste all of `supabase/schema.sql` → **Run**.
3. **Authentication → Sign In / Providers → Email**: make sure Email is enabled (magic link is on by default).
   Optional: turn off "Allow new users to sign up" *after* you have signed in once, so nobody else can create an account.
4. **Authentication → URL Configuration**: set **Site URL** to your Pages address, e.g. `https://YOUR-GITHUB-NAME.github.io/chores/`,
   and add the same URL (plus `http://localhost:8080/` for testing) under **Redirect URLs**.
5. **Project Settings → API**: copy the **Project URL** and the **anon / public** key into `config.js`.
   (The `service_role` key is for the assistant only – never put it in `config.js` or the repo.)

### 2. GitHub Pages (hosting)
1. Create a GitHub account if needed → **New repository** `chores` (Public is required for free Pages; your data lives in Supabase, not in the repo).
2. Upload the contents of this folder (or `git init && git add . && git commit -m "chores app" && git push`).
   `data/seed.json` only feeds the local mock – delete it before pushing if you'd rather not publish your task list (the app works without it in Supabase mode).
3. Repo **Settings → Pages** → Source *Deploy from a branch*, branch `main`, folder `/ (root)` → Save. Wait a minute for the URL.

### 3. First sign-in and load your tasks
1. Open the Pages URL on your phone → enter your email → open the magic link **on the phone**.
2. In Supabase **SQL Editor**, open `supabase/seed.sql`, replace `YOUR_EMAIL` with the address you just used → **Run**.
3. Reload the app: your 123 tasks appear. **Share → Add to Home Screen** (iPhone Safari) or **⋮ → Install app** (Android Chrome).

### Upgrading an existing database to v7
In Supabase **SQL Editor → New query**: paste all of `supabase/migrations/002_features.sql` → **Run** (safe to run twice).
Until it is run the app still works: away dates count as none, and saving snooze/supplies says it needs the update.

### 4. Let the assistant read/write (optional)
Give the assistant the Project URL and the `service_role` key as environment variables (not in chat history if you can avoid it):
```bash
export SUPABASE_URL=https://xxxx.supabase.co SUPABASE_SERVICE_KEY=...   # service key bypasses RLS
node scripts/assistant_cli/cli.mjs weekend            # what's on this weekend
node scripts/assistant_cli/cli.mjs done "hood" "kitchen mop floor" --date 2026-10-24
node scripts/assistant_cli/cli.mjs undo "hood"
node scripts/assistant_cli/cli.mjs snooze "hood"          # not this weekend (or --date YYYY-MM-DD -> that week's Saturday); unsnooze "hood"
node scripts/assistant_cli/cli.mjs away add 2026-12-19 2027-01-03    # away list | away rm ID
node scripts/assistant_cli/cli.mjs export chores.xlsx
# offline / testing: add --mock /tmp/chores.json instead of the env vars
```

## How the rules work (same as the workbook)
* **Next due** = Last done (latest of typed Last done and completions) + interval (days for daily/weekly/fortnightly,
  calendar months for monthly and longer), moved to the nearest Saturday – but never back onto/before the day it was done.
* **Planned date** is used only while a task has never been done. **Stagger date** replaces one occurrence and switches itself
  off once you've done the task near it. **Due weekday** (Admin = Mon) replaces Saturday and keeps it outside the cap.
* **Seasons**: fixed Saturdays (clocks-back in October, clocks-forward in March, 1st/2nd Saturday of April, 1st/3rd of September);
  *Apr–Sep only* tasks are *Paused (winter)* October–March and come back on the first Saturday of April.
* **Status**: Overdue / Due today / Due by Sunday / OK / Paused (winter) / Daily habit.
* **This weekend**: everything due by Sunday. Weekly laundry = *Routine* and Admin = *Weekday*, both outside the cap; planned (never-done)
  tasks are listed separately; the rest fill 300 minutes in priority order, the remainder is *Carry over*.

## Added in v7 (not in the workbook – only active when set, so parity is unchanged)
* **Not this weekend** (`tasks.snooze_until`): while today < snooze date, Next due = the later of the normal date and the snooze
  date, so the task is never *Overdue* and drops out of this weekend (its minutes free up the cap for carry-over). On the snooze
  Saturday it is back with its real status and competes in the cap as usual. Marking it done (app or assistant) clears the snooze.
* **Away mode** (`away_periods`): a Next due that falls inside an away period which started after the task was last done moves later
  by the trip length (end − start + 1 days), snaps to Saturday (or its due weekday) and always lands after the trip. Tasks already
  due/overdue before you leave are not moved – they are the backlog you left. Several trips apply in date order. Daily habits are
  never shifted. Snooze is applied after away mode.
* **Supplies** (`tasks.supplies`, comma-separated): shown in the task sheet, on This weekend (*You'll need*) and in `cli.mjs weekend`.

## v13 – optional "took __ min"
- After a tick, the toast offers **Took __ min?** (number + Save; placeholder = current estimate; stays up while you type). Ignoring it is fine.
- Saving sets the task's estimate to the average of its last 3 logged times (rounded to 5 min; under 5 kept exact). Toast says "Estimate now X min" with Undo (reverts both).
- Task sheet → Last done shows "Sat 17 Oct · 20 min"; tap **+ time / edit** to add or change minutes on a past tick.
- CLI: `done <task> --min N`.
- Needs `supabase/migrations/003_minutes.sql` (adds nullable `completions.minutes`, 0–600). Until it's applied the input is hidden and ticks work as before.

## v14 – All tasks: most urgent first inside each group
- **By room**, **By priority** and **By time** now list the tasks inside each group by status: Overdue → Due today → Due by Sunday →
  OK → No date → Daily habit → snoozed (*Not this weekend*) / Paused (winter). Same status: earliest due date first, then the usual
  order (`sort_key`). `byStatus` / `statusRank` in `src/schedule.js`; test `tests/status_order.test.js`.
- Group order is unchanged, and so is the **Done** tab's order.
