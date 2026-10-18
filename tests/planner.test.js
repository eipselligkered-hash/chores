// v12 weekend planner rule: fill leftover minutes with smaller tasks, and move long-waiting tasks up (aging).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { thisWeekend } from '../src/schedule.js';

const T = (name, o) => ({ id: name, room: 'Test', name, frequency: 'Weekly', interval_days: 7, interval_months: 0, priority: 'Hygiene', effort_min: 30, sort_key: 1, ...o });
const TODAY = '2026-11-04', WE = '2026-11-08';            // Wed; weekend Sat 07 / Sun 08
const bucket = (w) => Object.fromEntries(w.rows.map((r) => [r.task.name, r.bucket]));

test('fill: smaller tasks that still fit go in after the first overflow', () => {
  const tasks = [T('big', { effort_min: 290, last_done: '2026-10-31' }), T('mid', { priority: 'Nice-to-have', effort_min: 20, last_done: '2026-10-31' }),
    T('tiny', { priority: 'Nice-to-have', effort_min: 5, last_done: '2026-10-31', sort_key: 2 })];
  assert.deepEqual(bucket(thisWeekend(tasks, [], TODAY, { strict: true })), { big: 'This weekend', mid: 'Carry over', tiny: 'Carry over' });
  const w = thisWeekend(tasks, [], TODAY);
  assert.deepEqual(bucket(w), { big: 'This weekend', mid: 'Carry over', tiny: 'This weekend' });
  assert.equal(w.totals.weekend, 295); assert.equal(w.week_end, WE);
});

test('aging: a task due two or more weekends ago moves ahead of its band (after Safety)', () => {
  const tasks = [T('safe', { priority: 'Safety', effort_min: 10, last_done: '2026-10-31' }), T('h1', { effort_min: 200, last_done: '2026-10-31' }),
    T('h2', { effort_min: 90, last_done: '2026-10-31', sort_key: 2 }), T('old nice', { priority: 'Nice-to-have', effort_min: 30, last_done: '2026-10-10' })];  // due Sat 17/10
  assert.equal(bucket(thisWeekend(tasks, [], TODAY, { strict: true }))['old nice'], 'Carry over');
  const w = thisWeekend(tasks, [], TODAY);
  assert.deepEqual(w.rows.filter((r) => r.bucket !== 'Routine').map((r) => r.task.name), ['safe', 'old nice', 'h1', 'h2']);
  assert.deepEqual(bucket(w), { safe: 'This weekend', 'old nice': 'This weekend', h1: 'This weekend', h2: 'Carry over' });
  assert.equal(w.rows.find((r) => r.task.name === 'old nice').aged, true);
});

test('aging threshold: due last weekend is not aged, two weekends ago is; Safety/routine never "aged"', () => {
  const at = (last_done) => thisWeekend([T('x', { priority: 'Nice-to-have', last_done })], [], TODAY).rows[0];
  assert.equal(at('2026-10-24').next_due, '2026-10-31'); assert.equal(at('2026-10-24').aged, false);   // 3rd weekend? no: 2nd
  assert.equal(at('2026-10-17').next_due, '2026-10-24'); assert.equal(at('2026-10-17').aged, true);    // on the list since 24/10: 3rd weekend
  const w = thisWeekend([T('s', { priority: 'Safety', last_done: '2026-09-01' }), T('Wash', { room: 'Laundry', last_done: '2026-09-01' })], [], TODAY);
  assert.ok(w.rows.every((r) => !r.aged));
});
