// Parity tests: src/schedule.js vs the workbook recalculated by LibreOffice (tests/truth/*.json, from scripts/make_truth.py).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { computeAll, thisWeekend, weekEndFor } from '../src/schedule.js';

const root = new URL('..', import.meta.url).pathname;
const seed = JSON.parse(fs.readFileSync(root + 'data/seed.json'));
const scenarios = JSON.parse(fs.readFileSync(root + 'tests/scenarios.json'));
const key = (room, name) => `${room}: ${name}`;
const byKey = Object.fromEntries(seed.tasks.map((t) => [key(t.room, t.name), t]));
let grand = { fields: 0, bad: 0 };

for (const sc of scenarios) {
  test(`parity ${sc.id} (today ${sc.today})`, () => {
    const truth = JSON.parse(fs.readFileSync(`${root}tests/truth/${sc.id}.json`));
    const comps = [...seed.completions, ...sc.log.map(([d, n]) => {
      assert.ok(byKey[n], `scenario task not found: ${n}`); return { task_id: byKey[n].id, done_on: d };
    })];
    const mine = Object.fromEntries(computeAll(seed.tasks, comps, sc.today).map((r) => [key(r.task.room, r.task.name), r]));
    const mism = [];
    assert.equal(truth.tasks.length, Object.keys(mine).length, 'task count');
    for (const t of truth.tasks) {
      const m = mine[key(t.room, t.name)];
      for (const f of ['next_due', 'status', 'last_effective', 'plan']) {
        grand.fields++;
        if ((m?.[f] ?? null) !== (t[f] ?? null)) { grand.bad++; mism.push(`${t.room}: ${t.name} ${f}: workbook=${t[f]} js=${m?.[f]}`); }
      }
    }
    assert.equal(weekEndFor(sc.today), truth.week_end, 'week end');
    const we = thisWeekend(seed.tasks, comps, sc.today, { cap: truth.cap });
    const a = we.rows.map((r) => [r.task.room, r.task.name, r.weekend_plan, r.running, r.bucket].join(' | '));
    const b = truth.weekend.map((r) => [r.room, r.name, r.plan, r.running, r.bucket].join(' | '));
    grand.fields += b.length;
    const wm = []; for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) wm.push(`#${i + 1} workbook=[${b[i]}] js=[${a[i]}]`);
    grand.bad += wm.length;
    const n = truth.tasks.length;
    console.log(`${sc.id}: tasks ${n - new Set(mism.map((x) => x.split(' next_due')[0].split(' status')[0].split(' last_effective')[0].split(' plan:')[0])).size}/${n} match, ` +
                `This Weekend rows ${b.length - wm.length}/${b.length} match`);
    assert.deepEqual(mism, [], 'task mismatches');
    assert.deepEqual(wm, [], 'This Weekend mismatches');
  });
}
test('summary', () => console.log(`TOTAL: ${grand.fields - grand.bad}/${grand.fields} compared values match (${grand.bad} mismatches)`));
