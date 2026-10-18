"""Headless UI smoke test + phone-size screenshots (390x844). Needs: python -m http.server 8080 in the app folder,
playwright (pip) and Google Chrome. usage: python tests/smoke_ui.py [base_url]"""
import sys, os
from playwright.sync_api import sync_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8080/"
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "screenshots")
errors, results = [], []
def ok(name, cond): results.append((name, bool(cond))); print(("PASS " if cond else "FAIL ") + name)
with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True)
    ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True, locale="en-IE")
    pg = ctx.new_page()
    pg.on("console", lambda m: m.type == "error" and errors.append(m.text)); pg.on("pageerror", lambda e: errors.append(str(e)))
    # 1. real today (Sun 18 Oct): this weekend is empty, next weekend has the catch-up + routine
    pg.goto(BASE + "?today=2026-10-18"); pg.wait_for_selector(".seg")
    ok("this weekend empty on Sun 18/10", pg.locator(".card.empty").count() == 1)
    pg.click("text=Next weekend"); pg.wait_for_selector(".item[data-id]")
    n0 = pg.locator(".item[data-id]").count(); ok(f"next weekend lists tasks ({n0})", n0 > 20)
    ok("laundry routine section at top", pg.locator("h2.sec").first.inner_text().startswith("🧺 Laundry routine"))
    pg.screenshot(path=f"{OUT}/this_weekend.png", full_page=False)
    # 2. tap to mark done -> disappears, toast + undo
    first = pg.locator(".item[data-id] .name").first.inner_text()
    pg.locator(".item[data-id] .tick").first.tap(); pg.wait_for_selector("#toast:not([hidden])")
    ok("toast shown after tap", "done" in pg.inner_text("#toast"))
    ok("done task listed under Done recently", pg.locator(f"h2.sec:has-text('Done recently')").count() == 1)
    pg.click("#undo"); pg.wait_for_timeout(300)
    ok("undo restores the task", pg.locator(".item[data-id]").count() == n0 and pg.locator("h2.sec:has-text('Done recently')").count() == 0)
    # 3. secondary action: pick a date
    pg.locator(".item[data-id] .more").first.click(); pg.wait_for_selector("#sheet[open]")
    pg.fill("#sheet-date", "2026-10-17"); pg.click("#sheet-ok"); pg.wait_for_timeout(400)
    ok("pick-a-date logs completion", "Sat 17/10" in pg.inner_text("#toast"))
    # long-press opens the date sheet
    box = pg.locator(".item[data-id] .body").nth(2).bounding_box()
    pg.mouse.move(box["x"] + 20, box["y"] + 10); pg.mouse.down(); pg.wait_for_timeout(800); pg.mouse.up()
    ok("long-press opens date picker", pg.locator("#sheet[open]").count() == 1)
    pg.keyboard.press("Escape")
    # 4. All tasks
    pg.click("button[data-tab=all]"); pg.wait_for_selector("details.room")
    ok(f"all tasks: 15 rooms ({pg.locator('details.room').count()})", pg.locator("details.room").count() == 15)
    ok(f"all tasks: 123 rows ({pg.locator('details.room .item').count()})", pg.locator("details.room .item").count() == 123)
    for i in range(3): pg.locator("details.room").nth(i).evaluate("e => e.open = true")
    pg.screenshot(path=f"{OUT}/all_tasks.png", full_page=False)
    pg.fill("#q", "smoke"); pg.wait_for_timeout(200)
    ok("search filters", 0 < pg.locator("details.room .item").count() < 10)
    # 5. Catch-up
    pg.click("button[data-tab=catchup]"); pg.wait_for_selector("[data-cu]")
    ok("catch-up has 5 days", pg.locator("h2.sec").count() == 5)
    before = pg.locator(".tick.done[data-cu]").count(); pg.locator("[data-cu]:not(.done)").first.click(); pg.wait_for_timeout(300)
    ok("catch-up tick", pg.locator(".tick.done[data-cu]").count() == before + 1)
    pg.screenshot(path=f"{OUT}/catch_up.png")
    # 6. a busy weekend (Fri 6 Nov, nothing done): cap + carry over
    pg.evaluate("localStorage.clear()"); pg.goto(BASE + "?today=2026-11-06"); pg.wait_for_selector(".cap")
    ok("carry over section when over cap", pg.locator("h2.sec:has-text('Carry over')").count() == 1)
    pg.screenshot(path=f"{OUT}/busy_weekend_6nov.png")
    ok("manifest + service worker", pg.evaluate("navigator.serviceWorker.getRegistration().then(r => !!r)"))
    b.close()
ok(f"no console errors {errors}", not errors)
print(f"{sum(r for _, r in results)}/{len(results)} smoke checks passed")
