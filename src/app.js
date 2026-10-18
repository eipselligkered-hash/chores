import { computeAll, computeTask, thisWeekend, weekEndFor, fmtDate, addDays, toDay, FREQUENCIES, SEASONS, PRIORITIES, WEEKDAYS,
  nextWeekendSat, saturdayOnOrAfter, uniqueSupplies, currentAway, effectiveLast, fromDay, planDone, EFFORT_BUCKETS, effortBucket, byNextDue } from './schedule.js?v=10';
import { makeBackend } from './data.js?v=10';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cls = (s) => String(s).replace(/[()]/g, '').replace(/\s+/g, '-');
const params = new URLSearchParams(location.search);
const localToday = () => params.get('today') || new Date().toLocaleDateString('en-CA');   // YYYY-MM-DD, device time zone
const CU_START = '2026-10-23', CU_END = '2026-10-27';

const be = makeBackend();
const state = { openRooms: new Set(), group: ['room', 'priority', 'time'].includes(localStorage.getItem('chores.group')) ? localStorage.getItem('chores.group') : 'room', filter: localStorage.getItem('chores.filter') || 'all', tab: params.get('tab') || 'weekend', next: params.get('week') === 'next', q: '', db: null, lastUndo: null };

// only the most recent load is shown, so a slow older response can't overwrite newer data
let loadSeq = 0;
async function refresh() { const n = ++loadSeq; const db = await be.load(); if (n !== loadSeq) return; state.db = db; render(); }
const fail = (err) => { console.error(err); toast(`Couldn't save – ${err?.message || err}`); refresh().catch(() => {}); };
const safe = (fn) => async (...a) => { try { return await fn(...a); } catch (err) { fail(err); } };
const cap = () => state.db.settings?.cap_min || window.CHORES_CONFIG?.cap || 300;
const away = () => state.db.away || [];
const dm = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : '–');

// ---------- actions
const busy = new Set();   // tasks with a save in flight (repeated taps)
async function markDone(taskId, doneOn, label) {
  const t = state.db.tasks.find((x) => x.id === taskId); if (!t || busy.has(taskId)) return;
  const p = planDone(t, state.db.completions, doneOn);
  if (p.duplicate) { render(); return toast(`${label} – already done ${fmtDate(doneOn)}`); }
  // an earlier date than the last done replaces it (effective last = latest date, so otherwise nothing would change)
  const prev = { snooze_until: t.snooze_until || null, last_done: t.last_done || null }, patch = {};
  if (prev.snooze_until) patch.snooze_until = null;   // done supersedes 'Not this weekend'
  if (p.last_done !== undefined) patch.last_done = p.last_done;
  let c;
  busy.add(taskId);
  try {
    if (!p.exists) c = await be.addCompletion(taskId, doneOn, 'app');
    for (const x of p.later) await be.removeCompletion(x.id);
    if (Object.keys(patch).length) await be.updateTask(taskId, patch);
  } catch (err) { busy.delete(taskId); return fail(err); }
  await refresh().catch(console.error).finally(() => busy.delete(taskId));
  toast(`${label} – done ${fmtDate(doneOn)}${p.replaces ? ` (was ${fmtDate(p.replaces)})` : ''}`, async () => {
    if (c) await be.removeCompletion(c.id);
    for (const x of p.later) await be.addCompletion(taskId, x.done_on, x.source, x.note);
    if (Object.keys(patch).length) await be.updateTask(taskId, Object.fromEntries(Object.keys(patch).map((k) => [k, prev[k]])));
    await refresh();
  });
}
async function setSnooze(t, date) {
  const prev = t.snooze_until || null;
  try { await be.updateTask(t.id, { snooze_until: date }); } catch (err) { return fail(err); }
  await refresh().catch(console.error);
  toast(date ? `${t.name} – snoozed to ${fmtDate(date)}` : 'Snooze removed', async () => { await be.updateTask(t.id, { snooze_until: prev }); await refresh(); });
}
const undoCompletion = safe(async (id) => { await be.removeCompletion(id); await refresh(); toast('Undone'); });

let toastTimer;
function toast(msg, undo) {
  const t = $('#toast'); clearTimeout(toastTimer);
  t.innerHTML = `<span>${esc(msg)}</span>${undo ? '<button id="undo">Undo</button>' : ''}`; t.hidden = false;
  if (undo) $('#undo').onclick = async () => { t.hidden = true; await safe(undo)(); };
  toastTimer = setTimeout(() => (t.hidden = true), 6000);
}
function pickDate(task) {
  const d = $('#sheet'); $('#sheet-task').textContent = `${task.room}: ${task.name}`;
  const inp = $('#sheet-date'); inp.value = localToday(); inp.max = localToday();
  const last = fromDay(effectiveLast(task, state.db.completions)), note = $('#sheet-note');
  inp.oninput = inp.onchange = () => { note.textContent = !last ? '' : inp.value && inp.value < last ? `Earlier than the last done (${fmtDate(last)}) – this replaces it.` : `Last done ${fmtDate(last)}`; };
  inp.oninput();
  d.returnValue = ''; d.showModal();
  d.onclose = () => { if (d.returnValue === 'ok' && inp.value) markDone(task.id, inp.value, task.name); };
}

// ---------- rendering
const prioChip = (p) => (p ? `<span class="chip p-${cls(p)}">${esc(p)}</span>` : '');
const statusChip = (s) => `<span class="chip s-${cls(s)}">${esc(s)}</span>`;
const snoozeChip = (r) => (r.snoozed_until ? `<span class="chip snz">💤 snoozed to ${fmtDate(r.snoozed_until)}</span>` : '');
function item(r, { tick = true, extra = '' } = {}) {
  const t = r.task;
  return `<div class="item ${t.priority === 'Safety' ? 'safety' : ''}" data-id="${t.id}">
    ${tick ? `<button class="tick" data-act="done" aria-label="Mark ${esc(t.name)} done today">✓</button>` : ''}
    <div class="body"><div class="name">${esc(t.name)}</div>
      <div class="meta"><span>${esc(t.room)}</span>${t.effort_min ? `<span>⏱ ${t.effort_min} min</span>` : ''}${prioChip(t.priority)}
      ${r.status ? statusChip(r.status) : ''}<span>${fmtDate(r.next_due)}</span>${snoozeChip(r)}${extra}</div></div>
    ${tick ? `<button class="more" data-act="date" aria-label="Done on another date">⋯</button>` : ''}</div>`;
}
const section = (title, rows, note = '', klass = '') => rows.length
  ? `<h2 class="sec">${title}<small>${note}</small></h2><div class="list ${klass}">${rows.join('')}</div>` : '';
const mins = (rows) => rows.reduce((s, r) => s + (Number(r.task.effort_min) || 0), 0);

function renderWeekend() {
  const today = localToday(), db = state.db;
  const we0 = weekEndFor(today), weekEnd = state.next ? addDays(we0, 7) : we0;
  const w = thisWeekend(db.tasks, db.completions, today, { cap: cap(), weekEnd, away: away() });
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
  const snoozed = computeAll(db.tasks, db.completions, today, { away: away() })
    .filter((r) => r.snoozed_until && r.due_before && r.due_before <= weekEnd && r.snoozed_until > weekEnd);
  const supplies = uniqueSupplies([...inCap, ...planned].map((r) => r.task));
  let h = awayBanner() + `<div class="seg"><button data-week="this" class="${state.next ? '' : 'on'}">This weekend</button><button data-week="next" class="${state.next ? 'on' : ''}">Next weekend</button></div>
  <div class="card cap"><div class="nums"><div><span class="big">${used}</span> <span class="of">of ${c} min planned</span></div><div class="of">${fmtDate(sat)} – ${fmtDate(weekEnd)}</div></div>
    <div class="bar" role="img" aria-label="${used} of ${c} minutes"><span class="plan" style="width:${pct(used)}%"></span><span class="done" style="width:${pct(Math.min(doneMin, used || doneMin))}%"></span></div>
    <div class="legend"><span><i class="dot" style="background:var(--brand)"></i>${doneMin} min done this week</span><span><i class="dot" style="background:#b8d8cc"></i>${inCap.length} tasks in the cap</span>${carry.length ? `<span>${carry.length} carry over (${mins(carry)} min)</span>` : ''}</div></div>`;
  if (supplies.length) h += `<details class="needs" id="needs" ${state.needsOpen ? 'open' : ''}><summary><b>🧰 You'll need</b> <span class="preview muted">${esc(supplies.join(', '))}</span></summary>
    <ul>${supplies.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></details>`;
  h += section('🧺 Laundry routine', routine.map((r) => item(r)), `${mins(routine)} min · not capped`);
  h += section('This weekend', inCap.map((r) => item(r)), `Safety → Hygiene → Nice-to-have`);
  h += section('🗓 Planned (catch-up & one-offs)', planned.map((r) => item(r, { extra: r.plan ? `<span class="chip b-Planned">${esc(r.task.plan_text || 'Planned')}</span>` : '' })), `${mins(planned)} min · not capped`);
  h += section('💼 Weekday (Mon evening)', weekday.map((r) => item(r)), 'not capped');
  h += section('Carry over', carry.map((r) => item(r)), `${mins(carry)} min · past the ${c}-min cap`, 'carry');
  h += section('💤 Not this weekend', snoozed.map((r) => item(r, { tick: false, extra: `<button class="link" data-unsnooze="${r.task.id}">Undo</button>` })), 'snoozed');
  if (!w.rows.length) h += `<div class="card empty">Nothing due by ${fmtDate(weekEnd)} 🎉<br>${state.next ? '' : 'Check <b>Next weekend</b> to get ahead.'}</div>`;
  if (recent.length) h += section('Done recently', recent.slice(0, 12).map((c) => { const t = tmap[c.task_id];
    return `<div class="item" data-tid="${t.id}"><button class="tick done" disabled aria-hidden="true">✓</button><div class="body"><div class="name">${esc(t.name)}</div><div class="meta"><span>${esc(t.room)}</span><span>done ${fmtDate(c.done_on)}</span></div></div><button class="ghost" data-undo="${c.id}">Undo</button></div>`; }), 'last 7 days');
  h += `<p class="hint">Tap a task for details and how-to. Tap ✓ to mark done today; long-press (or ⋯) to pick another date.</p>`;
  return h;
}

function renderAll() {
  const db = state.db, today = localToday();
  const rows = computeAll(db.tasks, db.completions, today, { away: away() }).sort((a, b) => a.task.sort_key - b.task.sort_key);
  const q = state.q.trim().toLowerCase();
  const counts = {}; rows.forEach((r) => (counts[r.status] = (counts[r.status] || 0) + 1));
  const mon = addDays(weekEndFor(today), -6);
  const isTodo = (r) => ['Overdue', 'Due today', 'Due by Sunday'].includes(r.status);
  const isDone = (r) => r.last_effective && r.last_effective >= mon && r.last_effective <= today;
  const F = state.filter, nTodo = rows.filter(isTodo).length, nDone = rows.filter(isDone).length;
  const passF = (r) => (F === 'todo' ? isTodo(r) : F === 'done' ? isDone(r) : true);
  const G = state.group, PRIO = ['Safety', 'Hygiene', 'Nice-to-have'];
  const keyOf = (r) => (G === 'priority' ? (r.task.priority || 'No priority') : G === 'time' ? effortBucket(r.task.effort_min) : r.task.room);
  const rooms = new Map();
  if (G === 'priority') for (const k of PRIO) rooms.set(k, []);
  if (G === 'time') for (const k of EFFORT_BUCKETS) rooms.set(k, []);
  const daily = (r) => (r.task.frequency === 'Daily' ? 1 : 0);   // 'every day' has no real due date: after the dated jobs
  const list = G === 'room' ? rows : rows.slice().sort(G === 'time' ? (a, b) => daily(a) - daily(b) || byNextDue(a, b) : byNextDue);
  for (const r of list) { if (!passF(r)) continue; if (q && !(`${r.task.room} ${r.task.name} ${r.task.priority}`.toLowerCase().includes(q))) continue; const k = keyOf(r); if (!rooms.has(k)) rooms.set(k, []); rooms.get(k).push(r); }
  for (const [k, v] of rooms) if (!v.length) rooms.delete(k);
  let h = `<div class="toolbar"><input class="search" type="search" placeholder="Search ${rows.length} tasks…" value="${esc(state.q)}" id="q" autocomplete="off">
    <button class="primary add" data-add>+ Add task</button><button class="ghost gear" data-settings aria-label="Settings and away dates">⚙</button></div>
    <div class="seg"><button data-group="room" class="${G === 'room' ? 'on' : ''}">By room</button><button data-group="priority" class="${G === 'priority' ? 'on' : ''}">By priority</button><button data-group="time" class="${G === 'time' ? 'on' : ''}">By time</button></div>
    <div class="seg"><button data-filter="all" class="${F === 'all' ? 'on' : ''}">All</button><button data-filter="todo" class="${F === 'todo' ? 'on' : ''}">To do (${nTodo})</button><button data-filter="done" class="${F === 'done' ? 'on' : ''}">Done (${nDone})</button></div>
    <div class="summary">${['Overdue', 'Due today', 'Due by Sunday', 'OK', 'Paused (winter)', 'Daily habit', 'No date'].filter((s) => counts[s]).map((s) => `<span class="chip s-${cls(s)}">${counts[s]} ${s}</span>`).join('')}</div>`;
  for (const [room, rs] of rooms) {
    const od = rs.filter((r) => r.status === 'Overdue').length, due = rs.filter((r) => r.status.startsWith('Due')).length;
    h += `<details class="room" data-room="${esc(G + ':' + room)}" ${q || F !== 'all' || od || due || state.openRooms.has(G + ':' + room) ? 'open' : ''}><summary><span>${esc(room)} <small class="muted">(${rs.length})</small></span><span class="counts">${od ? `<span class="chip s-Overdue">${od} overdue</span>` : ''}${due ? `<span class="chip s-Due-today">${due} due</span>` : ''}</span></summary>
      ${rs.map((r) => `<div class="item ${r.task.priority === 'Safety' ? 'safety' : ''}" data-id="${r.task.id}">
        <button class="tick ${isDone(r) ? 'done' : ''}" data-act="done" aria-label="Mark ${esc(r.task.name)} done today">✓</button><div class="body"><div class="name">${esc(r.task.name)}</div>
        <div class="meta">${G !== 'room' ? `<span>${esc(r.task.room)}</span>` : ''}<span>${esc(r.task.frequency)}</span>${r.task.effort_min ? `<span>⏱ ${r.task.effort_min} min</span>` : ''}${G === 'priority' ? '' : prioChip(r.task.priority)}${r.task.season ? `<span>🍂 ${esc(r.task.season)}</span>` : ''}${snoozeChip(r)}</div></div>
        <div class="due">${isDone(r) ? '<span class="chip s-Done">Done ✓</span>' : statusChip(r.status)}<div class="muted">${F === 'done' ? `done ${fmtDate(r.last_effective)}` : r.task.frequency === 'Daily' ? 'every day' : fmtDate(r.next_due)}</div></div>
        <button class="more" data-act="date" aria-label="Done on another date">⋯</button></div>`).join('')}</details>`;
  }
  if (!rooms.size) h += `<div class="card empty">${q ? `No tasks match “${esc(state.q)}”.` : F === 'todo' ? 'Nothing to do by Sunday 🎉' : F === 'done' ? 'Nothing ticked off yet this week.' : 'No tasks.'}</div>`;
  const retired = db.tasks.filter((t) => t.active === false).sort((a, b) => a.room.localeCompare(b.room) || a.name.localeCompare(b.name));
  if (retired.length && !q && F === 'all') h += `<details class="room retired"><summary><span>Retired <small class="muted">(${retired.length})</small></span></summary>
    ${retired.map((t) => `<div class="item" data-tid="${t.id}"><div class="body"><div class="name">${esc(t.name)}</div><div class="meta"><span>${esc(t.room)}</span><span>${esc(t.frequency)}</span></div></div></div>`).join('')}</details>`;
  return h + `<p class="hint">Tap a task for details, how-to and Edit. ✓ = done today; ⋯ or long-press = pick another date.</p>`;
}

function renderCatchup() {
  const db = state.db; const tmap = Object.fromEntries(db.tasks.map((t) => [t.id, t]));
  const days = new Map(); for (const i of db.catchup.slice().sort((a, b) => a.position - b.position)) { if (!days.has(i.day_date)) days.set(i.day_date, []); days.get(i.day_date).push(i); }
  let h = `<div class="card"><b>Catch-up ${fmtDate(CU_START)} – ${fmtDate(CU_END)}</b><div class="muted">Tick as you go – ticking logs the task as done today (walls: logged when the last room is ticked).</div></div>`;
  for (const [d, items] of days) {
    const left = items.filter((i) => !i.done_on).reduce((s, i) => s + (i.minutes || 0), 0), tot = items.reduce((s, i) => s + (i.minutes || 0), 0);
    h += `<h2 class="sec">${fmtDate(d, { long: true })}<small>${items.filter((i) => i.done_on).length}/${items.length} done · ${left} of ${tot} min left</small></h2><div class="list">` +
      items.map((i) => { const t = tmap[i.task_id] || {}; return `<div class="item ${i.done_on ? 'ticked' : ''} ${t.priority === 'Safety' ? 'safety' : ''}" data-tid="${t.id || ''}">
        <button class="tick ${i.done_on ? 'done' : ''}" data-cu="${i.id}" aria-label="Tick ${esc(t.name)}">✓</button>
        <div class="body"><div class="name">${esc(t.name)}</div><div class="meta"><span>${esc(t.room)}</span><span>⏱ ${i.minutes} min</span>${prioChip(t.priority === 'Safety' ? 'Safety' : '')}${i.kind && i.kind !== 'Catch-up' ? `<span>${esc(i.kind)}</span>` : ''}${i.note && i.note !== 'Safety' ? `<span>${esc(i.note)}</span>` : ''}</div></div></div>`; }).join('') + '</div>';
  }
  return h;
}

const toggleCatchup = safe(async (id) => {
  if (busy.has(id)) return;
  busy.add(id);
  try { await toggleCatchupNow(id); } finally { busy.delete(id); }
});
async function toggleCatchupNow(id) {
  const db = state.db, i = db.catchup.find((x) => x.id === id), today = localToday(); if (!i) return;
  const walls = db.catchup.filter((x) => x.task_id === i.task_id);
  if (i.done_on) {
    await be.setCatchupDone(id, null);
    const c = db.completions.find((c) => c.task_id === i.task_id && c.source === 'catchup');
    if (c) await be.removeCompletion(c.id);
  } else {
    await be.setCatchupDone(id, today);
    const rest = walls.filter((x) => x.id !== id && !x.done_on);
    if (!rest.length && !db.completions.some((c) => c.task_id === i.task_id && c.done_on === today)) await be.addCompletion(i.task_id, today, 'catchup');
  }
  await refresh();
}

function render() {
  const today = localToday();
  $('#today').textContent = fmtDate(today, { long: true }) + ' · v10' + (be.kind === 'mock' ? ' · local mock' : '');
  $('#account').textContent = '⚙ ' + (be.kind === 'mock' ? 'Mock data' : (be.user?.email || ''));
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === state.tab));
  $('#tab-catchup').hidden = !state.db.catchup.length || today > addDays(CU_END, 14);
  const qPos = document.activeElement?.id === 'q' ? document.activeElement.selectionStart : null;
  $('#view').innerHTML = state.tab === 'all' ? renderAll() : state.tab === 'catchup' ? renderCatchup() : renderWeekend();
  document.querySelectorAll('details.room').forEach((d) => d.addEventListener('toggle', () => { d.open ? state.openRooms.add(d.dataset.room) : state.openRooms.delete(d.dataset.room); }));
  const nd = $('#needs'); if (nd) nd.addEventListener('toggle', () => (state.needsOpen = nd.open));
  const q = $('#q'); if (q && qPos != null) { q.focus(); q.setSelectionRange(qPos, qPos); }
  if (q) { q.oninput = (e) => { state.q = e.target.value; const pos = e.target.selectionStart; render(); const n = $('#q'); n.focus(); n.setSelectionRange(pos, pos); }; }
}

function renderLogin(msg = '') {
  $('#today').textContent = fmtDate(localToday(), { long: true });
  $('#view').innerHTML = `<div class="card login"><h2>Sign in</h2><p class="muted">We'll email you a magic link – no password needed.</p>
    <form id="login"><input type="email" id="email" required placeholder="you@example.com" autocomplete="email"><button class="primary">Send magic link</button></form><p>${esc(msg)}</p></div>`;
  $('#login').onsubmit = async (e) => { e.preventDefault(); try { await be.signIn($('#email').value); renderLogin('Check your email and open the link on this device.'); } catch (err) { renderLogin('Could not send: ' + err.message); } };
}

// ---------- away mode
function awayBanner() {
  return currentAway(away(), localToday()).map((a) => `<div class="banner"><span>✈️ Away ${dm(a.start_date)}–${dm(a.end_date)} – tasks shifted</span>
    <button class="link" data-away-del="${esc(a.id)}">Delete</button></div>`).join('');
}
async function deleteAway(id) {
  const a = away().find((x) => x.id === id); if (!a) return;
  if (!confirm(`Delete away dates ${dm(a.start_date)}–${dm(a.end_date)}? Tasks go back to their normal dates.`)) return;
  try { await be.removeAway(id); } catch (err) { return toast(err.message); }
  await refresh(); if ($('#settings').open) openSettings();
  toast('Away dates deleted', async () => { await be.addAway(a.start_date, a.end_date); await refresh(); });
}

function openSettings() {
  if (!state.db) return;
  const d = $('#settings'), today = localToday(), list = currentAway(away(), addDays(today, -60));   // recently ended trips still shift tasks
  d.innerHTML = `<form method="dialog"><div class="sheet-head"><h2>Settings</h2><button value="close" class="x" aria-label="Close">✕</button></div>
    <h3>✈️ Away</h3>
    <p class="muted small">Tasks due while you're away move later by the same number of days, so you come back to the backlog you left – not a pile. Daily habits aren't affected.</p>
    ${list.length ? `<div class="list">${list.map((a) => `<div class="item slim"><div class="body"><div class="name">${fmtDate(a.start_date)} – ${fmtDate(a.end_date)}</div>
      <div class="meta">${toDay(a.end_date) - toDay(a.start_date) + 1} days${a.end_date < today ? ' · ended' : a.start_date <= today ? ' · on now' : ''}</div></div><button type="button" class="ghost" data-away-del="${esc(a.id)}">Delete</button></div>`).join('')}</div>` : ''}
    <div class="two"><label class="field">From <input type="date" id="away-from" value="${today}" min="${addDays(today, -60)}"></label>
      <label class="field">To <input type="date" id="away-to" min="${today}"></label></div>
    <button type="button" class="primary wide" id="away-add">Add away dates</button>
    <h3>Account</h3>
    <p class="muted small">${be.kind === 'mock' ? 'Local mock data (this device only).' : `Signed in as ${esc(be.user?.email || '')}`}</p>
    <button type="button" class="ghost wide" id="acct">${be.kind === 'mock' ? 'Reset mock data' : 'Sign out'}</button></form>`;
  const from = $('#away-from', d), to = $('#away-to', d);
  from.onchange = () => { to.min = from.value; if (to.value && to.value < from.value) to.value = from.value; };
  $('#away-add', d).onclick = async () => {
    if (!from.value || !to.value) return toast('Pick both dates');
    if (to.value < from.value) return toast('“To” is before “From”');
    try { await be.addAway(from.value, to.value); } catch (err) { return toast(err.message); }
    d.close(); await refresh(); toast(`Away ${dm(from.value)}–${dm(to.value)} – tasks shifted`);
  };
  d.querySelectorAll('[data-away-del]').forEach((b) => (b.onclick = () => deleteAway(b.dataset.awayDel)));
  $('#acct', d).onclick = async () => {
    if (be.kind === 'mock') { if (confirm('Reset the local mock data back to the seed?')) { be.reset(); location.reload(); } return; }
    if (confirm(`Signed in as ${be.user?.email}. Sign out?`)) { await be.signOut(); location.reload(); }
  };
  if (!d.open) d.showModal();
}

// ---------- task sheet (details, how-to, snooze, edit)
const linkify = (s) => esc(s).replace(/https?:\/\/[^\s;,)]+/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u.replace(/^https?:\/\/(www\.)?/, '').slice(0, 40)}…</a>`).replace(/\n/g, '<br>');
function openTask(id) {
  const t = state.db.tasks.find((x) => x.id === id); if (!t) return;
  const today = localToday(), r = computeTask(t, state.db.completions, today, { away: away() });
  const hist = state.db.completions.filter((c) => c.task_id === t.id).map((c) => c.done_on);
  if (t.last_done && !hist.includes(t.last_done)) hist.push(t.last_done);
  hist.sort().reverse();
  const daily = t.frequency === 'Daily', retired = t.active === false;
  const snoozeTo = nextWeekendSat(today);
  const d = $('#task-sheet');
  d.innerHTML = `<form method="dialog"><div class="sheet-head"><h2>${esc(t.name)}</h2><button value="close" class="x" aria-label="Close">✕</button></div>
    <div class="meta big-meta"><span>${esc(t.room)}</span><span>${esc(t.frequency)}</span>${t.effort_min ? `<span>⏱ ${t.effort_min} min</span>` : ''}${prioChip(t.priority)}${t.season ? `<span>🍂 ${esc(t.season)}</span>` : ''}${t.due_weekday ? `<span>📅 ${esc(t.due_weekday)}</span>` : ''}${retired ? '<span class="chip s-No-date">Retired</span>' : ''}</div>
    <dl class="facts">
      <dt>Next due</dt><dd>${daily ? 'every day' : `${fmtDate(r.next_due, { long: true })} ${statusChip(r.status)}`}
        ${r.snoozed_until ? `<div class="snz-line"><span class="chip snz">💤 snoozed to ${fmtDate(r.snoozed_until)}</span> <button type="button" class="link" id="ts-unsnooze">Undo</button></div>` : ''}
        ${r.away_shifted ? `<div class="muted small">moved from ${fmtDate(r.due_before)} (away)</div>` : ''}${r.plan && !t.due_weekday ? `<div class="muted small">${esc(r.plan)}</div>` : ''}</dd>
      <dt>Last done</dt><dd>${hist.length ? hist.slice(0, 4).map((x) => fmtDate(x, { long: true })).join('<br>') : '<span class="muted">never</span>'}</dd>
      ${t.supplies ? `<dt>You'll need</dt><dd>${esc(t.supplies)}</dd>` : ''}
    </dl>
    ${t.notes ? `<div class="howto"><b>How to</b><p>${linkify(t.notes)}</p></div>` : ''}
    ${retired ? '' : `<div class="row-btns sheet-acts"><button type="button" class="primary" id="ts-done">✓ Done today</button>
      ${daily ? '' : `<button type="button" class="ghost" id="ts-snooze">Not this weekend</button>`}</div>
      ${daily ? '' : `<details class="snz-pick"><summary>Snooze to another Saturday…</summary><div class="two"><input type="date" id="ts-snz-date" min="${addDays(today, 1)}" value="${addDays(snoozeTo, 7)}"><button type="button" class="ghost" id="ts-snz-go">Snooze</button></div></details>`}`}
    <button type="button" class="ghost wide" id="ts-edit">✎ Edit task</button></form>`;
  const go = (fn) => async () => { d.close(); await fn(); };
  $('#ts-edit', d).onclick = go(() => openEdit(t));
  if (!retired) {
    $('#ts-done', d).onclick = go(() => markDone(t.id, today, t.name));
    if (!daily) {
      $('#ts-snooze', d).onclick = go(() => setSnooze(t, snoozeTo));
      $('#ts-snooze', d).textContent = `Not this weekend → ${fmtDate(snoozeTo)}`;
      $('#ts-snz-go', d).onclick = () => { const v = $('#ts-snz-date', d).value; if (!v || v <= today) return toast('Pick a future date'); go(() => setSnooze(t, saturdayOnOrAfter(v)))(); };
    }
  }
  const un = $('#ts-unsnooze', d); if (un) un.onclick = go(() => setSnooze(t, null));
  d.showModal(); d.scrollTop = 0;
}

function openEdit(t) {
  const isNew = !t, d = $('#edit-sheet'), db = state.db;
  t = t || { room: '', name: '', frequency: 'Monthly', priority: 'Nice-to-have', effort_min: 15, active: true };
  const rooms = [...new Set(db.tasks.map((x) => x.room))].sort();
  const shownLast = isNew ? null : fromDay(effectiveLast(t, db.completions));   // what the app uses (typed or latest tick)
  const opt = (vals, cur, blank) => (blank != null ? `<option value="">${blank}</option>` : '') + vals.map((v) => `<option ${v === cur ? 'selected' : ''}>${esc(v)}</option>`).join('');
  d.innerHTML = `<form id="edit-form" novalidate><div class="sheet-head"><h2>${isNew ? 'Add task' : 'Edit task'}</h2><button type="button" class="x" id="ed-x" aria-label="Close">✕</button></div>
    <label class="field">Task <input name="name" required value="${esc(t.name)}" placeholder="e.g. Clean grout"></label>
    <label class="field">Room <input name="room" required list="rooms-dl" value="${esc(t.room)}" placeholder="Pick or type a new room" autocomplete="off"><datalist id="rooms-dl">${rooms.map((x) => `<option value="${esc(x)}">`).join('')}</datalist></label>
    <div class="two"><label class="field">How often <select name="frequency">${opt(Object.keys(FREQUENCIES), t.frequency)}</select></label>
      <label class="field">Effort (min) <input name="effort_min" type="number" inputmode="numeric" min="0" max="1440" step="5" value="${t.effort_min ?? ''}"></label></div>
    <div class="two"><label class="field">Priority <select name="priority">${opt(PRIORITIES, t.priority)}</select></label>
      <label class="field">Last done <input name="last_done" type="date" value="${(isNew ? t.last_done : shownLast) || ''}" max="${localToday()}"></label></div>
    <label class="field">How-to notes <textarea name="notes" rows="3" placeholder="Optional">${esc(t.notes || '')}</textarea></label>
    <label class="field">Supplies <input name="supplies" value="${esc(t.supplies || '')}" placeholder="Optional, comma-separated (e.g. descaler, cloths)"></label>
    <details class="adv"><summary>Advanced</summary>
      <label class="field">Season <select name="season">${opt(Object.keys(SEASONS), t.season, 'None')}</select></label>
      <div class="two"><label class="field">Due weekday <select name="due_weekday">${opt(WEEKDAYS.filter((x) => x !== 'Sat'), t.due_weekday, 'Saturday (normal)')}</select></label>
        <label class="field">Planned date <input name="planned_date" type="date" value="${t.planned_date || ''}"></label></div>
      <label class="field">Stagger date (one-off move) <input name="stagger_date" type="date" value="${t.stagger_date || ''}"></label>
      <p class="muted small">A weekday other than Saturday keeps the task outside the weekend cap (like Admin on Monday). Planned date only counts while the task has never been done.</p>
    </details>
    ${isNew ? '' : `<label class="toggle"><input type="checkbox" name="active" ${t.active !== false ? 'checked' : ''}> <span>Active <small class="muted">– untick to retire (hidden, history kept)</small></span></label>`}
    <p class="err" id="ed-err" hidden></p>
    <div class="row-btns"><button type="button" class="ghost" id="ed-cancel">Cancel</button><button class="primary" id="ed-save">${isNew ? 'Add task' : 'Save'}</button></div></form>`;
  const f = $('#edit-form', d), err = $('#ed-err', d);
  $('#ed-x', d).onclick = $('#ed-cancel', d).onclick = () => d.close();
  f.onsubmit = async (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(f)); const nn = (x) => (String(x ?? '').trim() || null);
    const fail = (m) => { err.textContent = m; err.hidden = false; };
    if (!nn(v.name) || !nn(v.room)) return fail('Task and room are both needed.');
    const eff = nn(v.effort_min) == null ? null : Math.round(Number(v.effort_min));
    if (eff != null && !(eff >= 0 && eff <= 1440)) return fail('Effort must be 0–1440 minutes.');
    const newLast = nn(v.last_done);
    if (newLast && newLast > localToday()) return fail('Last done can’t be in the future.');
    const [days, months] = FREQUENCIES[v.frequency];
    const row = { name: nn(v.name), room: nn(v.room), frequency: v.frequency, interval_days: days, interval_months: months, effort_min: eff,
      priority: v.priority, last_done: nn(v.last_done), notes: nn(v.notes), supplies: nn(v.supplies), season: nn(v.season),
      due_weekday: nn(v.due_weekday), planned_date: nn(v.planned_date), stagger_date: nn(v.stagger_date) };
    if (!isNew) row.active = !!v.active;
    // editing Last done replaces it: drop ticks after the new date (all of them when cleared) so it actually takes effect
    const lastChanged = !isNew && newLast !== shownLast;
    if (!isNew && !lastChanged) delete row.last_done;   // untouched: keep the typed value as it is
    const drop = lastChanged ? state.db.completions.filter((c) => c.task_id === t.id && (newLast == null || c.done_on > newLast)) : [];
    if (lastChanged && newLast == null && drop.length && !confirm(`Clear Last done? This also removes ${drop.length} tick${drop.length > 1 ? 's' : ''} from the history.`)) return;
    try {
      if (isNew) {
        row.sort_key = Math.max(0, ...db.tasks.map((x) => x.sort_key || 0)) + 1; row.source = 'app';
        await be.addTask(row);
      } else {
        await be.updateTask(t.id, row);
        for (const c of drop) await be.removeCompletion(c.id);
      }
    } catch (ex) { return fail(ex.message); }
    d.close(); await refresh().catch(() => {});
    if (isNew) toast(`Added “${row.name}”`);
    else if (t.active !== false && row.active === false) toast(`Retired “${row.name}” – hidden from lists`, async () => { await be.updateTask(t.id, { active: true }); await refresh(); });
    else toast('Saved');
  };
  d.showModal(); d.scrollTop = 0;
}
// tap outside a sheet closes it
document.querySelectorAll('dialog.sheet').forEach((d) => d.addEventListener('click', (e) => {
  if (e.target !== d) return; const r = d.getBoundingClientRect();
  if (e.clientY < r.top || e.clientY > r.bottom || e.clientX < r.left || e.clientX > r.right) d.close();
}));

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
  if (longPressed) { longPressed = false; return; }
  const b = e.target.closest('button');
  if (!b) { const host = e.target.closest('.body')?.closest('[data-id],[data-tid]'); if (host) openTask(host.dataset.id || host.dataset.tid); return; }
  if (b.dataset.add !== undefined) return openEdit(null);
  if (b.dataset.settings !== undefined) return openSettings();
  if (b.dataset.awayDel) return deleteAway(b.dataset.awayDel);
  if (b.dataset.unsnooze) { const t = state.db.tasks.find((x) => x.id === b.dataset.unsnooze); return t && setSnooze(t, null); }
  if (b.dataset.filter) { state.filter = b.dataset.filter; localStorage.setItem('chores.filter', state.filter); return render(); }
  if (b.dataset.group) { state.group = b.dataset.group; localStorage.setItem('chores.group', state.group); return render(); }
  if (b.dataset.week) { state.next = b.dataset.week === 'next'; return render(); }
  if (b.dataset.undo) return undoCompletion(b.dataset.undo);
  if (b.dataset.cu) return toggleCatchup(b.dataset.cu);
  const t = taskOf(b); if (!t) return;
  if (b.dataset.act === 'done') { b.classList.add('done'); return markDone(t.id, localToday(), t.name); }
  if (b.dataset.act === 'date') return pickDate(t);
});
document.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => { state.tab = b.dataset.tab; $('#toast').hidden = true; render(); scrollTo(0, 0); }));
$('#account').onclick = () => openSettings();

(async () => {
  try {
    const ok = await be.init();
    if (!ok) return renderLogin();
    let rt; be.onChange(() => { clearTimeout(rt); rt = setTimeout(() => refresh().catch(console.error), 250); });
    // phones drop the realtime socket in the background and the date may have changed: reload when shown again
    document.addEventListener('visibilitychange', () => { if (!document.hidden && state.db) refresh().catch(console.error); });
    await refresh();
  } catch (err) { $('#view').innerHTML = `<div class="card">Couldn't load: ${esc(err.message)}</div>`; console.error(err); }
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((r) => r.update()).catch(() => {});
})();
