#!/usr/bin/env python3
"""Build app/index.html from demo/index.html + app/live.js (docs/SPEC.md section 14).
The demo's simulated parts (sign-in dialog, simulated queue, static boot) are switched off and the live layer
(Supabase auth, data, jobs, rates, labelling, admin) is appended. The project URL and publishable key come
from .env (publishable keys are designed to be public; row-level security protects the data).
Usage: python3 tools/build_app.py   -> app/index.html, app/data/demo.json (static reference parts)"""
import json, os, re, shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
env = dict(l.strip().split("=", 1) for l in open(os.path.join(ROOT, ".env")) if "=" in l)
url, key = env["VITE_SUPABASE_URL"], env["VITE_SUPABASE_ANON_KEY"]
assert key.startswith("sb_publishable_"), "use the publishable key (not a secret or legacy key)"
s = open(os.path.join(ROOT, "demo", "index.html"), encoding="utf-8").read()

REPL = [
    ('<span class="badge" title="Static demo: no database, no real sign-in">Static demo</span>', '<span class="badge" style="background:var(--ok-bg);color:var(--ok)">Live</span>'),
    ('<a class="small" href="../" title="The live app, with Google sign-in">Live app</a>\n', ''),
    ('$("#signin").addEventListener("click", () => { if (user) { user = null; store.set("user", "null"); render(); } else $("#signin-dlg").showModal(); });', '/* live: sign-in handled by live.js */'),
    ('if (t.id === "queue") {', 'if (t.id === "queue-sim") {'),
    ("<title>Explore NZ Suburb Water</title>", "<title>NZ Suburb Water Profiles</title>"),
    ('<tr><td>Status</td><td><span class="tag ok">published</span></td></tr>', '<tr><td>Status</td><td>${g.status === "published" ? \'<span class="tag ok">published</span>\' : `<span class="tag warn">${esc(g.status || "draft")}</span>`}</td></tr>'),
    ('app: "explore-nz-suburb-water demo"', 'app: "NZ Suburb Water Profiles (live)"'),
    ('<span class="brand">Explore NZ Suburb Water</span>', '<span class="brand">NZ Suburb Water Profiles</span>'),
    # regions are loaded on demand: keep a region that is known (index) but not loaded yet
    ('  if (!D.regions[region]) region = Object.keys(D.regions)[0];\n  if (!V[stage]) stage = "region";', '  if (!D.regions[region] && !(D.index || []).some((r) => r.id === region)) region = Object.keys(D.regions)[0] || ((D.index || [])[0] || {}).id;\n  if (!V[stage]) stage = "region";'),
    ('  $("#region").innerHTML = Object.entries(D.regions).map(([k, g]) => `<option value="${k}" ${k === region ? "selected" : ""}>${esc(g.label)}</option>`).join("");',
     '  $("#region").innerHTML = (D.index || Object.entries(D.regions).map(([id, g]) => ({ id, name: g.label }))).map((r) => `<option value="${r.id}" ${r.id === region ? "selected" : ""}>${esc(r.name)}${D.regions[r.id] ? "" : " (not loaded)"}</option>`).join("");'),
]
for a, b in REPL:
    assert a in s, a[:70]
    s = s.replace(a, b, 1)
# the demo's simulated sign-in dialog close handler and static boot are not used
s = re.sub(r'\$\("#signin-dlg"\)\.addEventListener\("close".*?\n', "/* live: no simulated sign-in */\n", s, count=1)
boot = s.index('fetch("data/demo.json").then((r) => { if (!r.ok)')
end = s.index("</script>", boot)
s = s[:boot] + "/* live: boot is in live.js */\n" + s[end:]
s = re.sub(r'<meta name="description" content="[^"]*">', '<meta name="description" content="NZ Suburb Water Profiles: suburb-level data for residential water-demand analysis in Aotearoa New Zealand (pools, gardens, sections, census, climate, water charges).">', s, count=1)
s = s.replace('<main id="main"><p class="muted">Loading data…</p></main>', '<main id="main"><p class="muted">Checking sign-in…</p></main>')
live = "\n".join(open(os.path.join(ROOT, "app", f), encoding="utf-8").read() for f in ("live.js", "live_batch_ui.js", "live_map.js", "live_batch.js", "live_xlsx.js"))
inject = (f'<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.0/dist/umd/supabase.js"></script>\n'
          f'<script>\nconst SB_URL = {json.dumps(url)}, SB_KEY = {json.dumps(key)};\n{live}\n</script>\n</body>')
s = s.replace("</body>", inject, 1)
os.makedirs(os.path.join(ROOT, "app", "data"), exist_ok=True)
open(os.path.join(ROOT, "app", "index.html"), "w", encoding="utf-8").write(s)
# public static file: reference data only (no suburb results): NZ outlines, limits, source index, source plans
full = json.load(open(os.path.join(ROOT, "demo", "data", "demo.json")))
ref = dict(nz_regions=full["nz_regions"], limits=full["limits"], index_regions=full["index_regions"],
           regions={k: dict(lonlat=v.get("lonlat"), source_plan=v.get("source_plan"), provider=v.get("provider")) for k, v in full["regions"].items()})
json.dump(ref, open(os.path.join(ROOT, "app", "data", "demo.json"), "w"), separators=(",", ":"))
print("app/index.html", len(s) // 1024, "KB")
