#!/usr/bin/env python3
"""Export the master workbook (Apartment_Tasks.xlsx) to data/seed.json and supabase/seed.sql.

Reads only the *input* cells (Last done typed, Frequency, Priority, Effort, Planned/Stagger date, Due weekday,
Season, Notes, plan-text helpers), the Done log and the Catch-up sheet. Everything else (Next due, Status,
This Weekend) is recomputed by src/schedule.js.

usage: python3 scripts/export_seed.py [WORKBOOK] [--json data/seed.json] [--sql supabase/seed.sql]
"""
import sys, json, uuid, datetime as dt, argparse, openpyxl

NS = uuid.UUID("6f1c2f0e-4c1e-4d7a-9a51-0c0ffee00001")   # stable ids -> seed.json and seed.sql agree
FREQ = {"Daily": (1, 0), "Weekly": (7, 0), "Fortnightly": (14, 0), "Monthly": (30, 1), "Every 2 months": (60, 2),
        "Quarterly": (91, 3), "Half-yearly": (182, 6), "Yearly": (365, 12)}

# Supplies ("You'll need") for the obvious tasks - not in the workbook; also applied by supabase/migrations/002_features.sql
SUPPLIES = {
    ("Kitchen", "Clean hood above stove"): "Degreaser",
    ("Kitchen", "Descale kettle & coffee maker"): "Descaler or citric acid",
    ("Kitchen", "Dishwasher: clean, salt & rinse aid"): "Dishwasher salt, Rinse aid, Dishwasher cleaner",
    ("Kitchen", "Replace Scrub Daddy sponge"): "Scrub Daddy sponge",
    ("Kitchen", "Clean oven"): "Oven cleaner",
    ("Bathroom", "Mop & disinfect floor"): "Floor disinfectant",
    ("Ensuite", "Mop & disinfect floor"): "Floor disinfectant",
    ("Bathroom", "Tiles - Mold prevention"): "Mould spray",
    ("Ensuite", "Tiles - Mold prevention"): "Mould spray",
    ("Bathroom", "Tiles - Descale & check bath/shower sealant"): "Bathroom descaler",
    ("Ensuite", "Tiles - Descale & check bath/shower sealant"): "Bathroom descaler",
    ("Bathroom", "Change toothbrushes (bathroom & ensuite)"): "New toothbrushes / brush heads",
    ("Laundry", "Clean washing machine (hot cycle, door seal, detergent drawer, filter)"): "Washing machine cleaner",
    ("General", "Air purifiers (x2): replace U97 H-Trifilter (HEPA H13 + carbon)"): "2 x Hoover U97 H-Trifilter (part 35602347)",
    ("General", "Smoke detectors: check/replace batteries & check first-aid kit (expiry dates)"): "Smoke alarm batteries (9V or AA - check each alarm), First-aid kit top-up",
    ("General", "Clean radiators (dust behind & between fins)"): "Radiator brush",
    ("General", "Feed plants"): "Plant feed",
    ("Storage room/closet", "Check boiler pressure (1–1.5 bar cold) & bleed radiators"): "Radiator bleed key",
    ("Entrance", "Polish shoes"): "Shoe polish",
}

def d(v):
    if v is None or v == "": return None
    if isinstance(v, dt.datetime): v = v.date()
    if isinstance(v, dt.date): return v.isoformat()
    raise ValueError(f"not a date: {v!r}")

def export(path):
    wb = openpyxl.load_workbook(path)           # formulas; we only read literal input cells
    ws = wb["All Tasks"]
    hdr = {c.value: i for i, c in enumerate(ws[1])}
    g = lambda r, h: r[hdr[h]].value
    tasks, by_log = [], {}
    for r in ws.iter_rows(min_row=2):
        name = g(r, "Task")
        if not name or str(name).startswith("="): continue
        room = g(r, "Room"); freq = g(r, "Frequency")
        tid = str(uuid.uuid5(NS, f"{room}|{name}"))
        days, months = FREQ[freq]
        t = dict(id=tid, room=room, name=name, frequency=freq, interval_days=days, interval_months=months,
                 last_done=d(g(r, "Last done (typed)")), planned_date=d(g(r, "Planned date")),
                 stagger_date=d(g(r, "Stagger date (one-off)")), due_weekday=g(r, "Due weekday (override)"),
                 season=g(r, "Season"), priority=g(r, "Priority"), effort_min=g(r, "Effort (min)"),
                 notes=g(r, "Notes"), active=True, sort_key=r[0].row,
                 plan_text=g(r, "Plan text (helper)"), plan_date=d(g(r, "Plan date (helper)")),
                 source=g(r, "Source"), history=g(r, "History"),
                 supplies=SUPPLIES.get((room, name)), snooze_until=None)
        tasks.append(t); by_log[f"{room}: {name}"] = tid
    comps = []
    dl = wb["Done log"]
    for r in dl.iter_rows(min_row=5, max_col=3, values_only=True):
        if r[0] is None or not r[1]: continue
        tid = by_log.get(r[1])
        if not tid: print("WARN done log task not found:", r[1], file=sys.stderr); continue
        comps.append(dict(id=str(uuid.uuid5(NS, f"log|{r[1]}|{d(r[0])}|{len(comps)}")), task_id=tid, done_on=d(r[0]), note=r[2], source="workbook"))
    cu = wb["Catch-up 23-27 Oct"]; cat = []
    by_rt = {(t["room"], t["name"]): t["id"] for t in tasks}
    for i, r in enumerate(cu.iter_rows(min_row=13, max_col=8, values_only=True)):
        if not r[0]: continue
        day, ddate, kind, room, task, note, mins, done = r
        tid = by_rt[(room, task)]
        last = next(t["last_done"] for t in tasks if t["id"] == tid)
        cat.append(dict(id=str(uuid.uuid5(NS, f"cu|{i}|{room}|{task}")), task_id=tid, day_label=day, day_date=d(ddate), kind=kind,
                        minutes=mins, note=note, position=i + 1, done_on=(last if done == "\u2713" else None)))
    cap = wb["This Weekend"]["B2"].value or 300
    return dict(source=path, exported_at=dt.datetime.now().isoformat(timespec="seconds"), cap_min=cap,
                tasks=tasks, completions=comps, catchup=cat)

def q(v):
    if v is None: return "null"
    if isinstance(v, bool): return "true" if v else "false"
    if isinstance(v, (int, float)): return str(v)
    return "'" + str(v).replace("'", "''") + "'"

def to_sql(seed):
    out = ["-- Generated by scripts/export_seed.py. Run AFTER schema.sql and AFTER you have signed in to the app once,",
           "-- so your user exists in auth.users. Replace YOUR_EMAIL below (one place).",
           "begin;",
           "create temp table _me on commit drop as select id from auth.users where email = 'YOUR_EMAIL';",
           "do $$ begin if (select count(*) from _me) <> 1 then raise exception 'Set YOUR_EMAIL to the address you signed in with'; end if; end $$;",
           f"insert into public.settings (owner_id, cap_min) select id, {seed['cap_min']} from _me on conflict (owner_id) do update set cap_min = excluded.cap_min;"]
    cols = ["id","room","name","frequency","interval_days","interval_months","last_done","planned_date","stagger_date","due_weekday",
            "season","priority","effort_min","notes","active","sort_key","plan_text","plan_date","source","history","supplies"]
    for t in seed["tasks"]:
        out.append(f"insert into public.tasks (owner_id,{','.join(cols)}) select id,{','.join(q(t[c]) for c in cols)} from _me;")
    for c in seed["completions"]:
        out.append(f"insert into public.completions (owner_id,id,task_id,done_on,note,source) select id,{q(c['id'])},{q(c['task_id'])},{q(c['done_on'])},{q(c['note'])},{q(c['source'])} from _me;")
    cc = ["id","task_id","day_label","day_date","kind","minutes","note","position","done_on"]
    for c in seed["catchup"]:
        out.append(f"insert into public.catchup_items (owner_id,{','.join(cc)}) select id,{','.join(q(c[k]) for k in cc)} from _me;")
    out.append("commit;")
    return "\n".join(out) + "\n"

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("workbook", nargs="?", default="/workspace/apartment/Apartment_Tasks.xlsx")
    ap.add_argument("--json", default="data/seed.json"); ap.add_argument("--sql", default="supabase/seed.sql")
    a = ap.parse_args()
    s = export(a.workbook)
    json.dump(s, open(a.json, "w"), indent=1, ensure_ascii=False)
    if a.sql: open(a.sql, "w").write(to_sql(s))
    print(f"{len(s['tasks'])} tasks, {len(s['completions'])} completions, {len(s['catchup'])} catch-up items -> {a.json}, {a.sql}")
