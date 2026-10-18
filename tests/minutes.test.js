// v13 'took __ min': estimate = average of the last up to 3 logged times, nearest 5 (min 5; under 5 kept as is).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { execFile, execFileSync } from 'node:child_process';
import { effortFromLogs, loggedMinutes, validMinutes } from '../src/schedule.js';
import { startFake } from './fake_postgrest.mjs';

const root = new URL('..', import.meta.url).pathname;
const seed = JSON.parse(fs.readFileSync(root + 'data/seed.json'));

test('effortFromLogs rounding', () => {
  const cases = [[[20], 20], [[12], 10], [[13], 15], [[7], 5], [[8], 10], [[3], 3], [[2, 3], 3], [[1], 1], [[0], 0], [[30, 20, 10, 60], 20], [[600], 600], [[], null]];
  for (const [xs, want] of cases) assert.equal(effortFromLogs(xs), want, JSON.stringify(xs));
});

test('loggedMinutes: newest first, only logged ones, per task; validMinutes', () => {
  const comps = [{ task_id: 'a', done_on: '2026-10-01', minutes: 40 }, { task_id: 'a', done_on: '2026-10-15', minutes: null }, { task_id: 'a', done_on: '2026-10-10', minutes: 20 },
    { task_id: 'b', done_on: '2026-10-20', minutes: 5 }, { task_id: 'a', done_on: '2026-10-10', minutes: 25, created_at: '2026-10-10T12:00Z' }, { task_id: 'a', done_on: '2026-10-12' }];
  assert.deepEqual(loggedMinutes('a', comps), [25, 20, 40]);
  assert.deepEqual(['20', ' 7 ', '0', '600', '601', '-3', '2.5', 'abc', ''].map(validMinutes), [20, 7, 0, 600, null, null, null, null, null]);
});

const cli = (args, env = {}) => { try { return execFileSync('node', [root + 'scripts/assistant_cli/cli.mjs', ...args], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, ...env } }); } catch (e) { return 'EXIT ' + e.status + ' ' + e.stdout + e.stderr; } };

test('CLI --min (mock file): logs the time and re-estimates; works on an existing tick; rejects bad values', () => {
  const file = os.tmpdir() + `/chores_min_${process.pid}.json`; fs.rmSync(file, { force: true });
  const M = ['--mock', file, '--today', '2026-11-06'];
  const hood = () => JSON.parse(fs.readFileSync(file)).tasks.find((t) => t.name === 'Clean hood above stove');
  cli(['weekend', ...M]); assert.equal(hood().effort_min, 30);
  assert.match(cli(['done', 'hood', '--min', '12', '--date', '2026-11-01', ...M]), /took 12 min, estimate 30 → 10 min/);
  assert.equal(hood().effort_min, 10);
  assert.match(cli(['done', 'hood', '--min', '20', ...M]), /estimate 10 → 15 min/);   // avg(20, 12) = 16 -> 15
  assert.match(cli(['done', 'hood', '--min', '40', ...M]), /took 40 min · estimate 15 → 25 min/);   // same day: replaces 20 -> avg(40, 12) = 26 -> 25
  assert.equal(JSON.parse(fs.readFileSync(file)).completions.filter((c) => c.done_on === '2026-11-06').length, 1);
  assert.match(cli(['done', 'hood', '--min', '700', ...M]), /EXIT 1 .*0-600/);
  assert.match(cli(['done', 'hood', '--min', '9', '--dry-run', '--date', '2026-11-02', ...M]), /estimate would be/);
  assert.equal(hood().effort_min, 25);
  fs.rmSync(file);
});

const run = (args, env) => new Promise((ok, ko) => execFile('node', [root + 'scripts/assistant_cli/cli.mjs', ...args], { env: { ...process.env, ...env } }, (e, so, se) => (e ? ko(new Error(se || e.message)) : ok(so))));
const OWNER = '00000000-0000-0000-0000-00000000beef';
for (const noMinutes of [false, true]) {
  test(`CLI --min (fake REST, ${noMinutes ? 'before' : 'after'} migration 003)`, async () => {
    const db = { tasks: seed.tasks.map((t) => ({ ...t, owner_id: OWNER })), completions: [], settings: [{ owner_id: OWNER, cap_min: 300 }] };
    const f = await startFake(db, 'test-service-key', { noMinutes }); const env = { SUPABASE_URL: f.url, SUPABASE_SERVICE_KEY: 'test-service-key' };
    try {
      const out = await run(['done', 'hood', '--min', '12', '--today', '2026-10-21'], env);
      const hood = f.db.tasks.find((t) => t.name === 'Clean hood above stove');
      assert.equal(f.db.completions.length, 1, 'the tick is saved either way');
      if (noMinutes) { assert.match(out, /minutes not saved: apply supabase\/migrations\/003_minutes.sql/); assert.equal(hood.effort_min, 30); assert.equal(f.db.completions[0].minutes, undefined); }
      else { assert.match(out, /estimate 30 → 10 min/); assert.equal(hood.effort_min, 10); assert.equal(f.db.completions[0].minutes, 12); }
    } finally { f.close(); }
  });
}
