// Data layer with two interchangeable backends:
//   MockBackend      - localStorage, seeded from data/seed.json (works offline, no account)
//   SupabaseBackend  - supabase-js v2 from a CDN, email magic-link auth, RLS-protected tables
// Both expose: init(), user, signIn(email), signOut(), load() -> {tasks, completions, catchup, settings, away},
//              addCompletion(taskId, doneOn, source), removeCompletion(id), setCatchupDone(id, doneOn|null),
//              addTask(task), updateTask(id, patch), addAway(start, end), removeAway(id), onChange(cb)
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2));

export class MockBackend {
  constructor(key = 'chores.mock.v1') { this.key = key; this.kind = 'mock'; this.user = { email: 'local mock (this device only)' }; this.cbs = []; }
  async init() {
    const raw = localStorage.getItem(this.key);
    if (raw) this.db = JSON.parse(raw);
    else {
      const seed = await (await fetch(new URL('../data/seed.json', import.meta.url))).json();
      this.db = { tasks: seed.tasks, completions: seed.completions, catchup: seed.catchup, settings: { cap_min: seed.cap_min }, away: [] };
      this.save();
    }
    this.db.away ||= [];
    window.addEventListener('storage', (e) => { if (e.key === this.key) { this.db = JSON.parse(e.newValue); this.cbs.forEach((f) => f()); } });
    return true;
  }
  save() { localStorage.setItem(this.key, JSON.stringify(this.db)); }
  async signIn() {} async signOut() {}
  async load() { return structuredClone(this.db); }
  async addCompletion(task_id, done_on, source = 'app', note = null) {
    const c = { id: uid(), task_id, done_on, note, source, created_at: new Date().toISOString() };
    this.db.completions.push(c); this.save(); return c;
  }
  async removeCompletion(id) { this.db.completions = this.db.completions.filter((c) => c.id !== id); this.save(); }
  async setCatchupDone(id, done_on) { const i = this.db.catchup.find((x) => x.id === id); if (i) i.done_on = done_on; this.save(); }
  async addTask(task) {
    if (this.db.tasks.some((t) => t.room === task.room && t.name === task.name)) throw new Error(`There is already a task “${task.name}” in ${task.room}.`);
    const t = { id: uid(), active: true, created_at: new Date().toISOString(), ...task }; this.db.tasks.push(t); this.save(); return t;
  }
  async updateTask(id, patch) {
    const t = this.db.tasks.find((x) => x.id === id); if (!t) throw new Error('Task not found');
    if ((patch.room || patch.name) && this.db.tasks.some((x) => x.id !== id && x.room === (patch.room ?? t.room) && x.name === (patch.name ?? t.name))) throw new Error('Another task in that room already has that name.');
    Object.assign(t, patch, { updated_at: new Date().toISOString() }); this.save(); return t;
  }
  async addAway(start_date, end_date) { const a = { id: uid(), start_date, end_date, created_at: new Date().toISOString() }; this.db.away.push(a); this.save(); return a; }
  async removeAway(id) { this.db.away = this.db.away.filter((a) => a.id !== id); this.save(); }
  onChange(cb) { this.cbs.push(cb); }
  reset() { localStorage.removeItem(this.key); }
}

export class SupabaseBackend {
  constructor(url, anonKey) { this.url = url; this.anonKey = anonKey; this.kind = 'supabase'; this.user = null; }
  async init() {
    const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
    this.sb = createClient(this.url, this.anonKey, { auth: { persistSession: true, detectSessionInUrl: true, flowType: 'pkce' } });
    // also accept links that carry tokens in the #hash (e.g. a sign-in link made by the assistant)
    const h = new URLSearchParams(location.hash.slice(1));
    if (h.get('access_token') && h.get('refresh_token')) {
      await this.sb.auth.setSession({ access_token: h.get('access_token'), refresh_token: h.get('refresh_token') });
      history.replaceState(null, '', location.pathname + location.search);
    }
    const { data } = await this.sb.auth.getSession();
    this.user = data.session?.user || null;
    this.sb.auth.onAuthStateChange((_e, s) => { const was = !!this.user; this.user = s?.user || null; if (was !== !!this.user) location.reload(); });
    return !!this.user;
  }
  async signIn(email) {
    const redirect = location.origin + location.pathname;
    const { error } = await this.sb.auth.signInWithOtp({ email, options: { emailRedirectTo: redirect, shouldCreateUser: true } });
    if (error) throw error;
  }
  async signOut() { await this.sb.auth.signOut(); }
  async q(p) { const { data, error } = await p; if (error) throw error; return data; }
  async load() {
    const [tasks, completions, catchup, settings] = await Promise.all([
      this.q(this.sb.from('tasks').select('*').order('sort_key')),
      this.q(this.sb.from('completions').select('*').order('done_on')),
      this.q(this.sb.from('catchup_items').select('*').order('position')),
      this.q(this.sb.from('settings').select('*').maybeSingle()),
    ]);
    // away_periods arrives with migration 002 - until it is applied, treat as "not away"
    const away = await this.q(this.sb.from('away_periods').select('*').order('start_date')).catch(() => []);
    return { tasks, completions, catchup, settings: settings || {}, away };
  }
  // columns added by migration 002; if it isn't applied yet, retry without them so the rest still saves
  async withNewCols(row, fn) {
    try { return await this.q(fn(row)); } catch (err) {
      const missing = /snooze_until|supplies/.test(err.message || '') && /column|schema cache/i.test(err.message || '');
      if (!missing) throw /duplicate key|unique/i.test(err.message || '') ? new Error('Another task in that room already has that name.') : err;
      const { snooze_until, supplies, ...rest } = row;
      if (!Object.keys(rest).length) throw new Error('This needs the database update (supabase/migrations/002_features.sql).');
      return this.q(fn(rest));
    }
  }
  async addTask(task) {
    const row = { id: crypto.randomUUID(), owner_id: this.user?.id, active: true, ...task };
    return this.withNewCols(row, (r) => this.sb.from('tasks').insert(r).select().single());
  }
  async updateTask(id, patch) { return this.withNewCols(patch, (r) => this.sb.from('tasks').update(r).eq('id', id).select().single()); }
  async addAway(start_date, end_date) {
    try { return await this.q(this.sb.from('away_periods').insert({ owner_id: this.user?.id, start_date, end_date }).select().single()); }
    catch (err) { throw /away_periods|schema cache|relation/i.test(err.message || '') ? new Error('Away mode needs the database update (supabase/migrations/002_features.sql).') : err; }
  }
  async removeAway(id) { await this.q(this.sb.from('away_periods').delete().eq('id', id)); }
  async addCompletion(task_id, done_on, source = 'app', note = null) {
    return this.q(this.sb.from('completions').insert({ task_id, done_on, source, note }).select().single());
  }
  async removeCompletion(id) { await this.q(this.sb.from('completions').delete().eq('id', id)); }
  async setCatchupDone(id, done_on) { await this.q(this.sb.from('catchup_items').update({ done_on }).eq('id', id)); }
  onChange(cb) {
    this.sb.channel('chores').on('postgres_changes', { event: '*', schema: 'public' }, () => cb()).subscribe();
  }
}

export function makeBackend(cfg = window.CHORES_CONFIG || {}) {
  const filled = cfg.supabaseUrl && !cfg.supabaseUrl.includes('YOUR-') && cfg.supabaseAnonKey && !cfg.supabaseAnonKey.includes('YOUR-');
  const mode = new URLSearchParams(location.search).get('backend') || cfg.backend || 'auto';
  if (mode === 'supabase' || (mode === 'auto' && filled)) return new SupabaseBackend(cfg.supabaseUrl, cfg.supabaseAnonKey);
  return new MockBackend();
}
