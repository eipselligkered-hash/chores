"""v12/v13 smoke test against a FAKE Supabase (no network, no real data): email-code sign-in, cached data + 'updating…',
paused-database message + Retry, offline open via the service worker, offline tick shows an error, backup download.
usage: (python3 -m http.server 8765 &) ; /workspace/.venv-pw/bin/python tests/smoke_supabase.py [base_url]"""
import sys, os, json, time, base64, re
os.environ.setdefault("PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS", "1")   # let routes see service-worker fetches
from playwright.sync_api import sync_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8765/"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "screenshots")
SEED = json.load(open(os.path.join(ROOT, "data/seed.json")))
FAKE = "https://fakeproj.supabase.co"
UID, EMAIL = "00000000-0000-0000-0000-0000000000aa", "me@example.com"
CONFIG = f"window.CHORES_CONFIG={{backend:'supabase',supabaseUrl:'{FAKE}',supabaseAnonKey:'anon-test-key',cap:300}};"
results = []
def ok(name, cond): results.append((name, bool(cond))); print(("PASS " if cond else "FAIL ") + name)
b64 = lambda d: base64.urlsafe_b64encode(json.dumps(d).encode()).decode().rstrip("=")
def jwt():
    now = int(time.time())
    return f"{b64({'alg':'HS256','typ':'JWT'})}.{b64({'sub':UID,'email':EMAIL,'role':'authenticated','aud':'authenticated','exp':now+3600,'iat':now})}.c2ln"
USER = {"id": UID, "email": EMAIL, "aud": "authenticated", "role": "authenticated", "app_metadata": {}, "user_metadata": {}, "created_at": "2026-10-01T00:00:00Z"}
state = {"paused": False, "verify": 0, "otp": 0, "minutes_col": False}   # minutes_col: migration 003 applied?
DB = {"tasks": [dict(t, owner_id=UID) for t in SEED["tasks"]], "completions": [], "catchup_items": [dict(c, owner_id=UID) for c in SEED["catchup"]],
      "settings": [{"owner_id": UID, "cap_min": 300}], "away_periods": []}
def fake(route):
    req = route.request; path = req.url.split(FAKE, 1)[1]
    hdr = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*", "Content-Type": "application/json"}
    if req.method == "OPTIONS": return route.fulfill(status=200, headers=hdr, body="")
    if state["paused"]: return route.abort("failed")
    if path.startswith("/auth/v1/otp"): state["otp"] += 1; return route.fulfill(status=200, headers=hdr, body="{}")
    if path.startswith("/auth/v1/verify"):
        state["verify"] += 1; body = json.loads(req.post_data or "{}")
        if body.get("token") != "123456": return route.fulfill(status=403, headers=hdr, body=json.dumps({"code": 403, "error_code": "otp_expired", "msg": "Token has expired or is invalid"}))
        return route.fulfill(status=200, headers=hdr, body=json.dumps({"access_token": jwt(), "token_type": "bearer", "expires_in": 3600, "expires_at": int(time.time()) + 3600, "refresh_token": "rt", "user": USER}))
    if path.startswith("/auth/v1/user"): return route.fulfill(status=200, headers=hdr, body=json.dumps(USER))
    if path.startswith("/auth/v1/token"): return route.fulfill(status=200, headers=hdr, body=json.dumps({"access_token": jwt(), "token_type": "bearer", "expires_in": 3600, "refresh_token": "rt2", "user": USER}))
    if path.startswith("/auth/v1/logout"): return route.fulfill(status=204, headers=hdr, body="")
    m = re.match(r"/rest/v1/(\w+)", path)
    if m:
        t = m.group(1); rows = DB.get(t, [])
        if t == "completions" and not state["minutes_col"] and ("minutes" in path or '"minutes"' in (req.post_data or "")):
            return route.fulfill(status=400, headers=hdr, body=json.dumps({"code": "42703", "message": "column completions.minutes does not exist"}))
        if req.method == "GET":
            single = "vnd.pgrst.object" in (req.headers.get("accept") or "")
            return route.fulfill(status=200, headers=hdr, body=json.dumps((rows[0] if rows else None) if single else rows))
        if req.method == "POST":
            row = json.loads(req.post_data); row = row[0] if isinstance(row, list) else row
            row.setdefault("id", f"c-{len(rows)+1}"); row.setdefault("created_at", "2026-11-06T10:00:00Z"); rows.append(row)
            return route.fulfill(status=201, headers=hdr, body=json.dumps(row if "vnd.pgrst.object" in (req.headers.get("accept") or "") else [row]))
        return route.fulfill(status=200, headers=hdr, body="[]")
    return route.fulfill(status=404, headers=hdr, body="{}")

with sync_playwright() as p:
    br = p.chromium.launch(executable_path="/usr/bin/google-chrome", headless=True)
    ctx = br.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True, locale="en-IE", accept_downloads=True)
    ctx.route("**/config.js*", lambda r: r.fulfill(status=200, content_type="application/javascript", body=CONFIG))
    ctx.route(FAKE + "/**", fake)
    ctx.route("wss://fakeproj.supabase.co/**", lambda r: r.abort())
    pg = ctx.new_page(); errors = []
    pg.on("pageerror", lambda e: errors.append(str(e) + " @ " + (e.stack or "")[:300])); pg.on("dialog", lambda d: d.accept())
    pg.goto(BASE + "?today=2026-11-06"); pg.wait_for_selector("#login")
    ok("sign-in screen", "Send sign-in email" in pg.inner_text("#view") and pg.locator("#code").count() == 0)
    pg.fill("#email", EMAIL); pg.click("#login button"); pg.wait_for_selector("#code")
    ok("after sending: code field + link hint", state["otp"] == 1 and "open the link" in pg.inner_text("#view"))
    pg.screenshot(path=f"{OUT}/signin_code.png")
    pg.fill("#code", "000000"); pg.click("#code-form button"); pg.wait_for_selector(".login .err")
    ok("wrong code: clear message", "wrong or has expired" in pg.inner_text(".login .err"))
    pg.fill("#code", "123456"); pg.click("#code-form button")
    pg.wait_for_selector(".cap", timeout=15000)
    ok("right code signs in and loads the chores", "v13" in pg.inner_text("#today") and pg.locator(".item[data-id]").count() > 0)
    pg.locator(".item[data-id] .tick").first.tap(); pg.wait_for_selector("#toast:not([hidden])")
    ok("before migration 003: tick works, no minutes input", "done" in pg.inner_text("#toast") and pg.locator("#took-min").count() == 0 and len(DB["completions"]) == 1)
    key = f"chores.cache.v1.{UID}"
    ok("last data cached on the device", pg.evaluate(f"!!localStorage.getItem('{key}')"))
    # backup
    pg.click("#account"); pg.wait_for_selector("#settings[open]")
    pg.screenshot(path=f"{OUT}/settings_backup.png")
    with pg.expect_download() as dl: pg.click("#backup")
    d = dl.value; path = d.path(); data = json.load(open(path))
    ok(f"backup file {d.suggested_filename}", re.match(r"chores-backup-\d{4}-\d{2}-\d{2}\.json$", d.suggested_filename) and len(data["tasks"]) == 123
       and all(k in data for k in ["completions", "away_periods", "catchup_items"]) and data["account"] == EMAIL)
    pg.keyboard.press("Escape")
    # paused database, with cached data: data stays visible + banner; Retry recovers
    state["paused"] = True
    pg.reload(); pg.wait_for_selector(".banner.conn", timeout=15000)
    ok("paused + cache: cached chores still shown with the message", pg.locator(".item[data-id]").count() > 0 and "may be paused" in pg.inner_text(".banner.conn"))
    ok("message links to the Supabase project", pg.locator(".banner.conn a[href='https://supabase.com/dashboard/project/rwbiizjwvyssdyxjuqan']").count() == 1)
    pg.locator(".item[data-id] .tick").first.tap(); pg.wait_for_timeout(600)
    ok("tick while unreachable: clear error, not shown as saved", "not saved" in pg.inner_text("#toast") and pg.locator(".item[data-id] .tick.done").count() == 0)
    # paused, nothing cached: full message
    pg.evaluate(f"localStorage.removeItem('{key}')"); pg.reload(); pg.wait_for_selector(".conn-card", timeout=15000)
    ok("paused, no cache: friendly message + Retry", "Can't reach your chores database" in pg.inner_text(".conn-card") and pg.locator(".conn-card [data-retry]").count() == 1)
    pg.screenshot(path=f"{OUT}/database_paused.png")
    state["paused"] = False
    pg.click(".conn-card [data-retry]"); pg.wait_for_selector(".cap", timeout=15000)
    ok("Retry loads once the database is back", pg.locator(".item[data-id]").count() > 0 and pg.locator(".banner.conn").count() == 0)
    # offline: the service worker serves the app shell + vendored supabase-js; cached data shows
    pg.goto(BASE + "?today=2026-11-06"); pg.wait_for_selector(".cap")
    pg.wait_for_function("navigator.serviceWorker && navigator.serviceWorker.controller !== null", timeout=15000)
    pg.reload(); pg.wait_for_selector(".cap"); pg.wait_for_timeout(500)
    ctx.set_offline(True); state["paused"] = True   # routes ignore set_offline, so the fake API goes away too
    pg.reload(); pg.wait_for_selector(".item[data-id]", timeout=20000); pg.wait_for_timeout(800)
    ok("opens offline from the service worker with saved data", pg.locator(".item[data-id]").count() > 0)
    ok("offline banner", "offline" in pg.inner_text("#view").lower())
    pg.locator(".item[data-id] .tick").first.tap(); pg.wait_for_timeout(800)
    ok("offline tick: clear error", "not saved" in pg.inner_text("#toast"))
    pg.screenshot(path="/tmp/offline.png")
    ctx.set_offline(False); state["paused"] = False
    br.close()
ok(f"no page errors {errors}", not errors)
print(f"{sum(r for _, r in results)}/{len(results)} supabase smoke checks passed")
