"""Region preparation steps (docs/SPEC.md sections 17-22), ported from the pilot pipeline.
  linz          suburbs (TA, optionally limited to the region's scope), residential parcels and buildings (paged WFS),
                SA2 boundaries, climate cells (no API)
  imagery_index newest high-resolution RGB+NIR capture covering the region; tiles that hold buildings
  imagery       pools and vegetation per section, read window by window from the COG tiles (resumable)
  publish_new   suburb_metrics rows for a new region (counts, medians, histograms, urban/rural)
All external requests go through limits.Client; all writes are idempotent upserts."""
import json, math, os, re, time, datetime as dt
import numpy as np, pandas as pd, geopandas as gpd, requests
from shapely import wkb
from shapely.geometry import MultiPolygon, Polygon, box
import xml.etree.ElementTree as ET
from . import limits as L
from .steps import key

LINZ = "https://data.linz.govt.nz/services;key={k}/wfs"
DF = "https://datafinder.stats.govt.nz/services;key={k}/wfs"
S3 = "https://nz-imagery.s3-ap-southeast-2.amazonaws.com/"
RES_INTENTS = {"DCDB", "Fee Simple Title", "Maori"}
MIN_HOUSE_M2 = 40
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEADLINE = time.monotonic() + float(os.environ.get("NZSW_DEADLINE_S", 90 * 60))


class Continue(RuntimeError):
    """Out of run time: requeue the job; finished work is kept and skipped next time."""


def _multi(g):
    return g if isinstance(g, MultiPolygon) else MultiPolygon([g])


def _region(con, region):
    r = con.execute("select id, ta_code, scope, territorial_authorities from regions where id=%s", (region,)).fetchone()
    if not r or not r[1]:
        raise ValueError(f"region {region} has no TA code")
    ta = con.execute("select name, name_ascii from territorial_authorities where code=%s", (r[1],)).fetchone()
    return dict(id=r[0], ta_code=r[1], scope=r[2], ta_names=sorted({ta[0], ta[1], *(r[3] or [])}) if ta else (r[3] or []))


NOTE = None   # the running step's reporter (set by cli.run_steps): short progress lines for the app


def _note(msg):
    if NOTE:
        NOTE(msg)


LAYER_NAMES = {113764: "suburbs", 50772: "parcels", 50804: "titles", 101290: "buildings", 111206: "SA2 boundaries"}


def _wfs_hits(client, service, base, layer, bbox):
    """Number of features in a bbox (WFS resultType=hits): one small request, no features downloaded."""
    k = key("linz" if service == "linz_wfs" else "statsnz_datafinder")
    r = client.request(service, "GET", base.format(k=k), params=dict(service="WFS", version="2.0.0", request="GetFeature", typeNames=f"layer-{layer}",
                                                                      resultType="hits", bbox=bbox), redact=lambda s: s.replace(k, "<key>"), timeout=120)
    m = re.search(r'numberMatched="(\d+)"', r.text or "")
    return int(m.group(1)) if m else None


def _bbox4326(geoms):
    minx, miny, maxx, maxy = gpd.GeoSeries([geoms.union_all()], crs=2193).to_crs(4326).total_bounds
    return f"{miny},{minx},{maxy},{maxx},urn:ogc:def:crs:EPSG::4326"


def _wfs(client, service, base, layer, cql=None, bbox=None):
    k = key("linz" if service == "linz_wfs" else "statsnz_datafinder")
    url = base.format(k=k)
    page = L.SERVICES[service].get("page_size", 10000)
    feats, start = [], 0
    while True:
        p = dict(service="WFS", version="2.0.0", request="GetFeature", typeNames=f"layer-{layer}", outputFormat="application/json",
                 srsName="EPSG:4326", count=page, startIndex=start)
        if cql: p["cql_filter"] = cql
        if bbox: p["bbox"] = bbox
        r = client.request(service, "GET", url, params=p, redact=lambda s: s.replace(k, "<key>"), timeout=600)
        if r.status_code != 200 or not r.text.lstrip().startswith("{"):
            raise RuntimeError(f"{service} layer {layer}: HTTP {r.status_code}")
        got = r.json()["features"]
        feats += got
        _note(f"LINZ {LAYER_NAMES.get(layer, 'layer ' + str(layer))}: {len(feats):,} features downloaded" if service == "linz_wfs" else f"Stats NZ {LAYER_NAMES.get(layer, 'layer ' + str(layer))}: {len(feats):,} features")
        if len(feats) > L.SERVICES["linz_wfs"]["max_features_run"]:
            raise L.RunTooLarge(f"layer {layer}: more than {L.SERVICES['linz_wfs']['max_features_run']:,} features: limit the region with a suburb list")
        if len(got) < page:
            break
        start += page
    if not feats:
        return gpd.GeoDataFrame(geometry=[], crs=2193)
    return gpd.GeoDataFrame.from_features(feats, crs=4326).to_crs(2193)


def _q(names):
    return ",".join("'" + n.replace("'", "''") + "'" for n in names)


# ---------------------------------------------------------------- linz
def linz(con, client, region, log):
    R = _region(con, region)
    ta_cql = f"territorial_authority_ascii IN ({_q(R['ta_names'])}) OR territorial_authority IN ({_q(R['ta_names'])})"
    subs = []
    # reuse: suburbs already in the shared cache (filled by Batch → Validate) need no LINZ request
    # only a complete fetch of the TA is reused (a partial one is fetched again)
    cached = con.execute("""select i.linz_id, i.name, i.name_ascii, i.type, st_asbinary(i.geom), i.fetched_at from linz_suburb_index i
                            join linz_suburb_fetch f on f.ta_code = i.ta_code and f.complete where i.ta_code=%s""", (R["ta_code"],)).fetchall()
    if cached:
        cg = gpd.GeoDataFrame({"id": [r[0] for r in cached], "name": [r[1] for r in cached], "name_ascii": [r[2] for r in cached], "type": [r[3] for r in cached],
                               "territorial_authority": R["ta_names"][0], "population_estimate": None}, geometry=[wkb.loads(bytes(r[4])) for r in cached], crs=2193)
        if R["scope"]:
            want = {n.lower() for n in R["scope"]}
            cg = cg[cg["name"].str.lower().isin(want) | cg["name_ascii"].fillna("").str.lower().isin(want)]
        if len(cg):
            subs.append(cg); log(f"suburbs: {len(cg)} from the shared cache (no LINZ request)")
    if subs:
        pass
    elif R["scope"]:
        for i in range(0, len(R["scope"]), 60):
            names = R["scope"][i:i + 60]
            subs.append(_wfs(client, "linz_wfs", LINZ, 113764, cql=f"({ta_cql}) AND (name IN ({_q(names)}) OR name_ascii IN ({_q(names)}))"))
    else:
        subs.append(_wfs(client, "linz_wfs", LINZ, 113764, cql=ta_cql))
    sub = pd.concat(subs).drop_duplicates("id") if subs else gpd.GeoDataFrame()
    if sub.empty:
        raise ValueError("no LINZ suburbs matched the region (check the suburb list against LINZ names)")
    sub = gpd.GeoDataFrame(sub, crs=2193)
    for _, s in sub.iterrows():
        con.execute("""insert into suburbs (linz_id, name, type, territorial_authority, population_estimate, geom, region_id, source_version)
                       values (%s,%s,%s,%s,%s, st_geomfromwkb(%s,2193), %s, %s)
                       on conflict (linz_id) do update set name=excluded.name, type=excluded.type, geom=excluded.geom,
                       region_id=coalesce(suburbs.region_id, excluded.region_id)""",
                    (int(s["id"]), s["name"], s.get("type"), s.get("territorial_authority"), s.get("population_estimate"), _multi(s.geometry).wkb,
                     region, dt.date.today().isoformat()))
    log(f"suburbs: {len(sub)}")
    # reuse: suburbs whose sections are already stored (by any user's earlier job) are not downloaded again
    loaded = {r[0] for r in con.execute("select distinct suburb_id from sections where suburb_id = any(%s)", (list(sub["id"].astype(int)),))}
    todo = sub[~sub["id"].astype(int).isin(loaded)]
    if todo.empty:
        log(f"all {len(sub)} suburbs already stored: no LINZ parcel/building download needed")
        _sa2_and_cells(con, client, region, sub, None)
        return f"{len(sub)} suburbs, all reused from stored data (0 parcel/building requests)"
    # large regions load in parts: at most max_suburbs_per_run neighbouring suburbs per run (a compact LINZ download area),
    # then the step continues in the next run until every suburb is stored
    cap, more = L.RUN_CAPS["max_suburbs_per_run"], 0
    if len(todo) > cap:
        pts = todo.geometry.representative_point()
        anchor = pts.iloc[int(np.lexsort((pts.x.values, pts.y.values))[0])]     # start from the southernmost remaining suburb
        todo = todo.loc[pts.distance(anchor).sort_values().index[:cap]]
        more = len(sub) - len(loaded) - cap
    if hasattr(log, "progress"):
        log.progress(len(loaded) / max(1, len(sub)))
    # keep the part's download area within the per-run feature limit: count parcels and buildings first (cheap) and
    # halve the part (nearest suburbs kept) until both fit
    limit = int(L.SERVICES["linz_wfs"]["max_features_run"] * 0.6)
    while True:
        bbox = _bbox4326(todo.geometry)
        counts = [_wfs_hits(client, "linz_wfs", LINZ, lyr, bbox) for lyr in (50772, 101290)]
        if all(c is None or c <= limit for c in counts) or len(todo) == 1:
            break
        pts = todo.geometry.representative_point(); a0 = pts.iloc[0]
        keep = max(1, len(todo) // 2); dropped = len(todo) - keep
        todo = todo.loc[pts.distance(a0).sort_values().index[:keep]]; more += dropped
        log(f"part too large for one download ({max(c or 0 for c in counts):,} features): trying {len(todo)} suburbs")
    log(f"{len(loaded)} suburb(s) reused from stored data; downloading {len(todo)}{f' ({more} more in later runs)' if more else ''}")
    full_sub, sub = sub, gpd.GeoDataFrame(todo, crs=2193)
    area = sub.union_all()

    par = _wfs(client, "linz_wfs", LINZ, 50772, bbox=bbox)
    par = par[par.parcel_intent.isin(RES_INTENTS)]
    pts = par.copy(); pts["geometry"] = par.representative_point()
    j = gpd.sjoin(pts, sub[["id", "geometry"]].rename(columns={"id": "suburb_id"}), predicate="within")
    par = par.loc[j.index].assign(suburb_id=j["suburb_id"].values)
    bl = _wfs(client, "linz_wfs", LINZ, 101290, bbox=bbox)
    bl = bl[bl.intersects(area)].explode(index_parts=False)
    bl = bl[bl.geometry.geom_type == "Polygon"]
    ov = gpd.overlay(bl[["building_id", "geometry"]], par[["id", "geometry"]], how="intersection", keep_geom_type=True)
    ov["a"] = ov.area
    ov = ov[ov.a >= 10]
    largest = ov.groupby("id").a.max()
    par = par[par.id.isin(largest[largest >= MIN_HOUSE_M2].index)]
    par["n_titles"] = par.titles.fillna("").str.split(",").map(lambda x: len([t for t in x if t.strip()]))
    with con.cursor() as cur:
        cur.execute("create temp table if not exists _sec (like sections including defaults)")
        cur.execute("truncate _sec")
        with cur.copy("copy _sec (parcel_id, appellation, parcel_intent, survey_area, polygon_m2, geom, suburb_id, n_titles, region_id, source_version) from stdin") as cp:
            for _, r in par.iterrows():
                cp.write_row((int(r.id), r.appellation, r.parcel_intent, r.survey_area if pd.notna(r.survey_area) else None, round(r.geometry.area, 1),
                              "SRID=2193;" + _multi(r.geometry).wkt, int(r.suburb_id), int(r.n_titles), region, dt.date.today().isoformat()))
        cur.execute("""insert into sections select * from _sec on conflict (parcel_id) do update set polygon_m2=excluded.polygon_m2, geom=excluded.geom,
                       suburb_id=excluded.suburb_id, n_titles=excluded.n_titles, region_id=excluded.region_id, survey_area=excluded.survey_area""")
        keep = bl[bl.intersects(par.union_all())] if len(par) else bl.iloc[0:0]
        cur.execute("create temp table if not exists _bld (like buildings including defaults)")
        cur.execute("truncate _bld")
        seen = set()
        with cur.copy("copy _bld (building_id, area_m2, capture_source, geom, source_version) from stdin") as cp:
            for _, r in keep.iterrows():
                if int(r.building_id) in seen: continue
                seen.add(int(r.building_id))
                cp.write_row((int(r.building_id), round(r.geometry.area, 1), r.get("capture_source_id"), "SRID=2193;" + r.geometry.wkt, dt.date.today().isoformat()))
        cur.execute("insert into buildings select * from _bld on conflict (building_id) do update set geom=excluded.geom, area_m2=excluded.area_m2")
    log(f"residential sections: {len(par)}, buildings: {len(seen)}")
    if hasattr(log, "progress"):
        log.progress((len(loaded) + len(sub)) / max(1, len(full_sub)))

    n_sa2 = _sa2_and_cells(con, client, region, full_sub, bbox)
    if more:
        raise Continue(f"{len(full_sub) - more} of {len(full_sub)} suburbs stored ({len(par)} sections this run); {more} left: continues in the next run")
    return f"{len(full_sub)} suburbs ({len(full_sub) - len(sub)} reused), {len(par)} new residential sections, {len(seen)} buildings, {n_sa2} SA2 boundaries downloaded"


def _sa2_and_cells(con, client, region, sub, bbox):
    """SA2 per section from stored boundaries first; download boundaries only if some sections are still unassigned.
    Climate cells and M_SUBURB links need no API call."""
    q_assign = """update sections s set sa2_code = a.code from sa2 a
                  where s.region_id = %s and s.sa2_code is null and st_within(st_pointonsurface(s.geom), a.geom)"""
    con.execute(q_assign, (region,))
    n = 0
    if con.execute("select count(*) from sections where region_id=%s and sa2_code is null", (region,)).fetchone()[0]:
        if bbox is None:
            minx, miny, maxx, maxy = gpd.GeoSeries([sub.union_all()], crs=2193).to_crs(4326).total_bounds
            bbox = f"{miny},{minx},{maxy},{maxx},urn:ogc:def:crs:EPSG::4326"
        sa2 = _wfs(client, "statsnz_datafinder", DF, 111206, bbox=bbox)
        code = next((c for c in sa2.columns if c.upper() == "SA22023_V1_00"), None)
        name = next((c for c in sa2.columns if c.upper() == "SA22023_V1_00_NAME"), None)
        sa2 = sa2[sa2.intersects(sub.union_all())]
        for _, s in sa2.iterrows():
            con.execute("insert into sa2 (code, name, version, geom) values (%s,%s,2023, st_geomfromwkb(%s,2193)) on conflict (code) do update set geom=excluded.geom",
                        (str(s[code]), s[name], _multi(s.geometry).wkb))
        con.execute(q_assign, (region,)); n = len(sa2)
    p4326 = sub.assign(geometry=sub.representative_point()).to_crs(4326)
    for _, s in p4326.iterrows():
        lat, lon = round(s.geometry.y / 0.1) * 0.1, round(s.geometry.x / 0.1) * 0.1
        cid = f"{lat:.1f},{lon:.1f}"
        con.execute("insert into climate_cells (id, lat, lon) values (%s,%s,%s) on conflict (id) do nothing", (cid, s.geometry.y, s.geometry.x))
        con.execute("insert into suburb_climate_cell (linz_id, cell_id) values (%s,%s) on conflict (linz_id) do nothing", (int(s["id"]), cid))
    con.execute("""insert into m_suburb_links (m_suburb_id, linz_id, share_rule)
                   select m.id, s.linz_id, 'full' from m_suburbs m join suburbs s on s.region_id = m.region_id
                   and lower(s.name) = lower(coalesce(m.linz_ref, m.m_suburb))
                   where m.region_id = %s on conflict do nothing""", (region,))
    return n


# ---------------------------------------------------------------- imagery index
def _s3_list(client, prefix, delimiter=None):
    keys, prefixes, tok = [], [], None
    while True:
        p = {"list-type": "2", "prefix": prefix}
        if delimiter: p["delimiter"] = delimiter
        if tok: p["continuation-token"] = tok
        x = ET.fromstring(client.request("linz_imagery_s3", "GET", S3, params=p, timeout=120).content)
        ns = {"s": x.tag.split("}")[0][1:]}
        keys += [k.text for k in x.findall("s:Contents/s:Key", ns)]
        prefixes += [k.text for k in x.findall("s:CommonPrefixes/s:Prefix", ns)]
        t = x.find("s:NextContinuationToken", ns)
        if t is None: return keys, prefixes
        tok = t.text


def imagery_index(con, client, region, log):
    R = _region(con, region)
    # reuse: tiles already indexed for this region (by any user's job) cover sections that have none of their own
    have = con.execute("select count(*), min(capture_id) from imagery_tiles where region_id=%s", (region,)).fetchone()
    uncovered = con.execute("""select count(*) from sections s where s.region_id=%s and not exists
                               (select 1 from imagery_tiles t where t.region_id=s.region_id and st_intersects(t.geom, s.geom))""", (region,)).fetchone()[0]
    if have[0] and not uncovered:
        return f"reused: {have[0]} tiles of {have[1]} already indexed; no imagery listing needed"
    idx = {e["ta_code"]: e for e in json.load(open(os.path.join(ROOT, "index", "source_index.json")))["regions"]}
    folders = idx[R["ta_code"]]["imagery_folders"]
    cands = []
    for f in folders:
        _, colls = _s3_list(client, f + "/", "/")
        for c in colls:
            m = re.search(r"_(\d{4})(?:-(\d{4}))?_(\d+(?:\.\d+)?)m/$", c)
            if not m: continue
            year, res = int(m.group(2) or m.group(1)), float(m.group(3))
            if res > 0.125: continue
            k, _ = _s3_list(client, c + "rgbnir/2193/")
            items = [x for x in k if x.endswith(".json") and "collection" not in x]
            if items: cands.append((year, -res, c.rstrip("/"), items))
    if not cands:
        return "no suitable imagery (no RGB+NIR capture at 0.125 m or finer): pools and gardens are not available for this region"
    ext = con.execute("select st_xmin(e), st_ymin(e), st_xmax(e), st_ymax(e) from (select st_extent(geom) e from buildings b where exists (select 1 from sections s where s.region_id=%s and st_intersects(s.geom, b.geom))) t", (region,)).fetchone()
    reg_box = box(*ext) if ext[0] is not None else None
    for year, nres, coll, items in sorted(cands, reverse=True):          # newest, then finest
        from shapely.geometry import shape
        tiles = []
        # each tile's footprint is in a small public STAC file; a large capture has thousands, so fetch 16 at a time and
        # hand back to the queue before the run's time limit (the next run starts the listing again)
        sess = requests.Session()
        def item(k):
            for attempt in range(3):
                try:
                    r = sess.get(S3 + k, timeout=30)
                    if r.status_code == 200: return k, r.json()
                except requests.RequestException:
                    pass
                time.sleep(1 + attempt)
            return k, None
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=16) as ex:
            for i, (k, j) in enumerate(ex.map(item, items)):
                if time.monotonic() > DEADLINE:
                    ex.shutdown(wait=False, cancel_futures=True)   # don't wait for the remaining downloads
                    raise Continue(f"time limit while listing imagery tiles ({i} of {len(items)} checked)")
                if i % 200 == 0 and hasattr(log, "progress"):
                    log.progress(i / max(1, len(items)), f"imagery tiles checked: {i:,} of {len(items):,}")
                if not j or j.get("type") != "Feature": continue
                g = gpd.GeoSeries([shape(j["geometry"])], crs=4326).to_crs(2193).iloc[0]
                if reg_box is not None and g.intersects(reg_box):
                    tiles.append((os.path.basename(k)[:-5], g))
        if not tiles:
            continue
        # keep tiles that actually contain the region's buildings
        hit = []
        for tid, g in tiles:
            n = con.execute("""select count(*) from buildings b join sections s on st_intersects(s.geom, b.geom)
                               where s.region_id=%s and st_intersects(b.geom, st_geomfromwkb(%s,2193))""", (region, g.wkb)).fetchone()[0]
            if n: hit.append((tid, g))
        if not hit: continue
        # every tile is indexed (no download); processing takes at most max_tiles_run per run and continues in later runs
        cap = coll.split("/")[-1]
        con.execute("""insert into imagery_captures (id, s3_prefix, year, resolution_m, bands) values (%s,%s,%s,%s,'RGB+NIR')
                       on conflict (id) do nothing""", (cap, coll, year, -nres))
        for tid, g in hit:
            base = f"{S3}{coll}/rgbnir/2193/{tid}"
            con.execute("""insert into imagery_tiles (capture_id, tile_id, region_id, cog_url, stac_url, geom) values (%s,%s,%s,%s,%s, st_geomfromwkb(%s,2193))
                           on conflict do nothing""", (cap, tid, region, base + ".tiff", base + ".json", g.wkb))
        con.execute("update regions set imagery_captures = array[%s] where id=%s", (cap, region))
        return f"capture {cap} ({year}, {-nres} m): {len(hit)} tiles hold the region's buildings"
    return "no suitable imagery covers the region's buildings: pools and gardens are not available for this region"


# ---------------------------------------------------------------- imagery (pools, vegetation)
def imagery(con, client, region, log):
    import cv2, rasterio
    from rasterio.features import rasterize
    os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
    os.environ.setdefault("CPL_VSIL_CURL_ALLOWED_EXTENSIONS", ".tiff")
    cal = dict(ndwi_min=0.15, blue_over_red=12, bright_min=55, ndvi_veg=0.2, nir_veg_min=40, pool_g_min=130, pool_b_min=130, pool_ndwi_min=0.4,
               pool_min_m2=6, pool_max_m2=250, solidity_min=0.8, rectfill_min=0.55)
    todo = con.execute("select capture_id, tile_id, cog_url from imagery_tiles where region_id=%s and processed_at is null order by tile_id", (region,)).fetchall()
    left_after = max(0, len(todo) - L.SERVICES["linz_imagery_s3"]["max_tiles_run"]); todo = todo[:L.SERVICES["linz_imagery_s3"]["max_tiles_run"]]   # large regions: in parts
    if not todo:
        n = con.execute("select count(*) from imagery_tiles where region_id=%s", (region,)).fetchone()[0]
        if not n: return "no imagery for this region: pools and gardens skipped"
    else:
        cap = todo[0][0]
        c2 = con.execute("select calibration from imagery_captures where id=%s", (cap,)).fetchone()
        if c2 and c2[0]: cal.update(c2[0])
        est = sum(int(client.request("linz_imagery_s3", "HEAD", u).headers.get("Content-Length", 0)) // 4 for _, _, u in todo[:3])
        client.imagery_allowance(len(todo), est * len(todo) // max(1, min(3, len(todo))))
    done = 0
    for cap, tid, url in todo:
        if time.monotonic() > DEADLINE:
            raise Continue(f"time limit: {done} tiles done this run, {len(todo) - done} left")
        with rasterio.open("/vsicurl/" + url, OVERVIEW_LEVEL=0) as src:
            l, b, r_, t = src.bounds
            env = box(l, b, r_, t).wkb
            secs = con.execute("select parcel_id, st_asbinary(geom) from sections where region_id=%s and st_intersects(geom, st_geomfromwkb(%s,2193))", (region, env)).fetchall()
            blds = con.execute("select st_asbinary(geom) from buildings where st_intersects(geom, st_geomfromwkb(%s,2193))", (env,)).fetchall()
            if not secs:
                con.execute("update imagery_tiles set processed_at=now() where capture_id=%s and tile_id=%s and region_id=%s", (cap, tid, region)); continue
            sg = [(wkb.loads(bytes(g)), int(pid)) for pid, g in secs]; bg = [wkb.loads(bytes(g[0])).buffer(0.3) for g in blds]
            WIN, PAD = 4000, 100
            tallies, rows = {}, []
            for y in range(0, src.height, WIN):
                for x in range(0, src.width, WIN):
                    ry0, rx0 = max(0, y - PAD), max(0, x - PAD); ry1, rx1 = min(src.height, y + WIN + PAD), min(src.width, x + WIN + PAD)
                    win = rasterio.windows.Window(rx0, ry0, rx1 - rx0, ry1 - ry0); tf = src.window_transform(win)
                    a = src.read(window=win).astype(np.int16)
                    if a.shape[0] < 5 or not (a[4] > 0).any(): continue
                    R_, G, B, N, A = a[:5]; h, w = R_.shape; px = abs(tf.a * tf.e)
                    ids = rasterize(sg, out_shape=(h, w), transform=tf, fill=0, dtype="int32")
                    if not ids.any(): continue
                    roof = rasterize(((g, 1) for g in bg), out_shape=(h, w), transform=tf, fill=0, dtype="uint8") if bg else np.zeros((h, w), np.uint8)
                    valid = (A > 0) & (ids > 0); open_ = valid & (roof == 0)
                    nd = lambda p, q: (p - q) / np.maximum(p + q, 1)
                    ndwi, ndvi = nd(G, N), nd(N, R_)
                    water = open_ & (ndwi > cal["ndwi_min"]) & (B - R_ > cal["blue_over_red"]) & ((R_ + G + B) / 3 > cal["bright_min"])
                    veg = open_ & (ndvi > cal["ndvi_veg"]) & (N >= cal["nir_veg_min"])
                    core = np.zeros((h, w), bool); core[y - ry0:min(src.height, y + WIN) - ry0, x - rx0:min(src.width, x + WIN) - rx0] = True
                    for name, m in (("valid", valid), ("open", open_), ("veg", veg)):
                        u, c = np.unique(ids[m & core], return_counts=True)
                        for i, n in zip(u, c):
                            if i: tallies.setdefault(int(i), {"valid": 0, "open": 0, "veg": 0})[name] += n * px
                    mm = cv2.morphologyEx(water.astype(np.uint8), cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
                    mm = cv2.morphologyEx(mm, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
                    k, lab, st, cen = cv2.connectedComponentsWithStats(mm, connectivity=8)
                    for i in range(1, k):
                        cx, cy = cen[i]
                        if not core[int(cy), int(cx)]: continue
                        ar = st[i, cv2.CC_STAT_AREA] * px
                        if not (cal["pool_min_m2"] <= ar <= cal["pool_max_m2"]): continue
                        x0, y0, bw, bh = st[i, :4]; sl = (slice(y0, y0 + bh), slice(x0, x0 + bw)); bm = lab[sl] == i
                        cs, _ = cv2.findContours(bm.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE); cc = max(cs, key=cv2.contourArea)
                        hull = cv2.contourArea(cv2.convexHull(cc)) or 1; (_, _), (rw, rh), _ = cv2.minAreaRect(cc)
                        sol, rf = bm.sum() / hull, bm.sum() / max(rw * rh, 1)
                        f = dict(ndwi=float(ndwi[sl][bm].mean()), r=int(R_[sl][bm].mean()), g=int(G[sl][bm].mean()), b=int(B[sl][bm].mean()),
                                 n=int(N[sl][bm].mean()), solidity=float(sol), rectfill=float(rf), tile=tid)
                        tool = bool(sol >= cal["solidity_min"] and rf >= cal["rectfill_min"] and f["g"] >= cal["pool_g_min"] and f["b"] >= cal["pool_b_min"] and f["ndwi"] >= cal["pool_ndwi_min"])
                        pid = int(np.bincount(ids[sl][bm]).argmax())
                        X, Y = tf * (cx, cy)
                        rows.append((cap, pid or None, float(X), float(Y), float(ar), json.dumps(f), tool))
        with con.cursor() as cur:
            for pid, t in tallies.items():
                cur.execute("""insert into section_imagery (section_id, capture_id, valid_m2, open_m2, veg_m2) values (%s,%s,%s,%s,%s)
                               on conflict (section_id, capture_id) do update set valid_m2 = coalesce(section_imagery.valid_m2,0) + excluded.valid_m2,
                               open_m2 = coalesce(section_imagery.open_m2,0) + excluded.open_m2, veg_m2 = coalesce(section_imagery.veg_m2,0) + excluded.veg_m2""",
                            (pid, cap, round(t["valid"], 2), round(t["open"], 2), round(t["veg"], 2)))
            for r in rows:
                cur.execute("""insert into pool_candidates (capture_id, section_id, geom, area_m2, features, tool_pool)
                               values (%s,%s, st_setsrid(st_makepoint(%s,%s),2193), %s,%s,%s)""", r)
            cur.execute("update imagery_tiles set processed_at=now() where capture_id=%s and tile_id=%s and region_id=%s", (cap, tid, region))
        client.ledger.add("linz_imagery_s3", 0, nbytes=0)
        done += 1
        log(f"tile {tid} ({done} of {len(todo)}): {len(tallies)} sections, {sum(1 for r in rows if r[-1])} pools / {len(rows)} candidates")
        if hasattr(log, "progress"):
            log.progress(done / max(1, len(todo)))
    # roofs and unbuilt area per section (LINZ geometry, SQL)
    con.execute("""update section_imagery si set building_m2 = coalesce(b.a, 0), unbuilt_m2 = greatest(0, s.polygon_m2 - coalesce(b.a, 0))
                   from sections s left join lateral (select sum(st_area(st_intersection(s.geom, bb.geom))) a from buildings bb where st_intersects(s.geom, bb.geom)) b on true
                   where si.section_id = s.parcel_id and s.region_id = %s""", (region,))
    if left_after:
        raise Continue(f"{done} tiles processed this run; {left_after} left: continues in the next run")
    return f"{done} tiles processed this run"


# ---------------------------------------------------------------- publish (new region): suburb_metrics rows, then the shared update
def publish_new(con, client, region, log):
    from .steps import publish
    rows = con.execute("""select su.linz_id, su.name, su.type, su.territorial_authority, st_area(su.geom)/1e6, count(s.*), sum(coalesce(s.n_titles,1)),
                                 percentile_cont(0.5) within group (order by s.polygon_m2), sc.cell_id
                          from suburbs su left join sections s on s.suburb_id = su.linz_id
                          left join suburb_climate_cell sc on sc.linz_id = su.linz_id
                          where su.region_id = %s group by 1,2,3,4,5,9""", (region,)).fetchall()
    cap = (con.execute("select imagery_captures[1] from regions where id=%s", (region,)).fetchone() or [None])[0]
    # PRVDR: the one chosen in the batch configuration, else the TA's provider
    prv = con.execute("""select coalesce(r.prvdr, t.prvdrs[1]) from regions r left join territorial_authorities t on t.code = r.ta_code where r.id=%s""", (region,)).fetchone()
    bins_s = [0, 300, 450, 600, 750, 900, 1100, 1400, 2000, 4000]; bins_g = [0, 50, 100, 200, 300, 400, 600, 800, 1200, 2000]
    for lid, name, typ, ta, km2, n, titles, med, cell in rows:
        dens = (titles or 0) / km2 if km2 else 0
        sparse_big = dens < 300 and (med or 0) > 4000
        ur = ("Rural" if sparse_big else "Urban") if typ == "Suburb" else ("Urban" if dens >= 300 and (med or 0) <= 4000 else "Rural")
        sec = [float(x[0]) for x in con.execute("select polygon_m2 from sections where suburb_id=%s", (lid,)).fetchall()]
        veg = [float(x[0] or 0) for x in con.execute("select si.veg_m2 from section_imagery si join sections s on s.parcel_id=si.section_id where s.suburb_id=%s", (lid,)).fetchall()]
        hs = np.histogram(sec, bins_s + [1e12])[0].tolist() if sec else None; hg = np.histogram(veg, bins_g + [1e12])[0].tolist() if veg else None
        con.execute("""insert into suburb_metrics (linz_id, region_id, name, type, territorial_authority, prvdr, area_km2, sections, titles, density_per_km2,
                         urban_rural, survey_area, hist_section, hist_section_bins, hist_garden, hist_garden_bins, capture_id, climate_cell)
                       values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                       on conflict (linz_id) do update set prvdr=excluded.prvdr, titles=excluded.titles, density_per_km2=excluded.density_per_km2, urban_rural=excluded.urban_rural,
                         hist_section=excluded.hist_section, hist_garden=excluded.hist_garden, capture_id=excluded.capture_id, climate_cell=excluded.climate_cell""",
                    (lid, region, name, typ, ta, prv[0] if prv else None, round(km2, 2), n or None, titles, round(dens), ur if n else None,
                     med, hs, bins_s, hg, bins_g, cap, cell))
    return publish(con, client, region, log) + f"; {len(rows)} suburb rows"


STEPS = {"linz": linz, "imagery_index": imagery_index, "imagery": imagery, "publish_new": publish_new}
