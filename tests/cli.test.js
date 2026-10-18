import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { startFake } from './fake_postgrest.mjs';
import { matchTask } from '../scripts/assistant_cli/cli.mjs';

const root = new URL('..', import.meta.url).pathname;
const seed = JSON.parse(fs.readFileSync(root + 'data/seed.json'));
const OWNER = '00000000-0000-0000-0000-00000000beef';
const run = (args, env = {}) => execFileSync('node', [root + 'scripts/assistant_cli/cli.mjs', ...args], { env: { ...process.env, ...env }, encoding: 'utf8' });

test('fuzzy matching', () => {
  const m = (q) => matchTask(q, seed.tasks).task?.name;
  assert.equal(m('hood'), 'Clean hood above stove');
  assert.equal(m('Kitchen: Mop floor'), 'Mop floor');
  assert.equal(m('fire extinguisher'), 'Check fire extinguisher (gauge in green, pin & seal intact, accessible)');
  assert.equal(m('clean hod above stov'), 'Clean hood above stove');   // typo -> similarity
  assert.ok(matchTask('mop floor', seed.tasks).candidates.length > 1);  // ambiguous across rooms
});

test('CLI against a fake Supabase REST API', async () => {
  const db = { tasks: seed.tasks.map((t) => ({ ...t, owner_id: OWNER })), completions: [], settings: [{ owner_id: OWNER, cap_min: 300 }] };
  const f = await startFake(db);
  const env = { SUPABASE_URL: f.url, SUPABASE_SERVICE_KEY: 'test-service-key' };
  try {
    const w = JSON.parse(await runAsync(['weekend', '--today', '2026-10-21', '--json'], env));
    assert.equal(w.week_end, '2026-10-25'); assert.equal(w.rows.length, 52);
    const d = await runAsync(['done', 'hood', 'admin', '--today', '2026-10-23', '--date', '2026-10-23'], env);
    assert.match(d, /Clean hood above stove done Fri 23\/10/); assert.match(d, /Admin: bills/);
    assert.equal(f.db.completions.length, 2); assert.equal(f.db.completions[0].owner_id, OWNER); assert.equal(f.db.completions[0].source, 'assistant');
    const u = await runAsync(['undo', 'hood', '--today', '2026-10-23'], env);
    assert.match(u, /undone/); assert.equal(f.db.completions.length, 1);
    assert.ok(f.log.some((l) => l.startsWith('GET /rest/v1/tasks?select=*&active=eq.true')));
    const x = os.tmpdir() + '/chores_cli_export.xlsx';
    assert.match(await runAsync(['export', x, '--today', '2026-10-23'], env), /exported 123 tasks, 1 completions/);
    assert.ok(fs.statSync(x).size > 5000);
  } finally { f.close(); }
});

test('CLI against the local mock file', () => {
  const file = os.tmpdir() + `/chores_mock_${process.pid}.json`; fs.rmSync(file, { force: true });
  const o = run(['done', 'extinguisher', '--mock', file, '--today', '2026-10-23']);
  assert.match(o, /Check fire extinguisher.*done Fri 23\/10.*next due Sat 21\/11/);
  assert.equal(JSON.parse(fs.readFileSync(file)).completions.length, 1);
  fs.rmSync(file);
});

function runAsync(args, env) {
  return new Promise((ok, ko) => {
    import('node:child_process').then(({ execFile }) => execFile('node', [root + 'scripts/assistant_cli/cli.mjs', ...args], { env: { ...process.env, ...env } }, (e, so, se) => (e ? ko(new Error(se || e.message)) : ok(so))));
  });
}
