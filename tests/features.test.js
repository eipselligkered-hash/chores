// v7 features: snooze ('Not this weekend') and away mode. They only change anything when set, so parity tests are unaffected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { computeTask, computeAll, thisWeekend, nextWeekendSat, saturdayOnOrAfter, uniqueSupplies, applyAway, toDay } from '../src/schedule.js';
import { startFake } from './fake_postgrest.mjs';

const root = new URL('..', import.meta.url).pathname;
const seed = JSON.parse(fs.readFileSync(root + 'data/seed.json'));
const T = (o) => ({ id: o.name, room: 'Test', frequency: 'Weekly', interval_days: 7, interval_months: 0, priority: 'Hygiene', effort_min: 30, ...o });
const due = (t, today, opts, comps = []) => computeTask(t, comps, today, opts);
const byName = (n, room) => seed.tasks.find((t) => t.name === n && (!room || t.room === room));

test('helpers: next weekend Saturday, Saturday on/after, unique supplies', () => {
  assert.equal(nextWeekendSat('2026-10-21'), '2026-10-31');   // Wed -> not the coming Sat 24 but Sat 31
  assert.equal(nextWeekendSat('2026-10-24'), '2026-10-31');   // Sat -> next Sat
  assert.equal(nextWeekendSat('2026-10-25'), '2026-10-31');   // Sun -> next Sat
  assert.equal(saturdayOnOrAfter('2026-10-27'), '2026-10-31'); assert.equal(saturdayOnOrAfter('2026-10-31'), '2026-10-31');
  assert.deepEqual(uniqueSupplies([{ supplies: 'Descaler, cloths' }, { supplies: 'cloths; Mould spray' }, {}]), ['Descaler', 'cloths', 'Mould spray']);
});

test('snooze: pushes to next weekend, not overdue, clears itself once the date arrives', () => {
  const t = T({ name: 'weekly', last_done: '2026-10-10' });                       // normal next due Sat 17/10
  assert.equal(due(t, '2026-10-21').status, 'Overdue');
  const s = { ...t, snooze_until: '2026-10-31' };
  const r = due(s, '2026-10-21');
  assert.equal(r.next_due, '2026-10-31'); assert.equal(r.status, 'OK'); assert.equal(r.snoozed_until, '2026-10-31'); assert.equal(r.due_before, '2026-10-17');
  assert.equal(thisWeekend([s], [], '2026-10-21').rows.length, 0);              // gone from this weekend
  assert.equal(thisWeekend([s], [], '2026-10-21', { weekEnd: '2026-11-01' }).rows.length, 1);   // on next weekend
  const back = due(s, '2026-10-31');                                             // the Saturday itself: back to normal
  assert.equal(back.next_due, '2026-10-17'); assert.equal(back.status, 'Overdue'); assert.equal(back.snoozed_until, null);
  // a later normal due date wins (max), daily habits ignore it
  assert.equal(due({ ...T({ name: 'm', frequency: 'Monthly', interval_days: 30, interval_months: 1, last_done: '2026-10-17' }), snooze_until: '2026-10-31' }, '2026-10-21').next_due, '2026-11-14');
  assert.equal(due({ ...T({ name: 'd', frequency: 'Daily', interval_days: 1, last_done: '2026-10-20' }), snooze_until: '2026-10-31' }, '2026-10-21').next_due, '2026-10-21');
  // done + snooze cleared (what the app and CLI do) -> normal schedule from the completion
  assert.equal(due(t, '2026-10-22', {}, [{ task_id: t.id, done_on: '2026-10-22' }]).next_due, '2026-10-31');
});

test('snooze on the real data keeps the rest of the weekend intact', () => {
  const tasks = seed.tasks.map((t) => (t.name === 'Clean hood above stove' ? { ...t, snooze_until: '2026-10-31' } : t));
  const a = thisWeekend(seed.tasks, seed.completions, '2026-10-21'), b = thisWeekend(tasks, seed.completions, '2026-10-21');
  assert.equal(b.rows.length, a.rows.length - 1);
  assert.ok(!b.rows.some((r) => r.task.name === 'Clean hood above stove'));
});

test('away: tasks due during the trip move by its length and snap to Saturday', () => {
  const away = [{ start_date: '2026-10-08', end_date: '2026-10-21' }];           // 14 days
  const w = T({ name: 'w', last_done: '2026-10-03' });                           // due Sat 10/10 (inside)
  const r = due(w, '2026-10-22', { away });
  assert.equal(r.next_due, '2026-10-24'); assert.equal(r.status, 'Due by Sunday'); assert.equal(r.away_shifted, true); assert.equal(r.due_before, '2026-10-10');
  assert.equal(due(w, '2026-10-22').status, 'Overdue');                           // without away mode: a pile
  // already overdue before leaving -> not moved: still overdue when back (the same backlog)
  const o = due(T({ name: 'o', last_done: '2026-09-05' }), '2026-10-22', { away });
  assert.equal(o.next_due, '2026-09-12'); assert.equal(o.status, 'Overdue'); assert.equal(o.away_shifted, false);
  // done after the trip started -> no shift; due after the trip -> no shift; daily habits untouched
  assert.equal(due(T({ name: 'x', last_done: '2026-10-10' }), '2026-10-22', { away }).next_due, '2026-10-17');
  assert.equal(due(T({ name: 'y', frequency: 'Monthly', interval_days: 30, interval_months: 1, last_done: '2026-10-03' }), '2026-10-22', { away }).next_due, '2026-10-31');
  const d = due(T({ name: 'd', frequency: 'Daily', interval_days: 1, last_done: '2026-10-07' }), '2026-10-22', { away });
  assert.equal(d.next_due, '2026-10-08'); assert.equal(d.status, 'Daily habit');
  // a date inside the trip always lands after it (Sat 10/10 + 2 days snaps back to Sat 10/10 -> next Sat)
  assert.equal(applyAway(T({}), toDay('2026-10-10'), toDay('2026-10-03'), [{ start_date: '2026-10-10', end_date: '2026-10-11' }]), toDay('2026-10-17'));
  // two trips stack; Admin keeps its Monday
  const two = [{ start_date: '2026-10-08', end_date: '2026-10-14' }, { start_date: '2026-10-15', end_date: '2026-10-21' }];
  assert.equal(due(w, '2026-10-22', { away: two }).next_due, '2026-10-24');
  const admin = byName('Admin: bills, filing papers & inbox zero');
  const ad = due({ ...admin, last_done: '2026-10-12' }, '2026-10-22', { away: [{ start_date: '2026-10-15', end_date: '2026-10-25' }] });
  assert.equal(ad.next_due, '2026-11-02');   // Mon 19/10 + 11 days = Fri 30/10 -> nearest Monday (3 days on) = Mon 02/11
});

test('away on the real data: come back to the backlog you left, not a pile', () => {
  const away = [{ start_date: '2026-10-26', end_date: '2026-11-08' }];           // two weeks right after the catch-up
  const comps = seed.completions;
  const before = thisWeekend(seed.tasks, comps, '2026-10-21', { cap: 300 });     // weekend before leaving
  const plain = thisWeekend(seed.tasks, comps, '2026-11-11', { cap: 300 });      // back, without away mode
  const shifted = thisWeekend(seed.tasks, comps, '2026-11-11', { cap: 300, away });
  assert.ok(shifted.rows.length < plain.rows.length, `${shifted.rows.length} < ${plain.rows.length}`);
  const ids = new Set(shifted.rows.map((r) => r.task.id));
  for (const r of before.rows) assert.ok(ids.has(r.task.id), `${r.task.name} still waiting`);   // nothing silently dropped
  const daily = computeAll(seed.tasks, comps, '2026-11-11', { away }).filter((r) => r.task.frequency === 'Daily');
  assert.ok(daily.every((r) => !r.away_shifted && r.status === 'Daily habit'));
  // parity guard: empty away list = identical results
  assert.deepEqual(computeAll(seed.tasks, comps, '2026-11-11', { away: [] }).map((r) => r.next_due), computeAll(seed.tasks, comps, '2026-11-11').map((r) => r.next_due));
});

test('seed has supplies for the obvious tasks', () => {
  assert.match(byName('Descale kettle & coffee maker').supplies, /citric acid/);
  assert.match(byName('Air purifiers (x2): replace U97 H-Trifilter (HEPA H13 + carbon)').supplies, /35602347/);
  assert.ok(seed.tasks.every((t) => 'supplies' in t && t.snooze_until === null));
  const mig = fs.readFileSync(root + 'supabase/migrations/002_features.sql', 'utf8');
  for (const t of seed.tasks.filter((t) => t.supplies)) assert.ok(mig.includes(`name = '${t.name.replace(/'/g, "''")}'`), t.name);
});

const cli = (args, env = {}) => execFileSync('node', [root + 'scripts/assistant_cli/cli.mjs', ...args], { env: { ...process.env, ...env }, encoding: 'utf8' });

test('CLI (mock file): weekend shows supplies, snooze/unsnooze, done clears snooze, away add/list/rm', () => {
  const file = os.tmpdir() + `/chores_feat_${process.pid}.json`; fs.rmSync(file, { force: true });
  const M = ['--mock', file, '--today', '2026-11-06'];
  const w = JSON.parse(cli(['weekend', '--json', ...M]));
  assert.ok(w.supplies.includes('Degreaser') || w.supplies.length > 0); assert.ok('supplies' in w.rows[0]); assert.deepEqual(w.away, []);
  assert.match(cli(['weekend', ...M]), /You'll need: /);
  assert.match(cli(['snooze', 'hood', ...M]), /snoozed Kitchen: Clean hood above stove to Sat 14\/11/);
  const w2 = JSON.parse(cli(['weekend', '--json', ...M]));
  assert.ok(!w2.rows.some((r) => r.name === 'Clean hood above stove')); assert.equal(w2.snoozed[0].name, 'Clean hood above stove');
  assert.match(cli(['weekend', '--next', ...M]), /Clean hood above stove.*snoozed to Sat 14\/11/);
  assert.match(cli(['done', 'hood', ...M]), /done Fri 06\/11/);
  assert.equal(JSON.parse(fs.readFileSync(file)).tasks.find((t) => t.name === 'Clean hood above stove').snooze_until, null);
  assert.match(cli(['snooze', 'extinguisher', '--date', '2026-11-18', ...M]), /to Sat 21\/11/);
  assert.match(cli(['unsnooze', 'extinguisher', ...M]), /unsnoozed/);
  const n0 = JSON.parse(cli(['weekend', '--json', '--next', ...M]));
  assert.match(cli(['away', 'add', '2026-11-09', '2026-11-22', ...M]), /away Mon 09\/11 – Sun 22\/11 added/);
  const l = JSON.parse(cli(['away', 'list', '--json', ...M])); assert.equal(l.length, 1);
  const n = JSON.parse(cli(['weekend', '--json', '--next', ...M]));
  assert.ok(n.rows.length < n0.rows.length, `away empties the weekend inside the trip (${n.rows.length} < ${n0.rows.length})`);
  const was = new Set(n0.rows.map((r) => r.room + r.name));
  assert.ok(n.rows.every((r) => was.has(r.room + r.name)), 'nothing new piles in');
  assert.ok(n.rows.every((r) => !r.away_shifted), 'the backlog from before the trip stays put');
  assert.ok(!n.rows.some((r) => r.next_due >= '2026-11-09'), 'tasks due inside the trip moved after it');
  assert.equal(n.away.length, 1);
  cli(['away', 'rm', l[0].id, ...M]); assert.equal(JSON.parse(cli(['away', 'list', '--json', ...M])).length, 0);
  fs.rmSync(file);
});

test('CLI (fake REST): snooze PATCHes tasks, missing away_periods table = not away', async () => {
  const OWNER = '00000000-0000-0000-0000-00000000beef';
  const db = { tasks: seed.tasks.map((t) => ({ ...t, owner_id: OWNER })), completions: [], settings: [{ owner_id: OWNER, cap_min: 300 }] };   // no away_periods (migration not applied)
  const f = await startFake(db); const env = { SUPABASE_URL: f.url, SUPABASE_SERVICE_KEY: 'test-service-key' };
  const run = (args) => new Promise((ok, ko) => import('node:child_process').then(({ execFile }) => execFile('node', [root + 'scripts/assistant_cli/cli.mjs', ...args], { env: { ...process.env, ...env } }, (e, so, se) => (e ? ko(new Error(se || e.message)) : ok(so)))));
  try {
    const w = JSON.parse(await run(['weekend', '--today', '2026-10-21', '--json'])); assert.equal(w.rows.length, 52); assert.deepEqual(w.away, []);
    await run(['snooze', 'hood', '--today', '2026-10-21']);
    assert.equal(f.db.tasks.find((t) => t.name === 'Clean hood above stove').snooze_until, '2026-10-31');
    assert.ok(f.log.some((l) => l.startsWith('PATCH /rest/v1/tasks?id=eq.')));
    assert.equal(JSON.parse(await run(['weekend', '--today', '2026-10-21', '--json'])).rows.length, 51);
    await run(['done', 'hood', '--today', '2026-10-21']);
    assert.equal(f.db.tasks.find((t) => t.name === 'Clean hood above stove').snooze_until, null);
  } finally { f.close(); }
});
