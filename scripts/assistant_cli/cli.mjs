#!/usr/bin/env node
// Assistant helper: read/write the chores data via the Supabase REST API (PostgREST) or a local mock file.
//
//   node scripts/assistant_cli/cli.mjs weekend [--next] [--today YYYY-MM-DD] [--json]
//   node scripts/assistant_cli/cli.mjs tasks   [--due] [--json]
//   node scripts/assistant_cli/cli.mjs done "hood" "kitchen: mop floor" [--date YYYY-MM-DD] [--dry-run]
//   node scripts/assistant_cli/cli.mjs undo "hood"                     (removes the latest completion for that task)
//   node scripts/assistant_cli/cli.mjs export out.xlsx                  (needs python3 + openpyxl)
//
// Backend: SUPABASE_URL + SUPABASE_SERVICE_KEY env vars -> REST (service key bypasses RLS: keep it secret, never in the web app).
//          --mock FILE (or CHORES_MOCK=FILE) -> local JSON file, created from data/seed.json if missing.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { computeAll, thisWeekend, weekEndFor, addDays, fmtDate } from '../../src/schedule.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); if (i < 0) return false; argv.splice(i, 1); return true; };
const opt = (n) => { const i = argv.indexOf(n); if (i < 0) return null; const v = argv[i + 1]; argv.splice(i, 2); return v; };

export class RestStore {
  constructor(url, key) { this.base = url.replace(/\/$/, '') + '/rest/v1'; this.h = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }; }
  async req(method, p, body, prefer) {
    const r = await fetch(this.base + p, { method, headers: { ...this.h, ...(prefer ? { Prefer: prefer } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${await r.text()}`);
    return r.status === 204 ? null : r.json();
  }
  async load() {
    const [tasks, completions, settings] = await Promise.all([
      this.req('GET', '/tasks?select=*&active=eq.true&order=sort_key.asc'),
      this.req('GET', '/completions?select=id,task_id,done_on,note,source,created_at&order=done_on.asc'),
      this.req('GET', '/settings?select=cap_min,owner_id'),
    ]);
    return { tasks, completions, cap: settings[0]?.cap_min || 300 };
  }
  async addCompletion(task, done_on, note) {
    const [c] = await this.req('POST', '/completions', { owner_id: task.owner_id, task_id: task.id, done_on, note, source: 'assistant' }, 'return=representation');
    return c;
  }
  async removeCompletion(id) { await this.req('DELETE', `/completions?id=eq.${encodeURIComponent(id)}`); }
}

export class FileStore {
  constructor(file) { this.file = file; }
  read() {
    if (!fs.existsSync(this.file)) { const s = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/seed.json'))); fs.writeFileSync(this.file, JSON.stringify({ tasks: s.tasks, completions: s.completions, cap: s.cap_min }, null, 1)); }
    return JSON.parse(fs.readFileSync(this.file));
  }
  async load() { return this.read(); }
  async addCompletion(task, done_on, note) {
    const db = this.read(); const c = { id: `cli-${Date.now()}-${db.completions.length}`, task_id: task.id, done_on, note, source: 'assistant', created_at: new Date().toISOString() };
    db.completions.push(c); fs.writeFileSync(this.file, JSON.stringify(db, null, 1)); return c;
  }
  async removeCompletion(id) { const db = this.read(); db.completions = db.completions.filter((c) => c.id !== id); fs.writeFileSync(this.file, JSON.stringify(db, null, 1)); }
}

// fuzzy task matching: exact "room: name" / name, then all-words match (prefer tasks due by the weekend), then bigram similarity
const norm = (s) => s.toLowerCase().replace(/organize/g, 'organise').replace(/[^a-z0-9&/ ]+/g, ' ').replace(/\s+/g, ' ').trim();
const bigrams = (s) => { const b = new Map(); for (let i = 0; i < s.length - 1; i++) { const k = s.slice(i, i + 2); b.set(k, (b.get(k) || 0) + 1); } return b; };
const dice = (a, b) => { const A = bigrams(a), B = bigrams(b); let n = 0; for (const [k, v] of A) n += Math.min(v, B.get(k) || 0); return (2 * n) / Math.max(1, a.length + b.length - 2); };
export function matchTask(q, tasks, dueIds = new Set()) {
  const nq = norm(q), full = (t) => norm(`${t.room} ${t.name}`);
  let c = tasks.filter((t) => norm(t.name) === nq || full(t) === nq || norm(`${t.room}: ${t.name}`) === nq);
  if (c.length === 1) return { task: c[0], how: 'exact' };
  const words = nq.split(' ').filter(Boolean);
  c = tasks.filter((t) => words.every((w) => full(t).includes(w)));
  if (c.length === 1) return { task: c[0], how: 'words' };
  if (c.length > 1) { const d = c.filter((t) => dueIds.has(t.id)); if (d.length === 1) return { task: d[0], how: 'words, due this weekend' }; return { candidates: c }; }
  const s = tasks.map((t) => ({ t, s: Math.max(dice(nq, norm(t.name)), dice(nq, full(t))) })).sort((a, b) => b.s - a.s);
  if (s[0] && s[0].s >= 0.55 && (!s[1] || s[0].s - s[1].s >= 0.08)) return { task: s[0].t, how: `similar (${s[0].s.toFixed(2)})` };
  return { candidates: s.slice(0, 5).map((x) => x.t) };
}

const line = (r) => `${r.task.priority === 'Safety' ? '⚠ ' : '  '}${r.task.room}: ${r.task.name} · ${r.task.effort_min ?? '?'} min · ${r.task.priority} · ${r.status} ${fmtDate(r.next_due)}`;

export async function main(args = argv) {
  const mock = opt('--mock') || process.env.CHORES_MOCK;
  const today = opt('--today') || new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Dublin' });
  const date = opt('--date'); const json = flag('--json'), next = flag('--next'), dry = flag('--dry-run'), dueOnly = flag('--due');
  const [cmd, ...rest] = args;
  const store = mock ? new FileStore(mock) : (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
    ? new RestStore(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY) : null;
  if (!store || !cmd) { console.error('usage: cli.mjs weekend|tasks|done|undo|export ... (set SUPABASE_URL + SUPABASE_SERVICE_KEY, or --mock FILE)'); return 1; }
  const db = await store.load();
  const weekEnd = next ? addDays(weekEndFor(today), 7) : weekEndFor(today);
  const we = thisWeekend(db.tasks, db.completions, today, { cap: db.cap || 300, weekEnd });
  if (cmd === 'weekend') {
    if (json) { console.log(JSON.stringify({ week_end: we.week_end, cap: we.cap, totals: we.totals, rows: we.rows.map((r) => ({ room: r.task.room, name: r.task.name, priority: r.task.priority, effort_min: r.task.effort_min, next_due: r.next_due, status: r.status, bucket: r.bucket, plan: r.weekend_plan })) }, null, 1)); return 0; }
    console.log(`Weekend ending ${fmtDate(we.week_end, { long: true })} – ${we.totals.weekend}/${we.cap} min in the cap, carry over ${we.totals.carry} min`);
    for (const b of ['Routine', 'This weekend', 'Planned', 'Weekday', 'Carry over']) {
      const rs = we.rows.filter((r) => r.bucket === b); if (!rs.length) continue;
      console.log(`\n${b} (${rs.length})`); rs.forEach((r) => console.log(line(r)));
    }
    return 0;
  }
  if (cmd === 'tasks') {
    let rs = computeAll(db.tasks, db.completions, today);
    if (dueOnly) rs = rs.filter((r) => ['Overdue', 'Due today', 'Due by Sunday'].includes(r.status));
    if (json) console.log(JSON.stringify(rs.map((r) => ({ room: r.task.room, name: r.task.name, next_due: r.next_due, status: r.status, last_done: r.last_effective })), null, 1));
    else rs.forEach((r) => console.log(line(r)));
    return 0;
  }
  if (cmd === 'done' || cmd === 'undo') {
    const due = new Set(we.rows.map((r) => r.task.id)); let rc = 0;
    for (const q of rest) {
      const m = matchTask(q, db.tasks, due);
      if (!m.task) { console.log(`? "${q}" is ambiguous/unknown – did you mean:\n${m.candidates.map((t) => `   ${t.room}: ${t.name}`).join('\n')}`); rc = 2; continue; }
      const t = m.task;
      if (cmd === 'undo') {
        const c = db.completions.filter((c) => c.task_id === t.id).sort((a, b) => (a.done_on + a.created_at).localeCompare(b.done_on + b.created_at)).pop();
        if (!c) { console.log(`- ${t.room}: ${t.name} has no completions to undo`); continue; }
        if (!dry) await store.removeCompletion(c.id);
        console.log(`${dry ? '[dry-run] would undo' : '↶ undone'} ${t.room}: ${t.name} (${c.done_on})`); continue;
      }
      const d = date || today;
      if (!dry) { await store.addCompletion(t, d, null); db.completions.push({ task_id: t.id, done_on: d }); }
      const after = computeAll([t], [...db.completions, ...(dry ? [{ task_id: t.id, done_on: d }] : [])], today)[0];
      console.log(`${dry ? '[dry-run] would mark' : '✓ marked'} ${t.room}: ${t.name} done ${fmtDate(d)} (${m.how}) → next due ${fmtDate(after.next_due)}`);
    }
    return rc;
  }
  if (cmd === 'export') {
    const out = rest[0] || 'chores_export.xlsx';
    const payload = { today, tasks: computeAll(db.tasks, db.completions, today).map((r) => ({ ...r.task, next_due: r.next_due, status: r.status, last_effective: r.last_effective, plan: r.plan })),
      completions: db.completions.map((c) => ({ ...c, task: (db.tasks.find((t) => t.id === c.task_id) || {}).name, room: (db.tasks.find((t) => t.id === c.task_id) || {}).room })),
      weekend: we.rows.map((r) => ({ room: r.task.room, name: r.task.name, priority: r.task.priority, next_due: r.next_due, status: r.status, plan: r.weekend_plan, effort_min: r.task.effort_min, running: r.running, bucket: r.bucket })) };
    const p = spawnSync('python3', [path.join(ROOT, 'scripts/assistant_cli/xlsx_export.py'), out], { input: JSON.stringify(payload), encoding: 'utf8' });
    if (p.status) { console.error(p.stderr); return 1; }
    console.log(p.stdout.trim()); return 0;
  }
  console.error(`unknown command ${cmd}`); return 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) main().then((c) => process.exit(c)).catch((e) => { console.error(e.message); process.exit(1); });
