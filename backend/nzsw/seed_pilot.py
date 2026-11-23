"""Seed the database from the Taupō / Tauranga pilot outputs (already downloaded: makes NO external API calls).

Usage: python -m nzsw.seed_pilot --pilot /workspace/suburb_pilot --lookup /path/suburb_lookup.html \
           --db-url-file ~/.config/supabase/admin_db_url [--chips] [--labels-user <auth user uuid>]
Idempotent: rows are upserted on natural keys. Chips go to the private `chips` bucket (needs SUPABASE_URL and
SUPABASE_SECRET_KEY in the environment; used only for the upload, never stored)."""
import argparse, csv, glob, hashlib, io, json, os, re, sys
import numpy as np, pandas as pd, geopandas as gpd, psycopg
from shapely.geometry import MultiPolygon, Polygon, Point

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
REGIONS = {
    "taupo": dict(name="Taupō", ta="Taupo District", prvdr="TDC", capture="taupo_2023_0.075m", prefix="waikato/taupo_2023_0.075m", year=2023, res=0.075),
    "tauranga": dict(name="Tauranga (Bethlehem, Matua)", ta="Tauranga City", prvdr="TCC", capture="tauranga_2025_0.1m", prefix="bay-of-plenty/tauranga_2025_0.1m", year=2025, res=0.1),
}
vid = lambda key: "v" + hashlib.sha1(key.encode()).hexdigest()[:10]
nn = lambda v: None if v is None or (isinstance(v, float) and np.isnan(v)) else (v.item() if hasattr(v, "item") else v)


def multi(g):
    return g if isinstance(g, MultiPolygon) else MultiPolygon([g])


def parse_water(html):
    s = open(html, encoding="utf-8").read()
    blk = s[s.find("const WATER"):]
    sys.path.insert(0, os.path.join(REPO, "tools"))
    from build_source_index import prvdr_code
    out = []
    for m in re.finditer(r'\{ provider: "([^"]+)", prvd: "([^"]+)", aliases: \[([^\]]*)\], territories: \[([^\]]*)\], charging: "([^"]*)",'
                         r' fixed: ([\d.]+|null), vol: ([\d.]+|null), threshold: ([\d.]+|null), year: "([^"]*)",\s*note: "([^"]*)"', blk):
        end = blk.find("checks:", m.end())
        src = re.findall(r'\{ t: "([^"]+)", u: "([^"]+)" \}', blk[m.end():end if end > 0 else m.end() + 3000])
        num = lambda v: None if v == "null" else float(v)
        legacy = m.group(2)
        out.append(dict(prvdr=prvdr_code(legacy), legacy=legacy if prvdr_code(legacy) != legacy else None, name=m.group(1),
                        aliases=re.findall(r'"([^"]+)"', m.group(3)) + ([legacy] if prvdr_code(legacy) != legacy else []),
                        territories=re.findall(r'"([^"]+)"', m.group(4)), charging=m.group(5), fixed=num(m.group(6)), vol=num(m.group(7)),
                        threshold=num(m.group(8)), year=m.group(9), note=m.group(10), source=src[0][1] if src else None))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pilot", required=True)
    ap.add_argument("--lookup", required=True)
    ap.add_argument("--db-url-file", required=True)
    ap.add_argument("--chips", action="store_true")
    ap.add_argument("--labels-user", default=None)
    a = ap.parse_args()
    P = a.pilot
    url = open(os.path.expanduser(a.db_url_file)).read().strip()
    con = psycopg.connect(url, autocommit=False)
    cur = con.cursor()
    cur.execute("set search_path = public, extensions")
    log = lambda *x: print(*x, flush=True)

    # providers + water rates (all 64; PRVDR codes without underscores)
    W = parse_water(a.lookup)
    assert len(W) == 64, len(W)
    for w in W:
        cur.execute("""insert into providers (prvdr, legacy_prvdr, name, aliases, territories) values (%s,%s,%s,%s,%s)
                       on conflict (prvdr) do update set legacy_prvdr=excluded.legacy_prvdr, name=excluded.name, aliases=excluded.aliases, territories=excluded.territories""",
                    (w["prvdr"], w["legacy"], w["name"], w["aliases"], w["territories"]))
        cur.execute("""insert into water_rates (prvdr, valid_from, charging_type, fixed_pa, volumetric_pa, threshold_lpd, date_est, note, source_url, verified)
                       values (%s, '2026-07-01', %s,%s,%s,%s, '2026-11-21', %s,%s,%s)
                       on conflict (prvdr, valid_from) do update set charging_type=excluded.charging_type, fixed_pa=excluded.fixed_pa,
                       volumetric_pa=excluded.volumetric_pa, threshold_lpd=excluded.threshold_lpd, note=excluded.note, source_url=excluded.source_url, verified=excluded.verified""",
                    (w["prvdr"], w["charging"], w["fixed"], w["vol"], w["threshold"], w["note"], w["source"], w["fixed"] is not None or w["vol"] is not None))
    log(f"providers + water rates: {len(W)}")

    demo = json.load(open(os.path.join(REPO, "demo", "data", "demo.json")))
    items = json.load(open(os.path.join(P, "app", "data", "items.json")))
    labels = {}
    for line in open(os.path.join(P, "app", "data", "labels.jsonl")):
        e = json.loads(line)
        if e.get("label") is None: labels.pop(e["key"], None)
        else: labels[e["key"]] = e

    for rid, cfg in REGIONS.items():
        D = os.path.join(P, "regions", rid)
        cur.execute("""insert into regions (id, name, territorial_authorities, suburb_names, imagery_captures, status) values (%s,%s,%s,%s,%s,'published')
                       on conflict (id) do update set name=excluded.name, territorial_authorities=excluded.territorial_authorities,
                       suburb_names=excluded.suburb_names, imagery_captures=excluded.imagery_captures, status='published'""",
                    (rid, cfg["name"], [cfg["ta"]], [s["name"] for s in demo["regions"][rid]["suburbs"]], [cfg["capture"]]))
        cur.execute("""insert into imagery_captures (id, s3_prefix, year, resolution_m, bands, calibration) values (%s,%s,%s,%s,'RGB+NIR',%s)
                       on conflict (id) do update set s3_prefix=excluded.s3_prefix, calibration=excluded.calibration""",
                    (cfg["capture"], cfg["prefix"], cfg["year"], cfg["res"],
                     json.dumps(dict(ndwi_min=0.15, blue_over_red=12, bright_min=55, ndvi_veg=0.2, nir_veg_min=40, pool_g_min=130, pool_b_min=130, pool_ndwi_min=0.4))))

        # suburbs
        sub = gpd.read_file(os.path.join(D, "lds", "suburbs.gpkg"))
        for _, s in sub.iterrows():
            cur.execute("""insert into suburbs (linz_id, name, type, territorial_authority, population_estimate, geom, region_id, source_version)
                           values (%s,%s,%s,%s,%s, st_geomfromwkb(%s, 2193), %s, 'pilot 2026-11-23')
                           on conflict (linz_id) do update set name=excluded.name, type=excluded.type, geom=excluded.geom, region_id=excluded.region_id""",
                        (int(s["id"]), s["name"], s["type"], s["territorial_authority"], nn(s.get("population_estimate")), multi(s.geometry).wkb, rid))
        # SA2 + census
        sa2 = gpd.read_file(os.path.join(D, "lds", "sa2.gpkg"))
        for _, s in sa2.iterrows():
            cur.execute("""insert into sa2 (code, name, version, geom) values (%s,%s,2023, st_geomfromwkb(%s,2193))
                           on conflict (code) do update set name=excluded.name, geom=excluded.geom""", (str(s.sa2_code), s.sa2_name, multi(s.geometry).wkb))
        c2 = pd.read_csv(os.path.join(D, "out", "census_sa2.csv"), dtype={"sa2": str})
        cols = ["households", "pct_separate", "pct_joined", "bedrooms_mean_all", "bedrooms_mean_separate", "bedrooms_mean_joined",
                "pct_owner_all", "pct_owner_separate", "pct_owner_joined", "hh_size_mean", "income_median"]
        for _, r in c2.iterrows():
            cur.execute(f"""insert into census_metrics (sa2_code, year, {','.join(cols)}) values (%s,%s,{','.join(['%s'] * len(cols))})
                            on conflict (sa2_code, year) do update set {','.join(f'{c}=excluded.{c}' for c in cols)}""",
                        (r.sa2, int(r.year), *[nn(r[c]) for c in cols]))
        cs = pd.read_csv(os.path.join(D, "out", "census_suburb.csv"))
        idmap = dict(zip(sub["name"], sub["id"].astype(int)))
        scols = ["sa2s", "sections", "hh_size_mean", "income_median", "bedrooms_mean_all", "pct_owner_all", "pct_separate", "pct_joined",
                 "bedrooms_mean_separate", "bedrooms_mean_joined", "pct_owner_separate", "pct_owner_joined"]
        for _, r in cs.iterrows():
            cur.execute(f"""insert into suburb_census (linz_id, year, {','.join(scols)}) values (%s,%s,{','.join(['%s'] * len(scols))})
                            on conflict (linz_id, year) do update set {','.join(f'{c}=excluded.{c}' for c in scols)}""",
                        (idmap[r.suburb], int(r.year), *[nn(r[c]) for c in scols]))
        log(f"{rid}: suburbs {len(sub)}, sa2 {len(sa2)}, census rows {len(c2)} / {len(cs)}")

        # sections (residential parcels used by the pilot) with SA2 code
        pa = pd.read_csv(os.path.join(D, "out", "parcels_all.csv"))
        pg = gpd.read_file(os.path.join(D, "lds", "parcels.gpkg"))
        pg = pg[pg.id.isin(pa.id)].merge(pa[["id", "suburb", "n_titles", "polygon_m2", "building_m2", "unbuilt_m2", "valid_m2", "open_m2", "veg_m2"]], on="id")
        pts = pg.copy(); pts["geometry"] = pg.representative_point()
        j = gpd.sjoin(pts, sa2[["sa2_code", "geometry"]], predicate="within", how="left")
        pg["sa2_code"] = j["sa2_code"].astype("string").values
        cur.execute("create temp table _sec (like sections including defaults) on commit drop")
        with cur.copy("copy _sec (parcel_id, appellation, parcel_intent, survey_area, polygon_m2, geom, suburb_id, sa2_code, n_titles, region_id, source_version) from stdin") as cp:
            for _, r in pg.iterrows():
                cp.write_row((int(r.id), r.appellation, r.parcel_intent, nn(r.survey_area), round(float(r.polygon_m2), 1),
                              "SRID=2193;" + multi(r.geometry).wkt, idmap.get(r.suburb), nn(r.sa2_code), int(r.n_titles), rid, "pilot 2026-11-23"))
        cur.execute("""insert into sections select * from _sec on conflict (parcel_id) do update set appellation=excluded.appellation,
                       survey_area=excluded.survey_area, polygon_m2=excluded.polygon_m2, geom=excluded.geom, suburb_id=excluded.suburb_id,
                       sa2_code=excluded.sa2_code, n_titles=excluded.n_titles, region_id=excluded.region_id""")
        # buildings (polygons; multipolygons split into parts)
        bl = gpd.read_file(os.path.join(D, "lds", "buildings.gpkg")).explode(index_parts=False)
        bid = "building_id" if "building_id" in bl.columns else "id"
        cur.execute("create temp table _bld (like buildings including defaults) on commit drop")
        seen = set()
        with cur.copy("copy _bld (building_id, area_m2, capture_source, geom, source_version) from stdin") as cp:
            for _, r in bl.iterrows():
                k = int(r[bid])
                if k in seen or not isinstance(r.geometry, Polygon): continue
                seen.add(k)
                cp.write_row((k, round(r.geometry.area, 1), nn(r.get("capture_source_id")), "SRID=2193;" + r.geometry.wkt, "pilot 2026-11-23"))
        cur.execute("insert into buildings select * from _bld on conflict (building_id) do update set geom=excluded.geom, area_m2=excluded.area_m2")
        # section imagery (editor-only)
        cur.execute("create temp table _si (like section_imagery) on commit drop")
        with cur.copy("copy _si (section_id, capture_id, valid_m2, open_m2, veg_m2, building_m2, unbuilt_m2) from stdin") as cp:
            for _, r in pg.iterrows():
                cp.write_row((int(r.id), cfg["capture"], nn(r.valid_m2), nn(r.open_m2), nn(r.veg_m2), nn(r.building_m2), nn(r.unbuilt_m2)))
        cur.execute("insert into section_imagery select * from _si on conflict (section_id, capture_id) do update set veg_m2=excluded.veg_m2, unbuilt_m2=excluded.unbuilt_m2, valid_m2=excluded.valid_m2")
        log(f"{rid}: sections {len(pg)}, buildings {len(seen)}, section_imagery {len(pg)}")

        # pool candidates (editor-only) and validation items
        sys.path.insert(0, P)
        pools = pd.concat([pd.read_csv(f) for f in glob.glob(os.path.join(D, "out", "pools_*.csv")) if os.path.getsize(f) > 1]).drop_duplicates(["x", "y"])
        pools["tool_pool"] = pools.is_pool & (pools.g >= 130) & (pools.b >= 130) & (pools.ndwi >= 0.4)
        secs = set(pg.id.astype(int))
        cur.execute("delete from validation_items where capture_id = %s", (cfg["capture"],))
        cur.execute("delete from pool_candidates where capture_id = %s", (cfg["capture"],))
        cand_ids = {}
        for _, r in pools.iterrows():
            cur.execute("""insert into pool_candidates (capture_id, section_id, geom, area_m2, features, tool_pool)
                           values (%s,%s, st_setsrid(st_makepoint(%s,%s),2193), %s,%s,%s) returning id""",
                        (cfg["capture"], int(r.parcel_id) if int(r.parcel_id) in secs else None, float(r.x), float(r.y), float(r.area_m2),
                         json.dumps(dict(ndwi=r.ndwi, r=int(r.r), g=int(r.g), b=int(r.b), n=int(r.n), solidity=r.solidity, rectfill=r.rectfill, tile=r.tile)),
                         bool(r.tool_pool)))
            cand_ids[f"pool:{rid}:{r.x}:{r.y}"] = cur.fetchone()[0]
        n_items = n_lab = 0
        for it in (i for i in items if i["region"] == rid):
            v = vid(it["key"])
            cur.execute("""insert into validation_items (task, capture_id, candidate_id, section_id, grp, chip_path, tool_verdict)
                           values (%s,%s,%s,%s,%s,%s,%s) returning id""",
                        (it["task"], cfg["capture"], cand_ids.get(it["key"]), it.get("parcel_id") if it.get("parcel_id") in secs else None,
                         it.get("group", "sample"), f"{rid}/{v}.jpg", it.get("tool") or "measured"))
            item_id = cur.fetchone()[0]; n_items += 1
            lab = labels.get(it["key"])
            if lab and a.labels_user:
                cur.execute("""insert into validation_labels (item_id, user_id, label, labelled_at) values (%s,%s,%s,%s)
                               on conflict (item_id, user_id) do update set label=excluded.label""",
                            (item_id, a.labels_user, lab["label"], lab["ts"] + "+13:00")); n_lab += 1
        log(f"{rid}: pool candidates {len(pools)}, validation items {n_items}, labels {n_lab}")

        # climate cells + daily + suburb mapping
        cells = json.load(open(os.path.join(D, "out", "openmeteo_cells.json")))
        cur.execute("create temp table _cd (like climate_daily including defaults) on commit drop")
        for ck, j in cells.items():
            cur.execute("insert into climate_cells (id, lat, lon) values (%s,%s,%s) on conflict (id) do nothing", (ck, j["latitude"], j["longitude"]))
            d = j["daily"]
            with cur.copy("copy _cd (cell_id, date, rain_mm, tmean_c, tmax_c, et0_mm) from stdin") as cp:
                for i, t in enumerate(d["time"]):
                    cp.write_row((ck, t, d["precipitation_sum"][i], d["temperature_2m_mean"][i], d["temperature_2m_max"][i], d["et0_fao_evapotranspiration"][i]))
        cur.execute("insert into climate_daily select * from _cd on conflict (cell_id, date) do nothing")
        pts4326 = sub.assign(geometry=sub.representative_point()).to_crs(4326)
        for _, s in pts4326.iterrows():
            ck = f"{round(s.geometry.y / 0.1) * 0.1:.1f},{round(s.geometry.x / 0.1) * 0.1:.1f}"
            if ck in cells:
                cur.execute("""insert into suburb_climate_cell (linz_id, cell_id) values (%s,%s)
                               on conflict (linz_id) do update set cell_id=excluded.cell_id""", (int(s["id"]), ck))
        log(f"{rid}: climate cells {len(cells)}")

        # published suburb metrics + validation summary (from the aggregate bundle)
        R = demo["regions"][rid]
        for s in R["suburbs"]:
            g = s.get
            cur.execute("""insert into suburb_metrics (linz_id, region_id, name, type, territorial_authority, prvdr, area_km2, sections, titles,
                             density_per_km2, urban_rural, pools, perc_pool, pool_area, lot_size, survey_area, footprint, unbuilt, gard_size, gard_pct,
                             impervious_proxy, unbuilt_per_title, shared_pct, hist_section, hist_section_bins, hist_garden, hist_garden_bins, capture_id, climate_cell)
                           values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,
                                   (select cell_id from suburb_climate_cell where linz_id=%s))
                           on conflict (linz_id) do update set sections=excluded.sections, perc_pool=excluded.perc_pool, gard_size=excluded.gard_size,
                             pools=excluded.pools, lot_size=excluded.lot_size, updated_at=now(), climate_cell=excluded.climate_cell, prvdr=excluded.prvdr""",
                        (g("linz_id"), rid, g("name"), g("type"), g("ta"), cfg["prvdr"], g("area_km2"), g("sections"), g("titles"), g("density_per_km2"),
                         g("urban_rural"), g("pools"), g("PercPool"), g("PoolArea"), g("LotSize"), g("SurveyArea"), g("Footprint"), g("Unbuilt"),
                         g("GardSize"), g("GardPct"), g("ImperviousProxy"), g("UnbuiltPerTitle"), g("SharedPct"), g("hist_section"),
                         [int(b) for b in g("hist_bins_section") or []] or None, g("hist_garden"), [int(b) for b in g("hist_bins_garden") or []] or None,
                         cfg["capture"], g("linz_id")))
        cur.execute("""insert into validation_summary (region_id, capture_id, stats) values (%s,%s,%s)
                       on conflict (region_id, capture_id) do update set stats=excluded.stats, updated_at=now()""",
                    (rid, cfg["capture"], json.dumps(R["validation"])))
        con.commit()
        log(f"{rid}: suburb metrics {len(R['suburbs'])}; committed")

    # image chips -> private storage bucket
    if a.chips:
        import requests
        base, key = os.environ["SUPABASE_URL"], os.environ["SUPABASE_SECRET_KEY"]
        H = {"Authorization": f"Bearer {key}", "apikey": key, "x-upsert": "true", "Content-Type": "image/jpeg"}
        n = 0
        for it in items:
            v = vid(it["key"])
            for src, suffix in ((it.get("img"), ""), (it.get("img2"), "_veg")):
                if not src: continue
                f = os.path.join(P, "app", src)
                if not os.path.exists(f): continue
                r = requests.post(f"{base}/storage/v1/object/chips/{it['region']}/{v}{suffix}.jpg", headers=H, data=open(f, "rb").read(), timeout=60)
                if r.status_code >= 300:
                    sys.exit(f"chip upload failed: HTTP {r.status_code} {r.text[:120]}")
                n += 1
        log(f"chips uploaded: {n}")
    con.close()


if __name__ == "__main__":
    main()
