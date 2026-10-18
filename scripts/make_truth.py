#!/usr/bin/env python3
"""Ground truth for the schedule tests: for each scenario in tests/scenarios.json, copy the master workbook,
pin TODAY() to the scenario date, add its Done-log rows, recalculate with LibreOffice (headless) and dump
Next due / Status / Last done (effective) / Plan for every task plus the This Weekend table to tests/truth/<id>.json."""
import json, re, sys, os, shutil, subprocess, tempfile, datetime as dt, openpyxl
MASTER = sys.argv[1] if len(sys.argv) > 1 else "/workspace/apartment/Apartment_Tasks.xlsx"
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
SC = json.load(open(os.path.join(ROOT, "tests/scenarios.json")))
tmp = tempfile.mkdtemp(); inp = os.path.join(tmp, "in"); outd = os.path.join(tmp, "out"); os.makedirs(inp); os.makedirs(outd)
for s in SC:
    wb = openpyxl.load_workbook(MASTER)
    y, m, d = map(int, s["today"].split("-")); rep = f"DATE({y},{m},{d})"
    for ws in wb:
        for row in ws.iter_rows():
            for c in row:
                if isinstance(c.value, str) and "TODAY()" in c.value: c.value = c.value.replace("TODAY()", rep)
    dl = wb["Done log"]
    for i, (date, name) in enumerate(s["log"], start=5):
        dl.cell(i, 1, dt.date.fromisoformat(date)); dl.cell(i, 2, name)
    wb.save(os.path.join(inp, s["id"] + ".xlsx"))
subprocess.run(["soffice", "--headless", "--calc", "--convert-to", "xlsx", "--outdir", outd] + [os.path.join(inp, s["id"] + ".xlsx") for s in SC],
               check=True, capture_output=True, timeout=600)
iso = lambda v: v.date().isoformat() if isinstance(v, dt.datetime) else (v.isoformat() if isinstance(v, dt.date) else (v if v not in ("",) else None))
for s in SC:
    wb = openpyxl.load_workbook(os.path.join(outd, s["id"] + ".xlsx"), data_only=True)
    ws = wb["All Tasks"]; h = {c.value: i for i, c in enumerate(ws[1])}
    tasks = []
    for r in ws.iter_rows(min_row=2, values_only=True):
        if not r[h["Task"]]: continue
        tasks.append(dict(room=r[h["Room"]], name=r[h["Task"]], next_due=iso(r[h["Next due"]]), status=r[h["Status"]],
                          last_effective=iso(r[h["Last done (effective)"]]), plan=r[h["Plan"]] or ""))
    tw = wb["This Weekend"]; weekend = []
    for r in tw.iter_rows(min_row=8, values_only=True):
        if r[1] in (None, ""): break
        weekend.append(dict(room=r[1], name=r[2], plan=r[6] or "", effort=r[7], running=r[8], bucket=r[9]))
    errs = sum(1 for x in wb for row in x.iter_rows(values_only=True) for v in row if isinstance(v, str) and v.startswith("#"))
    json.dump(dict(id=s["id"], today=s["today"], week_end=iso(tw["B4"].value), cap=tw["B2"].value, errors=errs, tasks=tasks, weekend=weekend),
              open(os.path.join(ROOT, "tests/truth", s["id"] + ".json"), "w"), indent=1, ensure_ascii=False)
    print(s["id"], len(tasks), "tasks", len(weekend), "weekend rows", errs, "errors")
shutil.rmtree(tmp)
