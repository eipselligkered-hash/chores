// Minimal stand-in for Supabase's PostgREST (just what the CLI uses): GET with select/eq/order, POST insert, PATCH/DELETE ?id=eq.
import http from 'node:http';
export function startFake(db, key = 'test-service-key', { noMinutes = false } = {}) {
  const log = [];
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x'); const m = u.pathname.match(/^\/rest\/v1\/(\w+)$/);
    log.push(`${req.method} ${u.pathname}${u.search}`);
    if (req.headers.apikey !== key || req.headers.authorization !== `Bearer ${key}`) { res.writeHead(401); return res.end('{"message":"bad key"}'); }
    if (!m || !db[m[1]]) { res.writeHead(404); return res.end('{}'); }
    const table = db[m[1]];
    const filt = [...u.searchParams].filter(([k]) => !['select', 'order'].includes(k));
    const pass = (row) => filt.every(([k, v]) => { const [op, val] = [v.slice(0, v.indexOf('.')), v.slice(v.indexOf('.') + 1)]; return op === 'eq' && String(row[k]) === val; });
    let body = ''; for await (const ch of req) body += ch;
    if (req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(table.filter(pass))); }
    if (noMinutes && m[1] === 'completions' && /"minutes"/.test(body)) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ code: 'PGRST204', message: "Could not find the 'minutes' column of 'completions' in the schema cache" })); }
    if (req.method === 'POST') {
      const rows = [].concat(JSON.parse(body)).map((r) => {
        if (!r.owner_id) throw new Error('owner_id required (not-null)');
        return { id: `srv-${table.length + 1}`, created_at: new Date().toISOString(), ...r };
      });
      table.push(...rows); res.writeHead(201, { 'Content-Type': 'application/json' });
      return res.end(req.headers.prefer?.includes('return=representation') ? JSON.stringify(rows) : '');
    }
    if (req.method === 'PATCH') { const patch = JSON.parse(body); table.filter(pass).forEach((r) => Object.assign(r, patch)); res.writeHead(204); return res.end(); }
    if (req.method === 'DELETE') { db[m[1]] = table.filter((r) => !pass(r)); res.writeHead(204); return res.end(); }
    res.writeHead(405); res.end();
  });
  return new Promise((ok) => srv.listen(0, () => ok({ url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close(), log, db })));
}
