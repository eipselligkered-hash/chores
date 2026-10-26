// v14: All tasks lists each group's tasks most urgent first (byStatus).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { computeAll, byStatus, statusRank, effortBucket } from '../src/schedule.js';

const seed = JSON.parse(fs.readFileSync(new URL('../data/seed.json', import.meta.url)));
const row = (status, next_due, sort_key, extra = {}) => ({ status, next_due, snoozed_until: null, task: { sort_key }, ...extra });

test('status order, then next due, then sort_key', () => {
  const rows = [
    row('Due by Sunday', '2026-10-31', 2), row('Overdue', '2026-10-24', 5), row('OK', '2026-11-07', 1),
    row('Paused (winter)', '2027-04-03', 0), row('Due today', '2026-10-26', 9), row('Overdue', '2026-10-23', 7),
    row('OK', '2026-11-14', 3, { snoozed_until: '2026-11-14' }), row('Daily habit', '2026-10-27', 4),
    row('Due by Sunday', '2026-10-31', 1), row('No date', null, 6),
  ];
  const got = rows.slice().sort(byStatus).map((r) => `${r.status}|${r.next_due}|${r.task.sort_key}${r.snoozed_until ? '|snz' : ''}`);
  assert.deepEqual(got, [
    'Overdue|2026-10-23|7', 'Overdue|2026-10-24|5', 'Due today|2026-10-26|9', 'Due by Sunday|2026-10-31|1', 'Due by Sunday|2026-10-31|2',
    'OK|2026-11-07|1', 'No date|null|6', 'Daily habit|2026-10-27|4', 'OK|2026-11-14|3|snz', 'Paused (winter)|2027-04-03|0',
  ]);
});

test('seed data: every room / priority / time group is in non-decreasing status rank', () => {
  for (const today of ['2026-10-26', '2026-11-06', '2027-01-15']) {
    const rows = computeAll(seed.tasks, seed.completions, today).sort((a, b) => a.task.sort_key - b.task.sort_key).sort(byStatus);
    for (const key of [(r) => r.task.room, (r) => r.task.priority, (r) => effortBucket(r.task.effort_min)]) {
      const groups = new Map(); for (const r of rows) { const k = key(r); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
      for (const [, rs] of groups) for (let i = 1; i < rs.length; i++) {
        const a = rs[i - 1], b = rs[i];
        assert.ok(statusRank(a) <= statusRank(b), `${a.task.name} before ${b.task.name}`);
        if (statusRank(a) === statusRank(b)) assert.ok((a.next_due || '9999') <= (b.next_due || '9999'));
      }
    }
  }
});
