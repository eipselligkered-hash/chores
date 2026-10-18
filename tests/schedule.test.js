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
    // strict = the workbook rule, still matched exactly (proves the port); the app's v12 rule is checked below
    const we = thisWeekend(seed.tasks, comps, sc.today, { cap: truth.cap, strict: true });
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
    // v12 rule (aging + fill), against the same workbook rows
    const v = thisWeekend(seed.tasks, comps, sc.today, { cap: truth.cap });
    const k = (r) => key(r.task?.room ?? r.room, r.task?.name ?? r.name);
    assert.deepEqual(v.rows.map(k).sort(), truth.weekend.map(k).sort(), 'same tasks due');
    const wb = Object.fromEntries(truth.weekend.map((r) => [k(r), r.bucket]));
    for (const r of v.rows) if (!['This weekend', 'Carry over'].includes(wb[k(r)])) assert.equal(r.bucket, wb[k(r)], `${k(r)} keeps its uncapped bucket`);
    const eff = (r) => Number(r.task.effort_min) || 0;
    const inCap = v.rows.filter((r) => r.bucket === 'This weekend'), carry = v.rows.filter((r) => r.bucket === 'Carry over');
    const used = inCap.reduce((x, r) => x + eff(r), 0);
    assert.ok(used <= truth.cap, `in cap ${used} <= ${truth.cap}`);
    const wbUsed = truth.weekend.filter((r) => r.bucket === 'This weekend').reduce((x, r) => x + (Number(byKey[k(r)].effort_min) || 0), 0);
    assert.ok(used >= wbUsed || v.rows.some((r) => r.aged), `fill never plans less than the workbook (${used} vs ${wbUsed})`);
    for (const r of carry) assert.ok(used + eff(r) > truth.cap, `${k(r)} (${eff(r)} min) would have fitted`);
    const safety = v.rows.filter((r) => r.task.priority === 'Safety' && !r.planned_pending && wb[k(r)] === 'This weekend');
    for (const r of safety) assert.equal(r.bucket, 'This weekend', `${k(r)}: Safety stays in`);
  });
}
test('summary', () => console.log(`TOTAL: ${grand.fields - grand.bad}/${grand.fields} compared values match (${grand.bad} mismatches)`));
