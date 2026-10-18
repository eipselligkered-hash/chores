import { computeAll, thisWeekend, weekEndFor, fmtDate, addDays, toDay } from './schedule.js?v=5';
import { makeBackend } from './data.js?v=5';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cls = (s) => String(s).replace(/[()]/g, '').replace(/\s+/g, '-');
const params = new URLSearchParams(location.search);
const localToday = () => params.get('today') || new Date().toLocaleDateString('en-CA');   // YYYY-MM-DD, device time zone
const CU_START = '2026-10-23', CU_END = '2026-10-27';

const be = makeBackend();
const state = { openRooms: new Set(), group: localStorage.getItem('chores.group') || 'room', tab: params.get('tab') || 'weekend', next: params.get('week') === 'next', q: '', db: null, lastUndo: null };

async function refresh() { state.db = await be.load(); render(); }
const cap = () => state.db.settings?.cap_min || window.CHORES_CONFIG?.cap || 300;

// ---------- actions
async function markDone(taskId, doneOn, label) {
  const c = await be.addCompletion(taskId, doneOn, 'app');
  await refresh();
  toast(`${label} – done ${fmtDate(doneOn)}`, async () => { await be.removeCompletion(c.id); await refresh(); });
}
async function undoCompletion(id) { await be.removeCompletion(id); await refresh(); toast('Undone'); }

let toastTimer;
function toast(msg, undo) {
  const t = $('#toast'); clearTimeout(toastTimer);
  t.innerHTML = `<span>${esc(msg)}</span>${undo ? '<button id="undo">Undo</button>' : ''}`; t.hidden = false;
  if (undo) $('#undo').onclick = async () => { t.hidden = true; await undo(); };
  toastTimer = setTimeout(() => (t.hidden = true), 6000);
}
function pickDate(task) {
  const d = $('#sheet'); $('#sheet-task').textContent = `${task.room}: ${task.name}`;
  const inp = $('#sheet-date'); inp.value = localToday(); inp.max = localToday();
  d.returnValue = ''; d.showModal();
  d.onclose = () => { if (d.returnValue === 'ok' && inp.value) markDone(task.id, inp.value, task.name); };
}

// ---------- rendering
const prioChip = (p) => (p ? `<span class="chip p-${cls(p)}">${esc(p)}</span>` : '');
const statusChip = (s) => `<span class="chip s-${cls(s)}">${esc(s)}</span>`;
function item(r, { tick = true, extra = '' } = {}) {
  const t = r.task;
  return `<div class="item ${t.priority === 'Safety' ? 'safety' : ''}" data-id="${t.id}">
    ${tick ? `<button class="tick" data-act="done" aria-label="Mark ${esc(t.name)} done today">✓</button>` : ''}
    <div class="body"><div class="name">${esc(t.name)}</div>
      <div class="meta"><span>${esc(t.room)}</span>${t.effort_min ? `<span>⏱ ${t.effort_min} min</span>` : ''}${prioChip(t.priority)}
      ${r.status ? statusChip(r.status) : ''}<span>${fmtDate(r.next_due)}</span>${extra}</div></div>
    ${tick ? `<button class="more" data-act="date" aria-label="Done on another date">⋯</button>` : ''}</div>`;
}
const section = (title, rows, note = '', klass = '') => rows.length
  ? `<h2 class="sec">${title}<small>${note}</small></h2><div class="list ${klass}">${rows.join('')}</div>` : '';
const mins = (rows) => rows.reduce((s, r) => s + (Number(r.task.effort_min) || 0), 0);

function renderWeekend() {
  const today = localToday(), db = state.db;
  const we0 = weekEndFor(today), weekEnd = state.next ? addDays(we0, 7) : we0;
  const w = thisWeekend(db.tasks, db.completions, today, { cap: cap(), weekEnd });
  const by = (b) => w.rows.filter((r) => r.bucket === b);
  const routine = by('Routine'), weekday = by('Weekday'), inCap = by('This weekend'), carry = by('Carry over'), planned = by('Planned');
  // minutes done this week (Mon..Sun ending weekEnd) on capped tasks
  const mon = toDay(weekEnd) - 6;
  const tmap = Object.fromEntries(db.tasks.map((t) => [t.id, t]));
  const recent = db.completions.filter((c) => toDay(c.done_on) >= toDay(today) - 6 && tmap[c.task_id]).sort((a, b) => b.done_on.localeCompare(a.done_on));
  const doneMin = db.completions.filter((c) => toDay(c.done_on) >= mon && toDay(c.done_on) <= toDay(weekEnd)).map((c) => tmap[c.task_id])
    .filter((t) => t && !(t.room === 'Laundry' && t.frequency === 'Weekly') && !t.due_weekday && t.frequency !== 'Daily')
    .reduce((s, t) => s + (t.effort_min || 0), 0);
  const c = w.cap, used = w.totals.weekend;
  const pct = (x) => Math.min(100, (x / c) * 100).toFixed(1);
  const sat = addDays(weekEnd, -1);
  let h = `<div class="seg"><button data-week="this" class="${state.next ? '' : 'on'}">This weekend</button><button data-week="next" class="${state.next ? 'on' : ''}">Next weekend</button></div>
  <div class="card cap"><div class="nums"><div><span class="big">${used}</span> <span class="of">of ${c} min planned</span></div><div class="of">${fmtDate(sat)} – ${fmtDate(weekEnd)}</div></div>
    <div class="bar" role="img" aria-label="${used} of ${c} minutes"><span class="plan" style="width:${pct(used)}%"></span><span class="done" style="width:${pct(Math.min(doneMin, used || doneMin))}%"></span></div>
    <div class="legend"><span><i class="dot" style="background:var(--brand)"></i>${doneMin} min done this week</span><span><i class="dot" style="background:#b8d8cc"></i>${inCap.length} tasks in the cap</span>${carry.length ? `<span>${carry.length} carry over (${mins(carry)} min)</span>` : ''}</div></div>`;
  h += section('🧺 Laundry routine', routine.map((r) => item(r)), `${mins(routine)} min · not capped`);
  h += section('This weekend', inCap.map((r) => item(r)), `Safety → Hygiene → Nice-to-have`);
  h += section('🗓 Planned (catch-up & one-offs)', planned.map((r) => item(r, { extra: r.plan ? `<span class="chip b-Planned">${esc(r.task.plan_text || 'Planned')}</span>` : '' })), `${mins(planned)} min · not capped`);
  h += section('💼 Weekday (Mon evening)', weekday.map((r) => item(r)), 'not capped');
  h += section('Carry over', carry.map((r) => item(r)), `${mins(carry)} min · past the ${c}-min cap`, 'carry');
  if (!w.rows.length) h += `<div class="card empty">Nothing due by ${fmtDate(weekEnd)} 🎉<br>${state.next ? '' : 'Check <b>Next weekend</b> to get ahead.'}</div>`;
  if (recent.length) h += section('Done recently', recent.slice(0, 12).map((c) => { const t = tmap[c.task_id];
    return `<div class="item"><button class="tick done" disabled aria-hidden="true">✓</button><div class="body"><div class="name">${esc(t.name)}</div><div class="meta"><span>${esc(t.room)}</span><span>done ${fmtDate(c.done_on)}</span></div></div><button class="ghost" data-undo="${c.id}">Undo</button></div>`; }), 'last 7 days');
  h += `<p class="hint">Tap ✓ to mark done today. Long-press a task (or ⋯) to pick another date.</p>`;
  return h;
}

function renderAll() {
  const db = state.db, today = localToday();
  const rows = computeAll(db.tasks, db.completions, today).sort((a, b) => a.task.sort_key - b.task.sort_key);
  const q = state.q.trim().toLowerCase();
  const counts = {}; rows.forEach((r) => (counts[r.status] = (counts[r.status] || 0) + 1));
  const G = state.group, PRIO = ['Safety', 'Hygiene', 'Nice-to-have'];
  const keyOf = (r) => (G === 'priority' ? (r.task.priority || 'No priority') : r.task.room);
  const rooms = new Map();
  if (G === 'priority') for (const k of PRIO) rooms.set(k, []);
  const list = G === 'priority' ? rows.slice().sort((a, b) => (a.next_due || '9999').localeCompare(b.next_due || '9999') || a.task.sort_key - b.task.sort_key) : rows;
  for (const r of list) { if (q && !(`${r.task.room} ${r.task.name} ${r.task.priority}`.toLowerCase().includes(q))) continue; const k = keyOf(r); if (!rooms.has(k)) rooms.set(k, []); rooms.get(k).push(r); }
  for (const [k, v] of rooms) if (!v.length) rooms.delete(k);
  let h = `<input class="search" type="search" placeholder="Search ${rows.length} tasks…" value="${esc(state.q)}" id="q" autocomplete="off">
    <div class="seg"><button data-group="room" class="${G === 'room' ? 'on' : ''}">By room</button><button data-group="priority" class="${G === 'priority' ? 'on' : ''}">By priority</button></div>
    <div class="summary">${['Overdue', 'Due today', 'Due by Sunday', 'OK', 'Paused (winter)', 'Daily habit', 'No date'].filter((s) => counts[s]).map((s) => `<span class="chip s-${cls(s)}">${counts[s]} ${s}</span>`).join('')}</div>`;
  for (const [room, rs] of rooms) {
    const od = rs.filter((r) => r.status === 'Overdue').length, due = rs.filter((r) => r.status.startsWith('Due')).length;
    h += `<details class="room" data-room="${esc(G + ':' + room)}" ${q || od || due || state.openRooms.has(G + ':' + room) ? 'open' : ''}><summary><span>${esc(room)} <small class="muted">(${rs.length})</small></span><span class="counts">${od ? `<span class="chip s-Overdue">${od} overdue</span>` : ''}${due ? `<span class="chip s-Due-today">${due} due</span>` : ''}</span></summary>
      ${rs.map((r) => `<div class="item ${r.task.priority === 'Safety' ? 'safety' : ''}" data-id="${r.task.id}">
        <button class="tick" data-act="done" aria-label="Mark ${esc(r.task.name)} done today">✓</button><div class="body"><div class="name">${esc(r.task.name)}</div>
        <div class="meta">${G === 'priority' ? `<span>${esc(r.task.room)}</span>` : ''}<span>${esc(r.task.frequency)}</span>${r.task.effort_min ? `<span>⏱ ${r.task.effort_min} min</span>` : ''}${G === 'priority' ? '' : prioChip(r.task.priority)}${r.task.season ? `<span>🍂 ${esc(r.task.season)}</span>` : ''}</div></div>
        <div class="due">${statusChip(r.status)}<div class="muted">${r.task.frequency === 'Daily' ? 'every day' : fmtDate(r.next_due)}</div></div>
        <button class="more" data-act="date" aria-label="Done on another date">⋯</button></div>`).join('')}</details>`;
  }
  if (!rooms.size) h += `<div class="empty">No tasks match “${esc(state.q)}”.</div>`;
  return h + `<p class="hint">Tap ✓ to mark done today, or ⋯ (long-press) to pick another date. To add or change a task, ask the assistant.</p>`;
}

function renderCatchup() {
  const db = state.db; const tmap = Object.fromEntries(db.tasks.map((t) => [t.id, t]));
  const days = new Map(); for (const i of db.catchup.slice().sort((a, b) => a.position - b.position)) { if (!days.has(i.day_date)) days.set(i.day_date, []); days.get(i.day_date).push(i); }
  let h = `<div class="card"><b>Catch-up ${fmtDate(CU_START)} – ${fmtDate(CU_END)}</b><div class="muted">Tick as you go – ticking logs the task as done today (walls: logged when the last room is ticked).</div></div>`;
  for (const [d, items] of days) {
    const left = items.filter((i) => !i.done_on).reduce((s, i) => s + (i.minutes || 0), 0), tot = items.reduce((s, i) => s + (i.minutes || 0), 0);
    h += `<h2 class="sec">${fmtDate(d, { long: true })}<small>${items.filter((i) => i.done_on).length}/${items.length} done · ${left} of ${tot} min left</small></h2><div class="list">` +
      items.map((i) => { const t = tmap[i.task_id] || {}; return `<div class="item ${i.done_on ? 'ticked' : ''} ${t.priority === 'Safety' ? 'safety' : ''}">
        <button class="tick ${i.done_on ? 'done' : ''}" data-cu="${i.id}" aria-label="Tick ${esc(t.name)}">✓</button>
        <div class="body"><div class="name">${esc(t.name)}</div><div class="meta"><span>${esc(t.room)}</span><span>⏱ ${i.minutes} min</span>${prioChip(t.priority === 'Safety' ? 'Safety' : '')}${i.kind && i.kind !== 'Catch-up' ? `<span>${esc(i.kind)}</span>` : ''}${i.note && i.note !== 'Safety' ? `<span>${esc(i.note)}</span>` : ''}</div></div></div>`; }).join('') + '</div>';
  }
  return h;
}

async function toggleCatchup(id) {
  const db = state.db, i = db.catchup.find((x) => x.id === id), today = localToday();
  const walls = db.catchup.filter((x) => x.task_id === i.task_id);
  if (i.done_on) {
    await be.setCatchupDone(id, null);
    const c = db.completions.find((c) => c.task_id === i.task_id && c.source === 'catchup');
    if (c) await be.removeCompletion(c.id);
  } else {
    await be.setCatchupDone(id, today);
    const rest = walls.filter((x) => x.id !== id && !x.done_on);
    if (!rest.length) await be.addCompletion(i.task_id, today, 'catchup');
  }
  await refresh();
}

function render() {
  const today = localToday();
  $('#today').textContent = fmtDate(today, { long: true }) + ' · v5' + (be.kind === 'mock' ? ' · local mock' : '');
  $('#account').textContent = be.kind === 'mock' ? 'Mock data' : (be.user?.email || '');
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === state.tab));
  $('#tab-catchup').hidden = !state.db.catchup.length || today > addDays(CU_END, 14);
  $('#view').innerHTML = state.tab === 'all' ? renderAll() : state.tab === 'catchup' ? renderCatchup() : renderWeekend();
  document.querySelectorAll('details.room').forEach((d) => d.addEventListener('toggle', () => { d.open ? state.openRooms.add(d.dataset.room) : state.openRooms.delete(d.dataset.room); }));
  const q = $('#q'); if (q) { q.oninput = (e) => { state.q = e.target.value; const pos = e.target.selectionStart; render(); const n = $('#q'); n.focus(); n.setSelectionRange(pos, pos); }; }
}

function renderLogin(msg = '') {
  $('#today').textContent = fmtDate(localToday(), { long: true });
  $('#view').innerHTML = `<div class="card login"><h2>Sign in</h2><p class="muted">We'll email you a magic link – no password needed.</p>
    <form id="login"><input type="email" id="email" required placeholder="you@example.com" autocomplete="email"><button class="primary">Send magic link</button></form><p>${esc(msg)}</p></div>`;
  $('#login').onsubmit = async (e) => { e.preventDefault(); try { await be.signIn($('#email').value); renderLogin('Check your email and open the link on this device.'); } catch (err) { renderLogin('Could not send: ' + err.message); } };
}

// ---------- events: tap = done today, long-press / ⋯ = pick a date
let pressTimer = null, longPressed = false;
const taskOf = (el) => state.db.tasks.find((t) => t.id === el.closest('.item')?.dataset.id);
const view = $('#view');
view.addEventListener('pointerdown', (e) => {
  longPressed = false; const it = e.target.closest('.item[data-id]'); if (!it) return;
  pressTimer = setTimeout(() => { longPressed = true; navigator.vibrate?.(20); pickDate(taskOf(it)); }, 550);
});
['pointerup', 'pointerleave', 'pointercancel', 'scroll'].forEach((ev) => view.addEventListener(ev, () => clearTimeout(pressTimer), true));
view.addEventListener('contextmenu', (e) => { if (e.target.closest('.item[data-id]')) e.preventDefault(); });
view.addEventListener('click', async (e) => {
  const b = e.target.closest('button'); if (!b) return;
  if (longPressed) { longPressed = false; return; }
  if (b.dataset.group) { state.group = b.dataset.group; localStorage.setItem('chores.group', state.group); return render(); }
  if (b.dataset.week) { state.next = b.dataset.week === 'next'; return render(); }
  if (b.dataset.undo) return undoCompletion(b.dataset.undo);
  if (b.dataset.cu) return toggleCatchup(b.dataset.cu);
  const t = taskOf(b); if (!t) return;
  if (b.dataset.act === 'done') { b.classList.add('done'); return markDone(t.id, localToday(), t.name); }
  if (b.dataset.act === 'date') return pickDate(t);
});
document.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => { state.tab = b.dataset.tab; $('#toast').hidden = true; render(); scrollTo(0, 0); }));
$('#account').onclick = async () => {
  if (be.kind === 'mock') { if (confirm('Reset the local mock data back to the seed?')) { be.reset(); location.reload(); } return; }
  if (confirm(`Signed in as ${be.user?.email}. Sign out?`)) { await be.signOut(); location.reload(); }
};

(async () => {
  try {
    const ok = await be.init();
    if (!ok) return renderLogin();
    be.onChange(() => refresh());
    await refresh();
  } catch (err) { $('#view').innerHTML = `<div class="card">Couldn't load: ${esc(err.message)}</div>`; console.error(err); }
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((r) => r.update()).catch(() => {});
})();
