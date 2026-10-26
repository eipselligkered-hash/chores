// Pure scheduling rules - a line-by-line port of the formulas in Apartment_Tasks.xlsx (All Tasks + This Weekend).
// No dependencies; works in the browser and in Node. Dates are ISO strings 'YYYY-MM-DD' in and out;
// internally whole days since 1970-01-01 (UTC) so there are no time-zone/DST surprises.

export const FREQUENCIES = {   // name: [days, calendar months] (Lists!A:C)
  'Daily': [1, 0], 'Weekly': [7, 0], 'Fortnightly': [14, 0], 'Monthly': [30, 1], 'Every 2 months': [60, 2],
  'Quarterly': [91, 3], 'Half-yearly': [182, 6], 'Yearly': [365, 12],
};
export const SEASONS = {       // name: {type, month, n (Nth Saturday; 0 = Saturday before the last Sunday), start, end} (Lists!F:K)
  'Apr–Sep only': { type: 'Window', start: 4, end: 9 },
  'October: clocks-back Saturday': { type: 'Fixed', month: 10, n: 0 },
  'March: clocks-forward Saturday': { type: 'Fixed', month: 3, n: 0 },
  'April: 1st Saturday': { type: 'Fixed', month: 4, n: 1 },
  'April: 2nd Saturday': { type: 'Fixed', month: 4, n: 2 },
  'September: 1st Saturday': { type: 'Fixed', month: 9, n: 1 },
  'September: 3rd Saturday': { type: 'Fixed', month: 9, n: 3 },
};
export const PRIORITIES = ['Safety', 'Hygiene', 'Nice-to-have'];
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];   // Excel WEEKDAY order (1 = Sun)
export const DEFAULT_CAP = 300;

const DAY = 86400000;
export const toDay = (iso) => (iso ? Math.round(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / DAY) : null);
export const fromDay = (n) => (n == null ? null : new Date(n * DAY).toISOString().slice(0, 10));
const ymd = (n) => { const d = new Date(n * DAY); return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()]; };
const date = (y, m, d) => Math.round(Date.UTC(y, m - 1, d) / DAY);          // Excel DATE(): month overflow rolls the year
const weekday = (n) => new Date(n * DAY).getUTCDay() + 1;                   // Excel WEEKDAY(): Sun=1 .. Sat=7
const mod = (a, b) => ((a % b) + b) % b;
function edate(n, months) {                                                  // Excel EDATE(): clamps to month end
  const [y, m, d] = ymd(n); const t = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  return Math.round(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), Math.min(d, last)) / DAY);
}
const eomonth = (n) => { const [y, m] = ymd(n); return date(y, m + 1, 0); };
const month = (n) => ymd(n)[1];
const year = (n) => ymd(n)[0];

export function seasonRule(y, s) {           // the season's Saturday in year y
  const base = date(y, s.month, 1);
  if (s.n === 0) { const e = eomonth(base); return e - mod(weekday(e) - 1, 7) - 1; }
  return base + mod(7 - weekday(base), 7) + 7 * (s.n - 1);
}
export const sundayOffset = (today) => mod(8 - weekday(today), 7);
export const weekEndFor = (todayIso) => fromDay(toDay(todayIso) + sundayOffset(toDay(todayIso)));

/** Latest of the typed Last done and any completion for the task (workbook: 'Last done (effective)'). */
export function effectiveLast(task, completions = []) {
  let e = task.last_done ? toDay(task.last_done) : 0;
  for (const c of completions) if (c.task_id === task.id) e = Math.max(e, toDay(c.done_on));
  return e || null;
}

/** 'Took __ min': the logged minutes of a task, newest tick first. */
export const loggedMinutes = (taskId, completions) => completions
  .filter((c) => c.task_id === taskId && c.minutes != null && c.minutes !== '')
  .sort((a, b) => b.done_on.localeCompare(a.done_on) || String(b.created_at || '').localeCompare(String(a.created_at || '')))
  .map((c) => Number(c.minutes));
/** New effort estimate from logged times: average of the last up to 3, rounded to the nearest 5 (at least 5);
 *  an average under 5 is kept as is (rounded to a whole minute). null when nothing is logged. */
export function effortFromLogs(mins) {
  const xs = mins.slice(0, 3); if (!xs.length) return null;
  const avg = xs.reduce((s, x) => s + x, 0) / xs.length;
  return avg < 5 ? Math.round(avg) : Math.max(5, Math.round(avg / 5) * 5);
}
export const validMinutes = (v) => { const s = String(v ?? '').trim(); if (!/^\d{1,3}$/.test(s)) return null; const n = Number(s); return n <= 600 ? n : null; };

/** Ticking a task done on doneOn so that it actually takes effect (effective last = latest of all dates).
 *  exists: there is already a tick on doneOn (don't add another). duplicate: exists and nothing later - nothing to do.
 *  later: completions after doneOn, to remove. last_done: new typed Last done when the typed one is later than doneOn
 *  (else undefined = leave it). replaces: the effective last done that doneOn replaces (null when doneOn is the latest). */
export function planDone(task, completions, doneOn) {
  const mine = completions.filter((c) => c.task_id === task.id);
  const prev = effectiveLast(task, completions);
  const replaces = prev != null && prev > toDay(doneOn) ? fromDay(prev) : null;
  const exists = mine.some((c) => c.done_on === doneOn);
  return { duplicate: exists && !replaces, exists, later: mine.filter((c) => c.done_on > doneOn),
           last_done: task.last_done && task.last_done > doneOn ? doneOn : undefined, replaces };
}

/** Nearest target weekday (Saturday unless due_weekday overrides it), but never back onto/before Last done E. */
function snap(task, S, E) {
  const tgt = task.due_weekday && WEEKDAYS.includes(task.due_weekday) ? WEEKDAYS.indexOf(task.due_weekday) + 1 : 7;
  const fwd = mod(tgt - weekday(S), 7);
  return (fwd <= 3 || (E != null && S + fwd - 7 <= E)) ? S + fwd : S + fwd - 7;
}

/** Away mode (not in the workbook). For each away period {start_date, end_date} that started after the task was last
 *  done (or the task was never done), a next due that falls inside the period moves later by the period's length
 *  (end - start + 1 days), snaps to the target weekday again and always ends up after the period. Tasks that were
 *  already due/overdue before you left are not moved: they are the backlog you left and are still there when you're
 *  back - but nothing new piles on top. Periods are applied in date order (a shifted date can be shifted by the next
 *  trip). Daily habits are never shifted. */
export function applyAway(task, C, E, away = []) {
  if (C == null || !away.length || task.frequency === 'Daily') return C;
  const ps = away.map((a) => [toDay(a.start_date), toDay(a.end_date)]).filter(([s, e]) => s != null && e != null && e >= s).sort((a, b) => a[0] - b[0]);
  for (const [s, e] of ps) {
    if ((E != null && s <= E) || C < s || C > e) continue;
    let n = snap(task, C + (e - s + 1), E);
    if (n <= e) n += 7;
    C = n;
  }
  return C;
}

/** Next due, status, plan label etc. for one task. completions: [{task_id, done_on}], today: ISO date.
 *  opts.away: away periods [{start_date, end_date}]. task.snooze_until ('Not this weekend'): while today < snooze_until
 *  the next due is at least snooze_until. Both only change anything when set, so workbook parity is untouched. */
export function computeTask(task, completions, todayIso, { away = [] } = {}) {
  const today = toDay(todayIso);
  const [P, MO] = FREQUENCIES[task.frequency] || [task.interval_days, task.interval_months || 0];
  const daily = task.frequency === 'Daily';
  const E = effectiveLast(task, completions);
  const season = task.season ? SEASONS[task.season] : null;
  const K = toDay(task.planned_date), Lst = toDay(task.stagger_date);
  let S = null, T = null, U = null, C;
  if (E == null) C = K;                                   // never done: Planned date (or nothing)
  else {
    S = MO > 0 ? edate(E, MO) : E + P;                    // raw due: calendar months, else days
    T = daily ? S : snap(task, S, E);                     // snap to the target weekday (Sat unless overridden)
    if (season && season.type === 'Fixed') {
      const ref = E + 60; const a = seasonRule(year(ref), season);
      U = a >= ref ? a : seasonRule(year(ref) + 1, season);
    } else if (season && season.type === 'Window') {
      if (month(T) >= season.start && month(T) <= season.end) U = T;
      else { const b = date(year(T) + (month(T) > season.end ? 1 : 0), season.start, 1); U = b + mod(7 - weekday(b), 7); }
    } else U = T;
    // one-off stagger: used while not yet done near it and the normal date is within half an interval of it
    C = (Lst != null && E < Lst - P / 2 && Math.abs(U - Lst) <= P / 2) ? Lst : U;
  }
  const base = C;
  C = applyAway(task, C, E, away);
  const shifted = base != null && C !== base;
  const Z = toDay(task.snooze_until);
  const snoozed = Z != null && today < Z && task.frequency !== 'Daily';
  if (snoozed) C = C == null ? Z : Math.max(C, Z);
  const left = C == null ? null : C - today;
  const paused = !!(season && season.type === 'Window' && (month(today) < season.start || month(today) > season.end));
  let status;
  if (daily) status = 'Daily habit';
  else if (paused) status = 'Paused (winter)';
  else if (left == null) status = 'No date';
  else if (left < 0) status = 'Overdue';
  else if (left === 0) status = 'Due today';
  else if (left <= sundayOffset(today)) status = 'Due by Sunday';
  else status = 'OK';
  const pdate = toDay(task.plan_date);
  let plan = '';
  if (task.due_weekday) plan = `Weekday (${task.due_weekday} evening) - outside weekend cap`;
  else if (pdate != null && C === pdate) plan = task.plan_text || '';
  else if (Lst != null && C === Lst) plan = 'Staggered (one-off move to spread busy weekends)';
  return { id: task.id, task, next_due: fromDay(C), status, days_left: left, last_effective: fromDay(E), plan,
           staggered: Lst != null && C === Lst, planned_pending: K != null && E == null,
           snoozed_until: snoozed ? fromDay(Z) : null, away_shifted: shifted, due_before: (shifted || snoozed) ? fromDay(base) : null };
}

export const computeAll = (tasks, completions, todayIso, opts = {}) =>
  tasks.filter((t) => t.active !== false).map((t) => computeTask(t, completions, todayIso, opts));

/** All tasks 'By time' groups (effort_min), in display order. */
export const EFFORT_BUCKETS = ['Under 5 min', 'Under 10 min', '10–30 min', '30–60 min', 'Over an hour', 'No time set'];
export function effortBucket(min) {
  if (min == null || min === '' || !Number.isFinite(Number(min))) return EFFORT_BUCKETS[5];
  const m = Number(min);
  return m < 5 ? EFFORT_BUCKETS[0] : m < 10 ? EFFORT_BUCKETS[1] : m <= 30 ? EFFORT_BUCKETS[2] : m <= 60 ? EFFORT_BUCKETS[3] : EFFORT_BUCKETS[4];
}
/** Soonest next due first (overdue first), no date last, then workbook order. */
export const byNextDue = (a, b) => (a.next_due || '9999').localeCompare(b.next_due || '9999') || (a.task.sort_key ?? 0) - (b.task.sort_key ?? 0);
// v14: within an All tasks group, most urgent first: Overdue, Due today, Due by Sunday, OK, No date, Daily habit,
// then snoozed ('Not this weekend') and Paused (winter) last; same rank = earliest next due, then sort_key.
export const STATUS_RANK = { 'Overdue': 0, 'Due today': 1, 'Due by Sunday': 2, 'OK': 3, 'No date': 4, 'Daily habit': 5, 'Paused (winter)': 6 };
export const statusRank = (r) => (r.snoozed_until ? 6 : STATUS_RANK[r.status] ?? 4);
export const byStatus = (a, b) => statusRank(a) - statusRank(b) || byNextDue(a, b);

/** 'Not this weekend': the Saturday after the coming/current weekend. */
export const nextWeekendSat = (todayIso) => fromDay(toDay(weekEndFor(todayIso)) + 6);
/** Saturday on/after a date. */
export const saturdayOnOrAfter = (iso) => { const n = toDay(iso); return fromDay(n + mod(7 - weekday(n), 7)); };
/** Unique supplies (split on , or ;) of a list of tasks, first spelling wins. */
export function uniqueSupplies(tasks) {
  const seen = new Map();
  for (const t of tasks) for (const x of String(t?.supplies || '').split(/[;,]/)) { const v = x.trim(); if (v && !seen.has(v.toLowerCase())) seen.set(v.toLowerCase(), v); }
  return [...seen.values()];
}
/** Away periods that are on now or still to come. */
export const currentAway = (away = [], todayIso) => away.filter((a) => a.end_date >= todayIso).sort((a, b) => a.start_date.localeCompare(b.start_date));

/** This Weekend: everything due on/before weekEnd (Sunday), ranked and fitted into the cap.
 *  bucket: 'Routine' (weekly laundry) | 'Weekday' (due-weekday override, e.g. Admin Mon) | 'This weekend' | 'Carry over' | 'Planned'.
 *  Ranking: Safety -> Hygiene -> Nice-to-have, then due date. Two changes from the workbook (v12, opts.strict = the old rule):
 *   - aging: a capped task due two or more weekends before this one (so this is at least its 3rd weekend on the list)
 *     moves ahead of its priority band, right after Safety - so small Nice-to-have jobs can't be skipped for months;
 *   - fill: after the strict fill, smaller tasks that still fit under the cap go in too (the workbook stopped at the first overflow). */
export const AGED_DAYS = 14;
export function thisWeekend(tasks, completions, todayIso, { cap = DEFAULT_CAP, weekEnd = null, away = [], strict = false } = {}) {
  const WE = toDay(weekEnd || weekEndFor(todayIso));
  const rows = [];
  for (const r of computeAll(tasks, completions, todayIso, { away })) {
    const t = r.task, C = toDay(r.next_due);
    if (C == null || t.frequency === 'Daily' || r.status === 'Paused (winter)' || C > WE) continue;
    const routine = t.room === 'Laundry' && t.frequency === 'Weekly';
    let group = (routine || t.due_weekday) ? 0 : r.planned_pending ? 4 : (PRIORITIES.indexOf(t.priority) + 1 || 3);
    const plan = routine ? 'Routine' : t.due_weekday ? `Weekday (${t.due_weekday} evening)` : r.planned_pending ? 'Planned' : r.plan;
    const aged = !strict && group >= 2 && group <= 3 && (WE - 1) - C >= AGED_DAYS;
    if (aged) group = 1.5;
    rows.push({ ...r, group, C, weekend_plan: plan, aged });
  }
  rows.sort((a, b) => a.group - b.group || a.C - b.C || (a.task.sort_key ?? 0) - (b.task.sort_key ?? 0));
  let run = 0, used = 0;
  for (const r of rows) {
    const p = r.weekend_plan; const capped = !(p === 'Planned' || p === 'Routine' || p.startsWith('Weekday'));
    const e = Number(r.task.effort_min) || 0;
    if (capped) run += e;
    r.running = run;
    const fits = strict ? run <= cap : used + e <= cap;
    if (capped && fits) used += e;
    r.bucket = p === 'Planned' ? 'Planned' : p === 'Routine' ? 'Routine' : p.startsWith('Weekday') ? 'Weekday' : (fits ? 'This weekend' : 'Carry over');
    delete r.C;
  }
  const sum = (b) => rows.filter((r) => r.bucket === b).reduce((s, r) => s + (Number(r.task.effort_min) || 0), 0);
  return { week_end: fromDay(WE), cap, rows,
           totals: { weekend: sum('This weekend'), carry: sum('Carry over'), planned: sum('Planned'), routine: sum('Routine') + sum('Weekday') } };
}

// Display helpers (dd/mm, UK)
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtDate(iso, { long = false } = {}) {
  if (!iso) return '–';
  const n = toDay(iso); const [y, m, d] = ymd(n); const wd = WEEKDAYS[weekday(n) - 1];
  return long ? `${wd} ${d} ${MON[m - 1]} ${y}` : `${wd} ${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}`;
}
export const addDays = (iso, n) => fromDay(toDay(iso) + n);
