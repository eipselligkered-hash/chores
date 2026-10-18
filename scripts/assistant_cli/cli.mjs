#!/usr/bin/env node
// Assistant helper: read/write the chores data via the Supabase REST API (PostgREST) or a local mock file.
//
//   node scripts/assistant_cli/cli.mjs weekend [--next] [--today YYYY-MM-DD] [--json]
//   node scripts/assistant_cli/cli.mjs tasks   [--due] [--json]
//   node scripts/assistant_cli/cli.mjs done "hood" "kitchen: mop floor" [--date YYYY-MM-DD] [--dry-run]
//   node scripts/assistant_cli/cli.mjs undo "hood"                     (removes the latest completion for that task)
//   node scripts/assistant_cli/cli.mjs snooze "hood" [--date YYYY-MM-DD] ('Not this weekend': default = next weekend's Saturday)
//   node scripts/assistant_cli/cli.mjs unsnooze "hood"
//   node scripts/assistant_cli/cli.mjs away [list] | away add FROM TO | away rm ID   (away mode: due dates move by the trip length)
//   node scripts/assistant_cli/cli.mjs export out.xlsx                  (needs python3 + openpyxl)
// Scheduling respects tasks.snooze_until and away_periods exactly like the app; 'done' also clears a snooze.
//
// Backend: SUPABASE_URL + SUPABASE_SERVICE_KEY env vars -> REST (service key bypasses RLS: keep it secret, never in the web app).
//          --mock FILE (or CHORES_MOCK=FILE) -> local JSON file, created from data/seed.json if missing.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { computeAll, thisWeekend, weekEndFor, addDays, fmtDate, nextWeekendSat, saturdayOnOrAfter, uniqueSupplies, currentAway } from '../../src/schedule.js';

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
    const [tasks, completions, settings, away] = await Promise.all([
      this.req('GET', '/tasks?select=*&active=eq.true&order=sort_key.asc'),
      this.req('GET', '/completions?select=id,task_id,done_on,note,source,created_at&order=done_on.asc'),
      this.req('GET', '/settings?select=cap_min,owner_id'),
      this.req('GET', '/away_periods?select=*&order=start_date.asc').catch(() => []),   // before migration 002: none
    ]);
    return { tasks, completions, cap: settings[0]?.cap_min || 300, away };
  }
  async updateTask(task, patch) { await this.req('PATCH', `/tasks?id=eq.${encodeURIComponent(task.id)}`, patch); }
  async addAway(owner_id, start_date, end_date) { const [a] = await this.req('POST', '/away_periods', { owner_id, start_date, end_date }, 'return=representation'); return a; }
  async removeAway(id) { await this.req('DELETE', `/away_periods?id=eq.${encodeURIComponent(id)}`); }
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
  async removeCompletion(id) { const db = this.read(); db.completions = db.completions.filter((c) => c.id !== id); this.write(db); }
  write(db) { fs.writeFileSync(this.file, JSON.stringify(db, null, 1)); }
  async updateTask(task, patch) { const db = this.read(); Object.assign(db.tasks.find((t) => t.id === task.id), patch); this.write(db); }
  async addAway(_owner, start_date, end_date) { const db = this.read(); const a = { id: `away-${Date.now()}`, start_date, end_date, created_at: new Date().toISOString() }; (db.away ||= []).push(a); this.write(db); return a; }
  async removeAway(id) { const db = this.read(); db.away = (db.away || []).filter((a) => a.id !== id); this.write(db); }
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

const line = (r) => `${r.task.priority === 'Safety' ? '⚠ ' : '  '}${r.task.room}: ${r.task.name} · ${r.task.effort_min ?? '?'} min · ${r.task.priority} · ${r.status} ${fmtDate(r.next_due)}` +
  `${r.snoozed_until ? ` · snoozed to ${fmtDate(r.snoozed_until)}` : ''}${r.away_shifted ? ` · moved from ${fmtDate(r.due_before)} (away)` : ''}${r.task.supplies ? ` · need: ${r.task.supplies}` : ''}`;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

export async function main(args = argv) {
  const mock = opt('--mock') || process.env.CHORES_MOCK;
  const today = opt('--today') || new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Dublin' });
  const date = opt('--date'); const json = flag('--json'), next = flag('--next'), dry = flag('--dry-run'), dueOnly = flag('--due');
  const [cmd, ...rest] = args;
  const store = mock ? new FileStore(mock) : (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
    ? new RestStore(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY) : null;
  if (!store || !cmd) { console.error('usage: cli.mjs weekend|tasks|done|undo|snooze|unsnooze|away|export ... (set SUPABASE_URL + SUPABASE_SERVICE_KEY, or --mock FILE)'); return 1; }
  const db = await store.load();
  db.tasks = db.tasks.filter((t) => t.active !== false); db.away ||= [];
  const away = db.away;
  const weekEnd = next ? addDays(weekEndFor(today), 7) : weekEndFor(today);
  const we = thisWeekend(db.tasks, db.completions, today, { cap: db.cap || 300, weekEnd, away });
  if (cmd === 'weekend') {
    const supplies = uniqueSupplies(we.rows.filter((r) => r.bucket === 'This weekend' || r.bucket === 'Planned').map((r) => r.task));
    const snoozed = computeAll(db.tasks, db.completions, today, { away }).filter((r) => r.snoozed_until && r.due_before && r.due_before <= we.week_end && r.snoozed_until > we.week_end);
    const awayNow = currentAway(away, today).map((a) => ({ id: a.id, start_date: a.start_date, end_date: a.end_date }));
    if (json) {
      console.log(JSON.stringify({ week_end: we.week_end, cap: we.cap, totals: we.totals, supplies, away: awayNow,
        rows: we.rows.map((r) => ({ room: r.task.room, name: r.task.name, priority: r.task.priority, effort_min: r.task.effort_min, next_due: r.next_due, status: r.status, bucket: r.bucket, plan: r.weekend_plan,
          supplies: r.task.supplies || null, snoozed_until: r.snoozed_until, away_shifted: r.away_shifted || false })),
        snoozed: snoozed.map((r) => ({ room: r.task.room, name: r.task.name, snoozed_until: r.snoozed_until, was_due: r.due_before })) }, null, 1));
      return 0;
    }
    console.log(`Weekend ending ${fmtDate(we.week_end, { long: true })} – ${we.totals.weekend}/${we.cap} min in the cap, carry over ${we.totals.carry} min`);
    for (const a of awayNow) console.log(`Away ${fmtDate(a.start_date)} – ${fmtDate(a.end_date)}: due dates shifted`);
    for (const b of ['Routine', 'This weekend', 'Planned', 'Weekday', 'Carry over']) {
      const rs = we.rows.filter((r) => r.bucket === b); if (!rs.length) continue;
      console.log(`\n${b} (${rs.length})`); rs.forEach((r) => console.log(line(r)));
    }
    if (snoozed.length) { console.log(`\nNot this weekend (${snoozed.length})`); snoozed.forEach((r) => console.log(`  ${r.task.room}: ${r.task.name} · snoozed to ${fmtDate(r.snoozed_until)}`)); }
    if (supplies.length) console.log(`\nYou'll need: ${supplies.join(', ')}`);
    return 0;
  }
  if (cmd === 'away') {
    const [sub = 'list', a1, a2] = rest;
    if (sub === 'list') {
      const list = currentAway(away, today);
      if (json) console.log(JSON.stringify(list, null, 1)); else if (!list.length) console.log('No away dates set.'); else list.forEach((a) => console.log(`${a.id}  ${fmtDate(a.start_date)} – ${fmtDate(a.end_date)}`));
      return 0;
    }
    if (sub === 'add') {
      if (!ISO.test(a1 || '') || !ISO.test(a2 || '') || a2 < a1) { console.error('usage: away add YYYY-MM-DD YYYY-MM-DD (to >= from)'); return 1; }
      if (dry) { console.log(`[dry-run] would add away ${fmtDate(a1)} – ${fmtDate(a2)}`); return 0; }
      const a = await store.addAway(db.tasks[0]?.owner_id, a1, a2);
      console.log(`✈ away ${fmtDate(a1)} – ${fmtDate(a2)} added (${a.id})`); return 0;
    }
    if (sub === 'rm') { if (!dry) await store.removeAway(a1); console.log(`${dry ? '[dry-run] would remove' : 'removed'} away ${a1}`); return 0; }
    console.error('usage: away [list] | away add FROM TO | away rm ID'); return 1;
  }
  if (cmd === 'tasks') {
    let rs = computeAll(db.tasks, db.completions, today, { away });
    if (dueOnly) rs = rs.filter((r) => ['Overdue', 'Due today', 'Due by Sunday'].includes(r.status));
    if (json) console.log(JSON.stringify(rs.map((r) => ({ room: r.task.room, name: r.task.name, next_due: r.next_due, status: r.status, last_done: r.last_effective })), null, 1));
    else rs.forEach((r) => console.log(line(r)));
    return 0;
  }
  if (cmd === 'done' || cmd === 'undo' || cmd === 'snooze' || cmd === 'unsnooze') {
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
      if (cmd === 'snooze' || cmd === 'unsnooze') {
        const z = cmd === 'unsnooze' ? null : saturdayOnOrAfter(date || nextWeekendSat(today));
        if (z && z <= today) { console.log(`- snooze date must be in the future`); rc = 2; continue; }
        if (!dry) await store.updateTask(t, { snooze_until: z });
        const after = computeAll([{ ...t, snooze_until: z }], db.completions, today, { away })[0];
        console.log(`${dry ? '[dry-run] would ' : ''}${z ? `💤 snoozed ${t.room}: ${t.name} to ${fmtDate(z)}` : `unsnoozed ${t.room}: ${t.name}`} → next due ${fmtDate(after.next_due)}`); continue;
      }
      const d = date || today;
      if (!dry) { await store.addCompletion(t, d, null); db.completions.push({ task_id: t.id, done_on: d }); if (t.snooze_until) { await store.updateTask(t, { snooze_until: null }); t.snooze_until = null; } }
      const after = computeAll([dry ? { ...t, snooze_until: null } : t], [...db.completions, ...(dry ? [{ task_id: t.id, done_on: d }] : [])], today, { away })[0];
      console.log(`${dry ? '[dry-run] would mark' : '✓ marked'} ${t.room}: ${t.name} done ${fmtDate(d)} (${m.how}) → next due ${fmtDate(after.next_due)}`);
    }
    return rc;
  }
  if (cmd === 'export') {
    const out = rest[0] || 'chores_export.xlsx';
    const payload = { today, tasks: computeAll(db.tasks, db.completions, today, { away }).map((r) => ({ ...r.task, next_due: r.next_due, status: r.status, last_effective: r.last_effective, plan: r.plan })),
      completions: db.completions.map((c) => ({ ...c, task: (db.tasks.find((t) => t.id === c.task_id) || {}).name, room: (db.tasks.find((t) => t.id === c.task_id) || {}).room })),
      weekend: we.rows.map((r) => ({ room: r.task.room, name: r.task.name, priority: r.task.priority, next_due: r.next_due, status: r.status, plan: r.weekend_plan, effort_min: r.task.effort_min, running: r.running, bucket: r.bucket })) };
    const p = spawnSync('python3', [path.join(ROOT, 'scripts/assistant_cli/xlsx_export.py'), out], { input: JSON.stringify(payload), encoding: 'utf8' });
    if (p.status) { console.error(p.stderr); return 1; }
    console.log(p.stdout.trim()); return 0;
  }
  console.error(`unknown command ${cmd}`); return 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) main().then((c) => process.exit(c)).catch((e) => { console.error(e.message); process.exit(1); });
