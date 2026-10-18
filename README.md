# Chores – synced household chores (core version)

A small, mobile-first web app for the apartment chore schedule. It uses exactly the same rules as
`Apartment_Tasks.xlsx` (Saturday snapping, calendar months, planned/stagger dates, Admin on Monday,
seasons, the 300-minute weekend cap) – tested against the workbook recalculated by LibreOffice.

* **This weekend** – laundry routine at the top, then the capped list (Safety → Hygiene → Nice-to-have),
  planned catch-up/one-offs, Monday admin, carry over. Tap ✓ = done today; long-press or ⋯ = pick a date; Undo.
* **All tasks** – grouped by room with status and priority chips (read-only for now).
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
| `supabase/schema.sql` | tables `tasks`, `completions`, `catchup_items`, `settings` + row-level security |
| `supabase/seed.sql`, `data/seed.json` | your 123 tasks, Done log and catch-up plan (generated) |
| `scripts/export_seed.py` | regenerate the seed from the workbook |
| `scripts/make_truth.py` | LibreOffice ground truth for the tests |
| `scripts/assistant_cli/cli.mjs` | helper for the assistant (REST + service key, or a mock file) |
| `tests/` | `node --test tests/` (schedule parity + CLI), `tests/smoke_ui.py` (headless browser) |

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

### 4. Let the assistant read/write (optional)
Give the assistant the Project URL and the `service_role` key as environment variables (not in chat history if you can avoid it):
```bash
export SUPABASE_URL=https://xxxx.supabase.co SUPABASE_SERVICE_KEY=...   # service key bypasses RLS
node scripts/assistant_cli/cli.mjs weekend            # what's on this weekend
node scripts/assistant_cli/cli.mjs done "hood" "kitchen mop floor" --date 2026-10-24
node scripts/assistant_cli/cli.mjs undo "hood"
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
