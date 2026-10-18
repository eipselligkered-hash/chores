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
| `tests/` | `node --test tests/` (schedule parity, snooze/away, CLI), `tests/smoke_ui.py` + `tests/smoke_features.py` (headless browser) |

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
