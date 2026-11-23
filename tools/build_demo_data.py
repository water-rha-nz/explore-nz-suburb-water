# Pilot-workspace script (expects suburb_pilot/ outputs); kept here for reproducibility of demo/data. Ported in M2.
"""Build the static demo data bundle for explore-nz-suburb-water/demo from local pilot outputs.
Aggregate-only by design (spec section 10): no per-section pool or garden values, no imagery chips.
Writes demo/data/demo.json and demo/data/sections.json (public LINZ section sizes for the
nz_household_ref-compatible export)."""
import os, re, json, glob, math, numpy as np, pandas as pd, geopandas as gpd

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = "/workspace/explore-nz-suburb-water"
OUT = f"{REPO}/demo/data"; os.makedirs(OUT, exist_ok=True)
LOOKUP = "/workspace/nz_suburb_lookup"
from regions import REGIONS
from detect import classify

PROVIDER = {"taupo": "TDC", "tauranga": "TCC"}
rnd = lambda v, n=1: None if v is None or (isinstance(v, float) and math.isnan(v)) else round(float(v), n)


def coords(geom, tol):
    g = geom.simplify(tol, preserve_topology=True)
    polys = getattr(g, "geoms", [g])
    return [[[[round(x), round(y)] for x, y in p.exterior.coords]] for p in polys if p.area > 2000]


bundle = {"generated": pd.Timestamp.now().strftime("%Y-%m-%d"), "regions": {}, "water_rates": [], "nz_regions": None}

# water rates (from the reference builder's WATER constant)
src = open(f"{LOOKUP}/suburb_lookup.html", encoding="utf-8").read()
for code in ("TDC", "TCC"):
    i = src.find(f'prvd: "{code}"'); j = src.rfind("{ provider:", 0, i); k = src.find("checks:", i)
    blk = src[j:k]
    g = lambda pat: (re.search(pat, blk) or [None, None])[1]
    num = lambda v: None if v in (None, "null") else float(v)
    bundle["water_rates"].append(dict(PROVIDER=code, name=g(r'provider: "([^"]+)"'), CHARGING_TYPE=g(r'charging: "([^"]+)"'),
                                      FIXED_PA=num(g(r"fixed: ([\d.]+|null)")), VOLUMETRIC_PA=num(g(r"vol: ([\d.]+|null)")),
                                      THRESHOLD_Lpd=num(g(r"threshold: ([\d.]+|null)")), DATE_EST="2026-11-21",
                                      year=g(r'year: "([^"]+)"'), NOTE=g(r'note: "([^"]+)"'),
                                      source=g(r'u: "([^"]+)"')))

# NZ regional council outlines (overview map) from the reference builder
m = re.search(r"const REGIONS = (\{.*?\});\s*\n", src, re.S) or re.search(r"const REGIONS = (\[.*?\]);\s*\n", src, re.S)
try:
    bundle["nz_regions"] = json.loads(m.group(1)) if m else None
except ValueError:
    bundle["nz_regions"] = None

sections_export = []
for name, cfg in REGIONS.items():
    D = f"{HERE}/regions/{name}"
    sub = gpd.read_file(f"{D}/lds/suburbs.gpkg")
    sa2 = gpd.read_file(f"{D}/lds/sa2.gpkg")
    par = pd.read_csv(f"{D}/out/parcels_all.csv")
    sm = pd.read_csv(f"{D}/out/suburbs.csv").set_index("suburb")
    cs = pd.read_csv(f"{D}/out/census_suburb.csv")
    c2 = pd.read_csv(f"{D}/out/census_sa2.csv", dtype={"sa2": str})
    clm = pd.read_csv(f"{D}/out/climate_monthly.csv")
    cday = pd.read_csv(f"{D}/out/climate_daily.csv.gz")
    seas = pd.read_csv(f"{D}/out/climate_seasonal.csv")

    # ---- suburbs: outline + metadata (paper variables except DWU)
    subs = []
    for _, s in sub.iterrows():
        n = s["name"]; p = par[par.suburb == n]
        area_km2 = s.geometry.area / 1e6
        rec = dict(linz_id=int(s["id"]), name=n, type=s["type"], ta=s["territorial_authority"], area_km2=rnd(area_km2, 2),
                   geom=coords(s.geometry, 8))
        if n in sm.index:
            r = sm.loc[n]
            titles = int(r.titles)
            dens = titles / area_km2 if area_km2 else 0
            med = float(r.median_section_m2)
            # reference-builder urban/rural rule
            sparse_big = dens < 300 and med > 4000
            ur = ("Rural" if sparse_big else "Urban") if s["type"] == "Suburb" else ("Urban" if (dens >= 300 and med <= 4000) else "Rural")
            rec.update(sections=int(r.residential_sections), titles=titles, hh_count_proxy=titles,
                       density_per_km2=rnd(dens, 0), urban_rural=ur,
                       PercPool=rnd(r.pct_sections_with_pool), PoolArea=rnd(r.median_pool_m2), pools=int(r.sections_with_pool),
                       LotSize=rnd(r.median_section_m2, 0), SurveyArea=rnd(r.median_survey_area_m2, 0),
                       Footprint=rnd(r.median_building_m2, 0), Unbuilt=rnd(r.median_unbuilt_m2, 0),
                       GardSize=rnd(r.median_vegetated_m2, 0), GardPct=rnd(r.median_pct_vegetated),
                       ImperviousProxy=rnd(r.median_unbuilt_m2 - r.median_vegetated_m2, 0),
                       UnbuiltPerTitle=rnd(r.median_unbuilt_per_title_m2, 0), SharedPct=rnd(r.shared_sections_pct))
            # aggregated histograms only
            bins = [0, 300, 450, 600, 750, 900, 1100, 1400, 2000, 4000, 1e9]
            rec["hist_section"] = np.histogram(p.polygon_m2.clip(upper=1e8), bins)[0].tolist()
            vb = [0, 50, 100, 200, 300, 400, 600, 800, 1200, 2000, 1e9]
            rec["hist_garden"] = np.histogram(p.veg_m2.fillna(0).clip(upper=1e8), vb)[0].tolist()
            rec["hist_bins_section"] = bins[:-1]; rec["hist_bins_garden"] = vb[:-1]
        cy = cs[cs.suburb == n].set_index("year")
        rec["census"] = {str(int(y)): {k: rnd(v, 2) for k, v in row.items() if k not in ("suburb",)} for y, row in cy.iterrows()}
        sz = seas[seas.suburb == n]
        rec["climate_seasonal"] = sz.drop(columns="suburb").round(1).to_dict("records")
        cm = clm[clm.suburb == n]
        if len(cm):
            rec["grid"] = f"{cm.grid_lat.iloc[0]},{cm.grid_lon.iloc[0]}"
            y = cm[cm.month.str[:4].astype(int).between(2008, 2025)]
            rec["climate_annual"] = dict(rain_mm=rnd(y.rain_mm.sum() / y.month.str[:4].nunique(), 0),
                                         et0_mm=rnd(y.et0_mm.sum() / y.month.str[:4].nunique(), 0),
                                         tmean_c=rnd(y.tmean_c.mean(), 1))
        subs.append(rec)

    # ---- climate per grid cell (dedupe suburbs sharing a cell)
    clm["grid"] = clm.grid_lat.astype(str) + "," + clm.grid_lon.astype(str)
    cday["grid"] = cday.grid_lat.astype(str) + "," + cday.grid_lon.astype(str)
    cells = {}
    for gk, g in clm.groupby("grid"):
        g = g.drop_duplicates("month").sort_values("month")
        d = cday[cday.grid == gk].drop_duplicates("date").sort_values("date")
        d = d[d.date >= "2024-07-01"]
        cells[gk] = dict(months=g.month.tolist(), rain=g.rain_mm.round(1).tolist(), et0=g.et0_mm.round(1).tolist(),
                         tmean=g.tmean_c.round(1).tolist(), tmax=g.tmax_c.round(1).tolist(),
                         daily=dict(start=d.date.iloc[0], rain=d.rain_mm.round(1).tolist(), et0=d.et0_mm.round(1).tolist(),
                                    tmax=d.tmax_c.round(1).tolist()))

    # ---- SA2 (published Stats NZ aggregates)
    sa2s = []
    for _, s in sa2.iterrows():
        cc = c2[c2.sa2 == str(s.sa2_code)].set_index("year")
        sa2s.append(dict(code=str(s.sa2_code), name=s.sa2_name, geom=coords(s.geometry, 15),
                         census={str(int(y)): {k: rnd(v, 2) for k, v in r.items() if k not in ("sa2", "sa2_name")} for y, r in cc.iterrows()}))

    # ---- validation aggregates (no chips, no coordinates)
    items = {i["key"]: i for i in json.load(open(f"{HERE}/app/data/items.json")) if i["region"] == name}
    L = {}
    for line in open(f"{HERE}/app/data/labels.jsonl"):
        e = json.loads(line)
        if e["label"] is None: L.pop(e["key"], None)
        else: L[e["key"]] = e["label"]

    def pool_stats(lab):
        P = [i for i in items.values() if i["task"] == "pool"]
        ct = {t: {c: sum(1 for i in P if i["tool"] == t and lab(i) == c) for c in ("pool", "water", "not_pool", "unknown")} for t in ("pool", "not_pool")}
        J = [i for i in P if lab(i) not in (None, "unknown")]
        A = [i for i in J if i["group"] == "accepted"]; Rj = [i for i in J if i["group"] == "rejected"]
        popA = next((i["pop"] for i in P if i["group"] == "accepted"), 0); popR = next((i["pop"] for i in P if i["group"] == "rejected"), 0)
        prec = sum(lab(i) == "pool" for i in A) / len(A) if A else None
        mr = sum(lab(i) == "pool" for i in Rj) / len(Rj) if Rj else None
        eT = prec * popA if prec is not None else None; eM = mr * popR if mr is not None else None
        return dict(confusion=ct, labelled=len(J), accepted=len(A), rejected=len(Rj), precision=rnd(prec, 3), miss_rate=rnd(mr, 3),
                    pop_accepted=popA, pop_rejected=popR, est_found=rnd(eT, 0), est_missed=rnd(eM, 0),
                    recall=rnd(eT / (eT + eM), 3) if eT is not None and eM is not None and eT + eM else None)
    user = lambda i: L.get(i["key"]); claude = lambda i: i.get("claude")
    both = [i for i in items.values() if i["task"] == "pool" and user(i) not in (None, "unknown") and claude(i) not in (None, "unknown")]
    G = [i for i in items.values() if i["task"] == "garden"]
    val = dict(pool_user=pool_stats(user), pool_claude=pool_stats(claude),
               agree=dict(n=len(both), same=sum((user(i) == "pool") == (claude(i) == "pool") for i in both)),
               garden={who: {c: sum(1 for i in G if f(i) == c) for c in ("over", "about_right", "under", "unknown")}
                       for who, f in (("user", user), ("claude", claude))})
    # feature summary of rejected-but-real pools (why they were missed)
    rr = [i for i in items.values() if i["task"] == "pool" and i["group"] == "rejected" and user(i) == "pool"]
    if rr:
        gch = [int(i["info"]["rgb"].split("/")[1]) for i in rr]
        val["missed_pools_green_lt_130"] = sum(v < 130 for v in gch)
        val["missed_pools_n"] = len(rr)

    # ---- validation pack: imagery tiles flagged for visual validation (tile-level; items carry opaque IDs, no coordinates)
    import hashlib
    tg = gpd.read_file(f"{D}/tiles.gpkg").set_index("tile")
    base = f"https://nz-imagery.s3-ap-southeast-2.amazonaws.com/{cfg['imagery']}/rgbnir/2193/"
    vitems, vtiles = [], {}
    for it in items.values():
        oid = "v" + hashlib.sha1(it["key"].encode()).hexdigest()[:10]
        lab = user(it)
        vitems.append([oid, it["tile"], it["task"], it.get("group", "sample"), it.get("tool", ""), lab or ""])
        t = vtiles.setdefault(it["tile"], dict(items=0, pool_accepted=0, pool_rejected=0, garden=0, labelled=0, fp=0, missed=0))
        t["items"] += 1; t["labelled"] += bool(lab)
        if it["task"] == "garden": t["garden"] += 1
        elif it["group"] == "accepted": t["pool_accepted"] += 1; t["fp"] += lab in ("not_pool", "water")
        else: t["pool_rejected"] += 1; t["missed"] += lab == "pool"
    for tid, t in vtiles.items():
        b = tg.loc[tid].geometry.bounds if tid in tg.index else (None,) * 4
        reasons = ["calibration sample"]
        if t["missed"] >= 3 and t["missed"] >= 0.5 * max(1, t["pool_rejected"]): reasons.append("high miss rate")
        if t["fp"]: reasons.append("false positives")
        if t["labelled"] < t["items"]: reasons.append("unlabelled items")
        t.update(cog=base + tid + ".tiff", stac=base + tid + ".json", bbox=[round(v) if v is not None else None for v in b],
                 flags=reasons, priority=1 if len(reasons) > 1 else 2)
    c = gpd.GeoSeries([sub.union_all().centroid], crs=2193).to_crs(4326).iloc[0]
    bundle["regions"][name] = dict(lonlat=[round(c.x, 4), round(c.y, 4)], label=cfg["label"], ta=cfg["ta"], imagery=cfg["imagery_label"], imagery_prefix=cfg["imagery"],
                                   provider=PROVIDER[name], capture_id=cfg["imagery"].split("/")[-1], validation_tiles=vtiles, validation_items=vitems, suburbs=subs, sa2=sa2s, climate_cells=cells, validation=val,
                                   area_check=json.load(open(f"{HERE}/app/data/sections.json"))[name]["area"] if os.path.exists(f"{HERE}/app/data/sections.json") else None)

    # public LINZ section sizes for the household_ref-compatible export (no imagery-derived values)
    for _, r in par.iterrows():
        sections_export.append([name, r.suburb, int(r.id), "Shared" if r.n_titles > 1 else "Freehold", round(r.polygon_m2, 1), int(max(r.n_titles, 1)),
                                round(r.polygon_m2 / max(r.n_titles, 1), 1)])

# per-region source plan from the repo's source index (templates only)
import csv as _csv
if os.path.exists(f"{REPO}/index/source_index.json"):
    idx = json.load(open(f"{REPO}/index/source_index.json"))
    for k, ta in (("taupo", "Taupo District"), ("tauranga", "Tauranga City")):
        e = next(x for x in idx["regions"] if x["ta"] == ta)
        bundle["regions"][k]["source_plan"] = dict(ta_code=e["ta_code"], regional_council=e["regional_council"], sa2_count=e["sa2_count"],
            imagery_folders=e["imagery_folders"], steps=[dict(step=r["step"], service=r["service"], url=r["url"].split("?")[0],
            depends_on=r["depends_on"], output=r["output"]) for r in e["requests"]])
    bundle["index_regions"] = list(_csv.DictReader(open(f"{REPO}/index/regions.csv")))
json.dump(bundle, open(f"{OUT}/demo.json", "w"), separators=(",", ":"))
json.dump({"columns": ["region", "M_SUBURB", "M_DWELLING_ID", "SECTION_TYPE", "SECTION_SIZE_M2", "NUM_SECTIONS", "SECTION_AVG_M2"],
           "rows": sections_export}, open(f"{OUT}/sections.json", "w"), separators=(",", ":"))
for f in glob.glob(f"{OUT}/*.json"):
    print(os.path.basename(f), round(os.path.getsize(f) / 1e3), "KB")
print("nz_regions:", type(bundle["nz_regions"]).__name__, "water:", [(w["PROVIDER"], w["CHARGING_TYPE"], w["FIXED_PA"], w["VOLUMETRIC_PA"]) for w in bundle["water_rates"]])
