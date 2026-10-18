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

/** Next due, status, plan label etc. for one task. completions: [{task_id, done_on}], today: ISO date. */
export function computeTask(task, completions, todayIso) {
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
    if (daily) T = S;
    else {                                                // snap to the target weekday (Sat unless overridden)
      const tgt = task.due_weekday && WEEKDAYS.includes(task.due_weekday) ? WEEKDAYS.indexOf(task.due_weekday) + 1 : 7;
      const fwd = mod(tgt - weekday(S), 7);
      T = (fwd <= 3 || S + fwd - 7 <= E) ? S + fwd : S + fwd - 7;   // nearest, but never back onto/before Last done
    }
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
           staggered: Lst != null && C === Lst, planned_pending: K != null && E == null };
}

export const computeAll = (tasks, completions, todayIso) =>
  tasks.filter((t) => t.active !== false).map((t) => computeTask(t, completions, todayIso));

/** This Weekend (workbook sheet): everything due on/before weekEnd (Sunday), ranked and fitted into the cap.
 *  bucket: 'Routine' (weekly laundry) | 'Weekday' (due-weekday override, e.g. Admin Mon) | 'This weekend' | 'Carry over' | 'Planned'. */
export function thisWeekend(tasks, completions, todayIso, { cap = DEFAULT_CAP, weekEnd = null } = {}) {
  const WE = toDay(weekEnd || weekEndFor(todayIso));
  const rows = [];
  for (const r of computeAll(tasks, completions, todayIso)) {
    const t = r.task, C = toDay(r.next_due);
    if (C == null || t.frequency === 'Daily' || r.status === 'Paused (winter)' || C > WE) continue;
    const routine = t.room === 'Laundry' && t.frequency === 'Weekly';
    const group = (routine || t.due_weekday) ? 0 : r.planned_pending ? 4 : (PRIORITIES.indexOf(t.priority) + 1 || 3);
    const plan = routine ? 'Routine' : t.due_weekday ? `Weekday (${t.due_weekday} evening)` : r.planned_pending ? 'Planned' : r.plan;
    rows.push({ ...r, group, C, weekend_plan: plan });
  }
  rows.sort((a, b) => a.group - b.group || a.C - b.C || (a.task.sort_key ?? 0) - (b.task.sort_key ?? 0));
  let run = 0;
  for (const r of rows) {
    const p = r.weekend_plan; const capped = !(p === 'Planned' || p === 'Routine' || p.startsWith('Weekday'));
    if (capped) run += Number(r.task.effort_min) || 0;
    r.running = run;
    r.bucket = p === 'Planned' ? 'Planned' : p === 'Routine' ? 'Routine' : p.startsWith('Weekday') ? 'Weekday' : (run <= cap ? 'This weekend' : 'Carry over');
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
