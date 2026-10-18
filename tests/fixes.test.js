// v9 fixes: ticking with an earlier date takes effect, repeated ticks don't duplicate, CLI date checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { planDone, computeTask } from '../src/schedule.js';

const root = new URL('..', import.meta.url).pathname;
const T = { id: 'iron', room: 'Laundry', name: 'Ironing', frequency: 'Weekly', interval_days: 7, interval_months: 0, last_done: '2026-10-17' };
const apply = (t, comps, d) => {   // what markDone does with the plan
  const p = planDone(t, comps, d); if (p.duplicate) return { t, comps, p };
  const ids = new Set(p.later.map((c) => c.id));
  return { p, t: p.last_done !== undefined ? { ...t, last_done: p.last_done } : t, comps: [...comps.filter((c) => !ids.has(c.id)), { id: 'new', task_id: t.id, done_on: d }] };
};

test('tick with an earlier date than the typed Last done replaces it (live case: Ironing 10/10 vs 17/10)', () => {
  assert.equal(computeTask(T, [{ task_id: 'iron', done_on: '2026-10-10' }], '2026-10-18').next_due, '2026-10-24');   // the old bug: no effect
  const r = apply(T, [], '2026-10-10');
  assert.equal(r.p.last_done, '2026-10-10'); assert.equal(r.p.replaces, '2026-10-17');
  assert.equal(computeTask(r.t, r.comps, '2026-10-18').next_due, '2026-10-17');
  assert.equal(computeTask(r.t, r.comps, '2026-10-18').status, 'Overdue');
});

test('tick with an earlier date than a later tick removes the later tick', () => {
  const comps = [{ id: 'a', task_id: 'iron', done_on: '2026-10-18' }, { id: 'b', task_id: 'iron', done_on: '2026-10-03' }, { id: 'x', task_id: 'other', done_on: '2026-10-18' }];
  const p = planDone(T, comps, '2026-10-12');
  assert.deepEqual(p.later.map((c) => c.id), ['a']); assert.equal(p.replaces, '2026-10-18'); assert.equal(p.last_done, '2026-10-12');
  const r = apply(T, comps, '2026-10-12');
  assert.equal(computeTask(r.t, r.comps, '2026-10-18').last_effective, '2026-10-12');
  assert.ok(r.comps.some((c) => c.id === 'x'), 'other tasks untouched');
});

test('normal tick (today, latest) changes nothing else; same day twice is a duplicate', () => {
  const p = planDone(T, [], '2026-10-18');
  assert.deepEqual(p, { duplicate: false, exists: false, later: [], last_done: undefined, replaces: null });
  assert.equal(planDone(T, [{ id: 'a', task_id: 'iron', done_on: '2026-10-18' }], '2026-10-18').duplicate, true);
  assert.equal(planDone({ ...T, last_done: null }, [], '2026-10-01').replaces, null);
});

test('re-ticking a date that already has a tick but was overridden still takes effect (live: Ironing tick 10/10, Last done 17/10)', () => {
  const comps = [{ id: 'old', task_id: 'iron', done_on: '2026-10-10' }];
  const p = planDone(T, comps, '2026-10-10');
  assert.equal(p.duplicate, false); assert.equal(p.exists, true); assert.equal(p.last_done, '2026-10-10'); assert.equal(p.replaces, '2026-10-17');
  assert.equal(computeTask({ ...T, last_done: p.last_done }, comps, '2026-10-18').next_due, '2026-10-17');
});

test('CLI: done twice on the same day adds one completion; future/bad --date refused; earlier date warns', () => {
  const file = os.tmpdir() + `/chores_fix_${process.pid}.json`; fs.rmSync(file, { force: true });
  const cli = (args) => { try { return execFileSync('node', [root + 'scripts/assistant_cli/cli.mjs', ...args, '--mock', file, '--today', '2026-11-06'], { encoding: 'utf8', stdio: 'pipe' }); } catch (e) { return 'EXIT ' + e.status + ' ' + e.stderr; } };
  cli(['done', 'hood']); assert.match(cli(['done', 'hood']), /already marked done Fri 06\/11/);
  const n = () => JSON.parse(fs.readFileSync(file)).completions.filter((c) => c.done_on === '2026-11-06').length;
  assert.equal(n(), 1);
  assert.match(cli(['done', 'hood', '--date', '2026-11-07']), /EXIT 1 .*future/);
  assert.match(cli(['done', 'hood', '--date', 'friday']), /EXIT 1 .*YYYY-MM-DD/);
  assert.match(cli(['done', 'hood', '--date', '2026-11-01', '--dry-run']), /was last done Fri 06\/11/);
  fs.rmSync(file);
});
