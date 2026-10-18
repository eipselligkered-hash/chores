// Workload proposal (item 1) as data + simulation. Read-only: works on a JSON snapshot, never writes to Supabase.
// usage: node review/proposal.mjs snapshot.json
import fs from 'node:fs';
import { thisWeekend, addDays, FREQUENCIES } from '../src/schedule.js';
export const CHANGES = [   // [room, name, {frequency?, effort_min?}, why]
  ['General', 'Vacuum house', { frequency: 'Fortnightly', effort_min: 40 }, 'Full vacuum every other week, alternating with the new quick vacuum'],
  ['General', 'Tidy up & quick dust', { effort_min: 20 }, '45 min a week is generous for an apartment (you tidy as you go); thorough dusting is its own task'],
  ['Kitchen', 'Clean stove top', { effort_min: 5 }, 'Still weekly; a hob wipe-down is ~5 min'],
  ['Kitchen', 'Mop floor', { effort_min: 10 }, 'Small apartment kitchen; still weekly'],
  ['Kitchen', 'Organise fridge', { frequency: 'Fortnightly' }, 'Integrated fridge, small; quarterly deep clean stays'],
  ['General', 'Clean walls (all rooms)', { frequency: 'Yearly', effort_min: 180 }, 'Spot-clean as needed; full wash once a year'],
  ['House general', 'Tidy outdoor entranceway', { frequency: 'Monthly' }, 'Shared apartment entrance needs little'],
  ['House general', 'Shake doormats', { frequency: 'Fortnightly' }, ''],
  ['Car', 'Clean inside', { frequency: 'Every 2 months' }, ''],
  ['Car', 'Wash outside', { frequency: 'Every 2 months' }, 'Irish rain does some of it'],
  ['Office', 'Dust (thorough)', { frequency: 'Every 2 months' }, 'Weekly quick dust covers the in-between'],
  ['Living/Dining', 'Dust (thorough)', { frequency: 'Every 2 months' }, ''],
  ['Bedroom', 'Dust (thorough)', { frequency: 'Every 2 months' }, ''],
  ['Kitchen', 'Organise & wipe cupboards', { frequency: 'Half-yearly' }, ''],
  ['Bedroom', 'Organise & clean closet', { frequency: 'Half-yearly' }, 'Fits the April/October clothes swap'],
  ['Kitchen', 'Organise freezer', { frequency: 'Quarterly' }, 'Integrated freezer drawer; yearly defrost/clean stays'],
  ['General', 'Vacuum cleaner: wash filter, empty & clean bin, clear brush roll', { frequency: 'Every 2 months' }, 'Fortnightly full vacuum = half the use'],
  ['Living/Dining', 'Vacuum pillows', { frequency: 'Quarterly' }, ''],
  ['Living/Dining', 'Wipe electronics', { frequency: 'Every 2 months' }, ''],
  ['Living/Dining', 'Wash chairs', { frequency: 'Half-yearly' }, ''],
  ['Entrance', 'Dust (thorough)', { frequency: 'Every 2 months' }, ''],
  ['Entrance', 'Polish shoes', { frequency: 'Half-yearly' }, ''],
  ['General', 'Clean/dust lights & remove cobwebs', { frequency: 'Half-yearly' }, ''],
  ['Kitchen', 'Descale kettle & coffee maker', { effort_min: 15 }, 'Descaler does the work while you wait'],
  ['General', 'Dust skirting boards & windowsills, wipe window frames/seals & clean trickle vents (all rooms)', { effort_min: 45 }, 'Stays quarterly (condensation/mould in Irish winters)'],
  ['General', 'Mop floors (bedroom, office, living/dining)', { frequency: 'Every 2 months' }, 'Vacuumed every week (full or quick); kitchen and bathroom floors keep their own mopping'],
  ['Balcony', 'Weed outdoor pots', { frequency: 'Monthly' }, 'Apr–Sep only'],
  ['Balcony', 'Clean garden furniture', { frequency: 'Every 2 months' }, 'Apr–Sep only'],
  ['Bathroom', 'Shower - Clean glass', { effort_min: 10 }, 'Still monthly'],
  ['Ensuite', 'Shower - Clean glass', { effort_min: 10 }, 'Still monthly'],
  ['General', 'Air purifiers (x2): vacuum filter outer mesh / pre-filter', { effort_min: 10 }, 'Still monthly'],
  ['Kitchen', 'Clean trash can', { effort_min: 10 }, 'Still monthly'],
  ['Kitchen', 'Organise & wipe drawers', { frequency: 'Half-yearly' }, ''],
  ['Living/Dining', 'Declutter/Discard', { frequency: 'Yearly' }, ''],
  ['Attic', 'Organise storage', { frequency: 'Yearly' }, ''],
  ['Storage room/closet', 'Organise storage', { frequency: 'Yearly' }, ''],
  ['General', 'Dust blinds', { frequency: 'Half-yearly' }, 'Quick dust weekly covers them lightly'],
  ['Office', 'Shred papers', { due_weekday: 'Mon' }, 'Move to Monday evening with Admin (outside the weekend cap); still monthly'],
];
export const NEW_TASKS = [
  { room: 'General', name: 'Quick vacuum (kitchen, hall, living area)', frequency: 'Fortnightly', effort_min: 15, priority: 'Hygiene', why: 'On the weeks between full vacuums' },
];
const perWeek = (t) => (t.effort_min || 0) * 7 / FREQUENCIES[t.frequency][0];
const capped = (t) => t.active !== false && t.frequency !== 'Daily' && !(t.room === 'Laundry' && t.frequency === 'Weekly') && !t.due_weekday;
export function applyProposal(tasks) {
  const out = tasks.map((t) => ({ ...t }));
  for (const [room, name, patch] of CHANGES) {
    const t = out.find((x) => x.room === room && x.name === name); if (!t) throw new Error(`not found: ${room}: ${name}`);
    Object.assign(t, patch); if (patch.frequency) [t.interval_days, t.interval_months] = FREQUENCIES[patch.frequency];
  }
  for (const n of NEW_TASKS) out.push({ id: 'new-' + n.name, ...n, interval_days: FREQUENCIES[n.frequency][0], interval_months: FREQUENCIES[n.frequency][1],
    last_done: null, planned_date: null, stagger_date: null, due_weekday: null, season: null, active: true, sort_key: 999 });
  return out;
}
export const load = (tasks, { summer = true } = {}) => tasks.filter(capped).filter((t) => summer || t.season !== 'Apr–Sep only').reduce((s, t) => s + perWeek(t), 0);
export function simulate(tasks, completions, { weeks = 26, strict = false, first = '2026-10-31', offsetNew = true } = {}) {
  let comps = completions.map((c) => ({ task_id: c.task_id, done_on: c.done_on }));
  for (const t of tasks) if (t.planned_date && !t.last_done && t.planned_date <= '2026-10-27') comps.push({ task_id: t.id, done_on: t.planned_date });
  // new quick vacuum starts a week after the full one so they alternate
  if (offsetNew) for (const t of tasks) if (String(t.id).startsWith('new-')) comps.push({ task_id: t.id, done_on: '2026-10-31' });
  const out = []; let sat = first; const streak = {}; let maxStreak = 0, maxName = '';
  for (let i = 0; i < weeks; i++) {
    const w = thisWeekend(tasks, comps, addDays(sat, -3), { cap: 300, strict });
    const carry = w.rows.filter((r) => r.bucket === 'Carry over');
    const ids = new Set(carry.map((r) => r.task.id));
    for (const id of ids) { streak[id] = (streak[id] || 0) + 1; if (streak[id] > maxStreak) { maxStreak = streak[id]; maxName = tasks.find((t) => t.id === id).name; } }
    for (const id in streak) if (!ids.has(id)) streak[id] = 0;
    out.push({ sat, inCap: w.totals.weekend, carry: w.totals.carry, nCarry: carry.length });
    for (const r of w.rows) if (r.bucket !== 'Carry over') comps.push({ task_id: r.task.id, done_on: r.task.due_weekday ? addDays(sat, 2) : sat });
    sat = addDays(sat, 7);
  }
  return { weeks: out, maxStreak, maxName };
}
if (process.argv[1] && process.argv[1].endsWith('proposal.mjs')) {
  const d = JSON.parse(fs.readFileSync(process.argv[2]));
  const tasks = d.tasks.filter((t) => t.active !== false), p = applyProposal(tasks);
  console.log('load now summer/winter', load(tasks).toFixed(0), load(tasks, { summer: false }).toFixed(0), '-> proposal', load(p).toFixed(0), load(p, { summer: false }).toFixed(0));
  for (const [room, name, patch] of CHANGES) { const a = tasks.find((x) => x.room === room && x.name === name), b = p.find((x) => x.room === room && x.name === name);
    const saved = (capped(a) ? perWeek(a) : 0) - (capped(b) ? perWeek(b) : 0);
    console.log(`| ${name} | ${room} | ${a.frequency}, ${a.effort_min} min | ${b.frequency}, ${b.effort_min} min${b.due_weekday ? ', Mon evening' : ''} | ${saved.toFixed(1)} |`); }
  for (const n of NEW_TASKS) console.log(`| ${n.name} (new) | ${n.room} | – | ${n.frequency}, ${n.effort_min} min | -${perWeek(n).toFixed(1)} |`);
  for (const [label, T, strict] of [['now, workbook rule', tasks, true], ['now, v12 rule', tasks, false], ['proposal, workbook rule', p, true], ['proposal + v12 rule', p, false]]) {
    const s = simulate(T, d.completions, { strict }); const pick = [0, 4, 8, 12, 17, 21, 25].map((i) => s.weeks[i]);
    console.log(label, pick.map((w) => `${w.sat.slice(5)}:${w.inCap}/${w.carry}(${w.nCarry})`).join(' '), `longest carry streak ${s.maxStreak}w (${s.maxName})`);
  }
}
