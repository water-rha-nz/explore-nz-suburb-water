"""Region preparation steps (docs/SPEC.md sections 17-22), ported from the pilot pipeline.
  linz          suburbs (TA, optionally limited to the region's scope), residential parcels and buildings (paged WFS),
                SA2 boundaries, climate cells (no API)
  imagery_index newest high-resolution RGB+NIR capture covering the region; tiles that hold buildings
  imagery       pools and vegetation per section, read window by window from the COG tiles (resumable)
  publish_new   suburb_metrics rows for a new region (counts, medians, histograms, urban/rural)
All external requests go through limits.Client; all writes are idempotent upserts."""
import hashlib, json, math, os, re, time, datetime as dt
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
    # reuse: suburbs already downloaded (by any user's earlier job) are not downloaded again: those with stored sections, and those
    # marked as downloaded even though they hold no residential sections (industrial, rural, parkland), which otherwise came back
    # in every part and kept the step from finishing
    loaded = {r[0] for r in con.execute("""select su.linz_id from suburbs su where su.linz_id = any(%s)
                                           and (su.sections_fetched_at is not null or exists (select 1 from sections s where s.suburb_id = su.linz_id))""",
                                        (list(sub["id"].astype(int)),))}
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
    con.execute("update suburbs set sections_fetched_at = now() where linz_id = any(%s)", (list(sub["id"].astype(int)),))
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


# Tiles of LINZ aerial imagery are named <sheet><col>_<scale>_<row><col> on one national NZTM grid (Topo50 sheets 24 x 36 km from
# origin E 988000, N 6234000; a tile is 0.48 x 0.72 m per unit of scale), so a tile's footprint follows from its name:
# checked against real tile geometries across captures and scales (all within 5 m).
SHEET_ROWS = "AS AT AU AV AW AX AY AZ BA BB BC BD BE BF BG BH BJ BK BL BM BN BP BQ BR BS BT BU BV BW BX BY BZ CA CB CC CD CE CF CG CH CJ CK".split()


def tile_box(name):
    m = re.match(r"([A-Z]{2})(\d{2})_(\d+)_(\d+)$", name)
    if not m or m.group(1) not in SHEET_ROWS:
        return None
    r, c, scale, idx = SHEET_ROWS.index(m.group(1)), int(m.group(2)), int(m.group(3)), m.group(4)
    h = len(idx) // 2; rr, cc = int(idx[:h]), int(idx[h:])
    w, ht = 0.48 * scale, 0.72 * scale
    x0 = 988000 + c * 24000 + (cc - 1) * w; y1 = 6234000 - r * 36000 - (rr - 1) * ht
    return box(x0, y1 - ht, x0 + w, y1)


def _catalogue(client, log):
    """RGB+NIR collections of the public LINZ imagery catalogue, with extent (lon/lat), year, resolution and tile names."""
    from concurrent.futures import ThreadPoolExecutor
    sess = requests.Session()
    def get(u):
        for i in range(4):
            try:
                r = sess.get(u, timeout=30)
                if r.status_code == 200: return r.json()
            except (requests.RequestException, ValueError):
                pass
            time.sleep(1 + i)
        return None
    root = get(S3 + "catalog.json")
    if not root:
        return None
    hrefs = [l["href"][2:] for l in root.get("links", []) if l.get("rel") == "child" and "/rgbnir/2193/" in l.get("href", "")]
    log(f"imagery catalogue: {len(hrefs)} RGB+NIR captures to check")
    out = []
    with ThreadPoolExecutor(max_workers=16) as ex:
        for href, c in zip(hrefs, ex.map(lambda h: get(S3 + h), hrefs)):
            if not c: continue
            m = re.search(r"_(\d{4})(?:-(\d{4}))?_(\d+(?:\.\d+)?)m/", href)
            if not m: continue
            bb = ((c.get("extent") or {}).get("spatial") or {}).get("bbox") or [[]]
            out.append(dict(prefix=href.split("/rgbnir/")[0], year=int(m.group(2) or m.group(1)), res=float(m.group(3)), bbox=bb[0] if bb and len(bb[0]) == 4 else None,
                            tiles=[l["href"][2:-5] for l in c.get("links", []) if l.get("rel") == "item" and l.get("href", "").endswith(".json")]))
    return out


# coverage is judged per residential section (sections carry region_id, indexed): a section counts as covered when an indexed
# tile of the region overlaps it. Joining every building to every section region-wide was too slow for large regions.
Q_SEC_UNCOVERED = """select count(*) from sections s where s.region_id=%s
                     and not exists (select 1 from imagery_tiles t where t.region_id=%s and t.geom && s.geom and st_intersects(t.geom, s.geom))"""


def _index_ranked(con, region, log, ranked):
    """ranked: (capture id, s3 prefix, year, resolution, tile names) best first. Adds, capture by capture, the tiles that hold
    residential sections not yet covered, until every section is covered. Returns a summary."""
    total = con.execute("select count(*) from sections where region_id=%s", (region,)).fetchone()[0]
    left = con.execute(Q_SEC_UNCOVERED, (region, region)).fetchone()[0]
    reg = con.execute("select st_asbinary(st_extent(geom)::geometry) from sections where region_id=%s", (region,)).fetchone()[0]
    reg_box = wkb.loads(bytes(reg)) if reg else None
    used = []
    for cap, coll, year, res, names in ranked:
        if not left or reg_box is None:
            break
        hit = []
        for tid in names:
            if time.monotonic() > DEADLINE:
                raise Continue(f"time limit while indexing imagery: {len(used)} capture(s) added so far; continues in the next run")
            g = tile_box(tid)
            if g is None or not g.intersects(reg_box): continue
            if con.execute("""select exists (select 1 from sections s where s.region_id=%s and s.geom && st_geomfromwkb(%s,2193)
                                and st_intersects(s.geom, st_geomfromwkb(%s,2193))
                                and not exists (select 1 from imagery_tiles t where t.region_id=%s and t.geom && s.geom and st_intersects(t.geom, s.geom)))""",
                           (region, g.wkb, g.wkb, region)).fetchone()[0]:
                hit.append((tid, g))
        if not hit:
            continue
        con.execute("""insert into imagery_captures (id, s3_prefix, year, resolution_m, bands) values (%s,%s,%s,%s,'RGB+NIR')
                       on conflict (id) do nothing""", (cap, coll, year, res))
        for tid, g in hit:
            base = f"{S3}{coll}/rgbnir/2193/{tid}"
            con.execute("""insert into imagery_tiles (capture_id, tile_id, region_id, cog_url, stac_url, geom) values (%s,%s,%s,%s,%s, st_geomfromwkb(%s,2193))
                           on conflict do nothing""", (cap, tid, region, base + ".tiff", base + ".json", g.wkb))
        left = con.execute(Q_SEC_UNCOVERED, (region, region)).fetchone()[0]
        used.append((cap, year, res, len(hit)))
        log(f"capture {cap} ({year}, {res} m): {len(hit)} tiles added; {left:,} section(s) still without imagery")
    con.execute("update regions set imagery_captures = (select array_agg(distinct capture_id) from imagery_tiles where region_id=%s) where id=%s", (region, region))
    if not used and not con.execute("select 1 from imagery_tiles where region_id=%s limit 1", (region,)).fetchone():
        return "no RGB+NIR imagery covers the region's sections: pools and gardens are not available for this region"
    pct = 100.0 * (total - left) / max(1, total)
    coarse = [u for u in used if u[2] > 0.125]
    return (f"{len(used)} capture(s) added ({', '.join(f'{u[0]} {u[2]} m, {u[3]} tiles' for u in used)}): {pct:.0f}% of residential sections covered"
            + (f"; {len(coarse)} coarser than 12.5 cm, so small pools may be missed there" if coarse else "")
            + (f"; {left:,} section(s) have no RGB+NIR imagery" if left else ""))


def imagery_index(con, client, region, log):
    R = _region(con, region)
    # reuse: tiles already indexed for this region (by any user's job) cover sections that have none of their own
    have = con.execute("select count(*), min(capture_id) from imagery_tiles where region_id=%s", (region,)).fetchone()
    uncovered = con.execute("""select count(*) from sections s where s.region_id=%s and not exists
                               (select 1 from imagery_tiles t where t.region_id=s.region_id and st_intersects(t.geom, s.geom))""", (region,)).fetchone()[0]
    if have[0] and not uncovered:
        return f"reused: {have[0]} tiles already indexed; no imagery listing needed"
    ext = con.execute("select st_xmin(e), st_ymin(e), st_xmax(e), st_ymax(e) from (select st_extent(geom) e from sections where region_id=%s) t", (region,)).fetchone()
    if ext[0] is None:
        return "no buildings stored for the region yet: imagery not indexed"
    reg_box = box(*ext)
    lo = gpd.GeoSeries([reg_box], crs=2193).to_crs(4326).total_bounds
    cat = _catalogue(client, log)
    if cat is None:
        log("imagery catalogue unavailable: searching the region's imagery folders instead")
        return _imagery_index_folders(con, client, region, log, R, reg_box)
    # captures whose extent overlaps the region; best first: 12.5 cm or finer (newest, then finest), then the next-finest
    near = [c for c in cat if c["bbox"] and not (c["bbox"][2] < lo[0] or c["bbox"][0] > lo[2] or c["bbox"][3] < lo[1] or c["bbox"][1] > lo[3])]
    near.sort(key=lambda c: (c["res"] > 0.125, c["res"] if c["res"] > 0.125 else 0, -c["year"], c["res"]))
    log(f"{len(near)} RGB+NIR capture(s) overlap the region")
    return _index_ranked(con, region, log, [(c["prefix"].split("/")[-1], c["prefix"], c["year"], c["res"], c["tiles"]) for c in near])


def _imagery_index_folders(con, client, region, log, R, reg_box):
    """Fallback when the catalogue can't be read: the region's imagery folders from the source index (12.5 cm or finer first,
    then coarser)."""
    idx = {e["ta_code"]: e for e in json.load(open(os.path.join(ROOT, "index", "source_index.json")))["regions"]}
    folders = idx[R["ta_code"]]["imagery_folders"]
    cands = []
    for f in folders:
        _, colls = _s3_list(client, f + "/", "/")
        for c in colls:
            m = re.search(r"_(\d{4})(?:-(\d{4}))?_(\d+(?:\.\d+)?)m/$", c)
            if not m: continue
            year, res = int(m.group(2) or m.group(1)), float(m.group(3))
            k, _ = _s3_list(client, c + "rgbnir/2193/")
            items = [os.path.basename(x)[:-5] for x in k if x.endswith(".json") and "collection" not in x]
            if items: cands.append((year, res, c.rstrip("/"), items))
    cands.sort(key=lambda x: (x[1] > 0.125, x[1] if x[1] > 0.125 else 0, -x[0], x[1]))
    return _index_ranked(con, region, log, [(coll.split("/")[-1], coll, year, res, items) for year, res, coll, items in cands])

# ---------------------------------------------------------------- imagery (pools, vegetation)
def imagery(con, client, region, log):
    import cv2, rasterio
    from rasterio.features import rasterize
    os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
    os.environ.setdefault("CPL_VSIL_CURL_ALLOWED_EXTENSIONS", ".tiff")
    cal = dict(ndwi_min=0.15, blue_over_red=12, bright_min=55, ndvi_veg=0.2, nir_veg_min=40, pool_g_min=130, pool_b_min=130, pool_ndwi_min=0.4,
               pool_min_m2=6, pool_max_m2=250, solidity_min=0.8, rectfill_min=0.55)
    # best capture first (12.5 cm or finer, newest, finest; then coarser), so where captures overlap a section is analysed once,
    # from its best capture
    todo = con.execute("""select t.capture_id, t.tile_id, t.cog_url from imagery_tiles t left join imagery_captures c on c.id = t.capture_id
                          where t.region_id=%s and t.processed_at is null
                          order by (coalesce(c.resolution_m, 0.1) > 0.125), case when coalesce(c.resolution_m, 0.1) > 0.125 then c.resolution_m else 0 end,
                                   c.year desc nulls last, c.resolution_m, t.tile_id""", (region,)).fetchall()
    # progress is shown for the whole region (tiles analysed of all its tiles), not for this run's part
    n_all = con.execute("select count(*) from imagery_tiles where region_id=%s", (region,)).fetchone()[0]; before = n_all - len(todo)
    left_after = max(0, len(todo) - L.SERVICES["linz_imagery_s3"]["max_tiles_run"]); todo = todo[:L.SERVICES["linz_imagery_s3"]["max_tiles_run"]]   # large regions: in parts (the run's time limit also ends a part)
    if not todo:
        n = con.execute("select count(*) from imagery_tiles where region_id=%s", (region,)).fetchone()[0]
        if not n: return "no imagery for this region: pools and gardens skipped"
    else:
        est = sum(int(client.request("linz_imagery_s3", "HEAD", u).headers.get("Content-Length", 0)) // 4 for _, _, u in todo[:3])
        client.imagery_allowance(len(todo), est * len(todo) // max(1, min(3, len(todo))))
    dropped = con.execute("select buildings_dropped_at is not null from regions where id=%s", (region,)).fetchone()[0]
    done, base_cal, cals = 0, dict(cal), {}
    for cap, tid, url in todo:
        if cap not in cals:   # each capture may have its own calibration
            c2 = con.execute("select calibration from imagery_captures where id=%s", (cap,)).fetchone()
            cals[cap] = {**base_cal, **((c2 and c2[0]) or {})}
        cal = cals[cap]
        if time.monotonic() > DEADLINE:
            raise Continue(f"time limit: {before + done:,} of {n_all:,} tiles analysed ({done} this run); continues in the next run")
        with rasterio.open("/vsicurl/" + url, OVERVIEW_LEVEL=0) as src:
            l, b, r_, t = src.bounds
            env = box(l, b, r_, t).wkb
            secs = con.execute("""select parcel_id, st_asbinary(geom) from sections where region_id=%s and st_intersects(geom, st_geomfromwkb(%s,2193))
                                  and not exists (select 1 from section_imagery si where si.section_id = sections.parcel_id and si.capture_id <> %s)""", (region, env, cap)).fetchall()
            blds = con.execute("select st_asbinary(geom) from buildings where st_intersects(geom, st_geomfromwkb(%s,2193))", (env,)).fetchall()
            if not blds and dropped:   # outlines were dropped after an earlier imagery run: fetch this tile's from LINZ, in memory only
                lo = gpd.GeoSeries([box(l, b, r_, t)], crs=2193).to_crs(4326).total_bounds
                fb = _wfs(client, "linz_wfs", LINZ, 101290, bbox=f"{lo[1]},{lo[0]},{lo[3]},{lo[2]},urn:ogc:def:crs:EPSG::4326")
                blds = [(g.wkb,) for g in fb.geometry if g is not None]
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
            log.progress((before + done) / max(1, n_all), f"tiles analysed: {before + done:,} of {n_all:,} for the region")
    # roofs and unbuilt area per section (LINZ geometry, SQL); kept as stored once the region's outlines have been dropped
    if not dropped: con.execute("""update section_imagery si set building_m2 = coalesce(b.a, 0), unbuilt_m2 = greatest(0, s.polygon_m2 - coalesce(b.a, 0))
                   from sections s left join lateral (select sum(st_area(st_intersection(s.geom, bb.geom))) a from buildings bb where st_intersects(s.geom, bb.geom)) b on true
                   where si.section_id = s.parcel_id and s.region_id = %s""", (region,))
    if left_after:
        raise Continue(f"{before + done:,} of {n_all:,} tiles analysed ({done} this run); continues in the next run")
    msg = f"{done} tiles processed this run; " + sample_validation(con, region)
    # every tile analysed and the blind review complete: outlines are no longer needed (roof areas kept per section); the
    # function checks both and returns 0 otherwise (a nightly job retries)
    n = con.execute("select drop_region_buildings(%s)", (region,)).fetchone()[0]
    return msg + (f"; {n:,} building outlines dropped (roof areas kept)" if n else "")


VAL_SAMPLE = dict(accepted=100, rejected=100, garden=60)


def sample_validation(con, region, n=VAL_SAMPLE):
    """Labelling items for the region, once its imagery is analysed: accepted and rejected pool candidates and garden sections,
    a fixed pseudo-random spread (md5 order), each with its centre, section outline and public tile."""
    have = con.execute("select count(*) from validation_items where region_id=%s", (region,)).fetchone()[0]
    if have:
        return f"{have} labelling items already sampled; " + render_review_chips(con, region)
    tile = """join lateral (select t.cog_url from imagery_tiles t where t.region_id = %(r)s and t.capture_id = {cap} and st_intersects(t.geom, {pt})
                            order by t.tile_id limit 1) t on true"""
    outline = "st_asgeojson(st_simplify(s.geom, 0.5), 1)::jsonb -> 'coordinates'"
    for grp, flag in (("accepted", True), ("rejected", False)):
        con.execute(f"""insert into validation_items (task, capture_id, candidate_id, section_id, grp, tool_verdict, region_id, x, y, cog_url, outline)
                        select 'pool', p.capture_id, p.id, p.section_id, %(g)s, %(v)s, %(r)s, st_x(p.geom), st_y(p.geom), t.cog_url, {outline}
                        from pool_candidates p join sections s on s.parcel_id = p.section_id and s.region_id = %(r)s
                        {tile.format(cap="p.capture_id", pt="p.geom")}
                        where p.tool_pool = %(f)s order by md5(p.id::text) limit %(n)s""",
                    dict(g=grp, v="pool" if flag else "not_pool", r=region, f=flag, n=n[grp]))
    con.execute(f"""insert into validation_items (task, capture_id, section_id, grp, tool_verdict, region_id, x, y, cog_url, outline)
                    select 'garden', si.capture_id, s.parcel_id, 'sample', 'measured', %(r)s, st_x(c.p), st_y(c.p), t.cog_url, {outline}
                    from section_imagery si join sections s on s.parcel_id = si.section_id and s.region_id = %(r)s
                    cross join lateral (select st_pointonsurface(s.geom) p) c
                    {tile.format(cap="si.capture_id", pt="c.p")}
                    where si.valid_m2 > 0 and s.polygon_m2 between 200 and 3000 order by md5(s.parcel_id::text) limit %(n)s""",
                dict(r=region, n=n["garden"]))
    k = con.execute("select task, count(*) from validation_items where region_id=%s group by task", (region,)).fetchall()
    d = dict(k)
    return f"labelling items sampled: {d.get('pool', 0)} pool candidates, {d.get('garden', 0)} gardens; " + render_review_chips(con, region)


def _rings(c):
    if not isinstance(c, list) or not c: return []
    return [c] if isinstance(c[0], list) and c[0] and isinstance(c[0][0], (int, float)) else [r for x in c for r in _rings(x)]


def render_review_chips(con, region, max_n=300, S=320):
    """Blind-review chips: each labelling item's image as a plain JPEG (no georeferencing, no metadata) under a random token.
    Pools: the candidate circled in red within its section (yellow). Gardens: the section beside a copy with vegetation in green
    (NDVI rule of the capture). Built from the public LINZ tile; deadline-aware, at most max_n per run."""
    import cv2, rasterio
    from rasterio.windows import from_bounds
    os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
    rows = con.execute("""select v.id, v.task, v.x, v.y, v.cog_url, v.outline, c.calibration from validation_items v
                          left join imagery_captures c on c.id = v.capture_id
                          where v.region_id=%s and v.cog_url is not null and not exists (select 1 from review_chips r where r.item_id = v.id)
                          order by v.id limit %s""", (region, max_n)).fetchall()
    made = failed = 0
    for iid, task, x, y, url, outline, calib in rows:
        if time.monotonic() > DEADLINE:
            break
        try:
            rings = _rings(outline or [])
            pts = [p for r in rings for p in r]
            if task == "pool" or not pts:
                cx, cy, half = float(x), float(y), 20.0
            else:
                xs, ys = [p[0] for p in pts], [p[1] for p in pts]
                cx, cy = (max(xs) + min(xs)) / 2, (max(ys) + min(ys)) / 2
                half = max(15.0, (max(xs) - min(xs)) / 2 + 6, (max(ys) - min(ys)) / 2 + 6)
            b = (cx - half, cy - half, cx + half, cy + half)
            with rasterio.open("/vsicurl/" + url) as src:
                a = src.read(indexes=[1, 2, 3, 4][:src.count], window=from_bounds(*b, transform=src.transform), out_shape=(min(4, src.count), S, S), boundless=True, fill_value=0)
            rgb = np.ascontiguousarray(np.dstack([a[2], a[1], a[0]]).astype(np.uint8))   # BGR for OpenCV
            px = lambda X, Y: (int(round((X - b[0]) / (b[2] - b[0]) * S)), int(round((b[3] - Y) / (b[3] - b[1]) * S)))
            def draw(img):
                for r in rings:
                    cv2.polylines(img, [np.array([px(p[0], p[1]) for p in r], np.int32)], True, (0, 212, 255), 2)
                return img
            img = draw(rgb.copy())
            if task == "pool":
                cv2.circle(img, px(float(x), float(y)), int(S * 0.11), (45, 45, 255), 3)
            elif len(a) >= 4:
                cal = {"ndvi_veg": 0.2, "nir_veg_min": 40, **(calib or {})}
                r_, n_ = a[0].astype(float), a[3].astype(float)
                veg = ((n_ - r_) / np.maximum(1, n_ + r_) > cal["ndvi_veg"]) & (n_ >= cal["nir_veg_min"])
                v = rgb.copy(); v[veg] = (0.45 * v[veg] + 0.55 * np.array([60, 220, 40])).astype(np.uint8)
                img = np.hstack([img, np.full((S, 6, 3), 255, np.uint8), draw(v)])
            ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 85])
            if not ok: raise ValueError("encode")
            con.execute("insert into review_chips (item_id, task, jpeg) values (%s,%s,%s) on conflict (item_id) do nothing", (iid, task, buf.tobytes()))
            made += 1
        except Exception:
            failed += 1
    return f"{made} review chips rendered" + (f", {failed} unreadable" if failed else "")


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


# ---------------------------------------------------------------- learned pool check (labels -> per-capture classifier)
POOL_LABEL = {"pool": 1, "not_pool": 0, "water": 0}   # "unknown" is left out


def _pool_x(feats, area):
    """Model inputs from a candidate's measured features: water index, colour (0-1), colour contrasts, shape, log area."""
    f = feats if isinstance(feats, dict) else json.loads(feats or "{}")
    r, g, b, n = (float(f.get(k, 0)) / 255 for k in ("r", "g", "b", "n"))
    return [float(f.get("ndwi", 0)), r, g, b, n, b - r, g - r, float(f.get("solidity", 0)), float(f.get("rectfill", 0)), math.log1p(float(area or 0))]


def _fit_logistic(X, y, lam=1.0, iters=60):
    """L2-regularised logistic regression by Newton steps (numpy only). Returns (mean, std, weights incl. bias)."""
    mu, sd = X.mean(0), X.std(0) + 1e-9
    Z = np.hstack([np.ones((len(X), 1)), (X - mu) / sd]); w = np.zeros(Z.shape[1]); R = lam * np.eye(Z.shape[1]); R[0, 0] = 0
    for _ in range(iters):
        p = 1 / (1 + np.exp(-Z @ w)); W = p * (1 - p) + 1e-9
        step = np.linalg.solve(Z.T @ (Z * W[:, None]) + R, Z.T @ (y - p) - R @ w); w += step
        if np.abs(step).max() < 1e-6: break
    return mu, sd, w


def _predict(model, X):
    mu, sd, w = model
    return 1 / (1 + np.exp(-(np.hstack([np.ones((len(X), 1)), (X - mu) / sd]) @ w)))


def _pr(pred, y):
    tp = int(((pred == 1) & (y == 1)).sum()); fp = int(((pred == 1) & (y == 0)).sum()); fn = int(((pred == 0) & (y == 1)).sum())
    return (tp / (tp + fp) if tp + fp else None), (tp / (tp + fn) if tp + fn else None)


def model(con, client, region, log, n_uncertain=60):
    """Train the learned pool check per capture from review labels (labellers and the blind second reviewer), score every
    candidate of the region, apply it when it beats the fixed rules on held-back labels (a quarter, by item), and add the
    candidates it is least sure about as the next review round."""
    caps = [r[0] for r in con.execute("""select distinct p.capture_id from pool_candidates p join sections s on s.parcel_id = p.section_id
                                         where s.region_id = %s""", (region,)).fetchall()]
    out = []
    for cap in caps:
        rows = con.execute("""select v.id, p.features, p.area_m2, p.tool_pool, l.label from validation_items v join pool_candidates p on p.id = v.candidate_id
                              join (select item_id, label from validation_labels
                                    union all select c.item_id, r.label from review_chips c join review_labels r on r.token = c.token) l on l.item_id = v.id
                              where v.task = 'pool' and p.capture_id = %s""", (cap,)).fetchall()
        rows = [r for r in rows if r[4] in POOL_LABEL]
        test = np.array([int(hashlib.md5(str(r[0]).encode()).hexdigest(), 16) % 4 == 0 for r in rows], bool)
        y = np.array([POOL_LABEL[r[4]] for r in rows]); X = np.array([_pool_x(r[1], r[2]) for r in rows]) if rows else np.zeros((0, 10))
        tool = np.array([1 if r[3] else 0 for r in rows])
        tr = ~test
        if tr.sum() < 30 or y[tr].sum() < 5 or (1 - y[tr]).sum() < 5:
            out.append(f"{cap}: {len(rows)} usable labels so far; at least 30 (5 pools, 5 not) needed to train")
            continue
        mdl = _fit_logistic(X[tr], y[tr].astype(float))
        tp_, tr_ = _pr(tool[test], y[test]); mp_, mr_ = _pr((_predict(mdl, X[test]) >= 0.5).astype(int), y[test]) if test.any() else (None, None)
        f1 = lambda p, r: 0 if not p or not r else 2 * p * r / (p + r)
        applied = bool(test.sum() >= 8 and f1(mp_, mr_) >= f1(tp_, tr_))
        # score every candidate of this capture in the region
        cand = con.execute("""select p.id, p.features, p.area_m2 from pool_candidates p join sections s on s.parcel_id = p.section_id
                              where s.region_id = %s and p.capture_id = %s""", (region, cap)).fetchall()
        if cand:
            pr = _predict(mdl, np.array([_pool_x(c[1], c[2]) for c in cand]))
            with con.cursor() as cur:
                cur.execute("create temp table if not exists _pm (id bigint, p real)"); cur.execute("truncate _pm")
                with cur.copy("copy _pm (id, p) from stdin") as cp:
                    for c, pv in zip(cand, pr): cp.write_row((int(c[0]), float(pv)))
                cur.execute("update pool_candidates p set p_model = m.p, model_pool = case when %s then m.p >= 0.5 end from _pm m where m.id = p.id", (applied,))
        metrics = dict(train=int(tr.sum()), test=int(test.sum()), tool_precision=tp_, tool_recall=tr_, model_precision=mp_, model_recall=mr_,
                       scored=len(cand), model_pools=int((pr >= 0.5).sum()) if cand else 0, tool_pools=None)
        con.execute("""insert into pool_models (capture_id, trained_at, n_train, n_test, applied, coef, metrics) values (%s, now(), %s, %s, %s, %s, %s)
                       on conflict (capture_id) do update set trained_at = now(), n_train = excluded.n_train, n_test = excluded.n_test, applied = excluded.applied,
                       coef = excluded.coef, metrics = excluded.metrics""",
                    (cap, int(tr.sum()), int(test.sum()), applied, json.dumps(dict(mean=mdl[0].tolist(), std=mdl[1].tolist(), w=mdl[2].tolist())), json.dumps(metrics)))
        fmtp = lambda v: "–" if v is None else f"{100 * v:.0f}%"
        out.append(f"{cap}: trained on {int(tr.sum())} labels, {int(test.sum())} held back; held-back precision/recall fixed rules {fmtp(tp_)}/{fmtp(tr_)}, "
                   f"model {fmtp(mp_)}/{fmtp(mr_)}: {'applied' if applied else 'not applied (fixed rules kept)'}")
    # next review round: the candidates the model is least sure about (only when none from the last round are still unlabelled)
    pending = con.execute("""select count(*) from validation_items v join review_chips c on c.item_id = v.id where v.region_id = %s and v.grp = 'uncertain'
                             and not exists (select 1 from review_labels l where l.token = c.token)""", (region,)).fetchone()[0]
    if not pending and con.execute("select 1 from pool_candidates p join sections s on s.parcel_id = p.section_id where s.region_id=%s and p.p_model is not null limit 1", (region,)).fetchone():
        con.execute("""insert into validation_items (task, capture_id, candidate_id, section_id, grp, tool_verdict, region_id, x, y, cog_url, outline)
                       select 'pool', p.capture_id, p.id, p.section_id, 'uncertain', 'uncertain', %(r)s, st_x(p.geom), st_y(p.geom), t.cog_url,
                              st_asgeojson(st_simplify(s.geom, 0.5), 1)::jsonb -> 'coordinates'
                       from pool_candidates p join sections s on s.parcel_id = p.section_id and s.region_id = %(r)s
                       join lateral (select t.cog_url from imagery_tiles t where t.region_id = %(r)s and t.capture_id = p.capture_id and st_intersects(t.geom, p.geom)
                                     order by t.tile_id limit 1) t on true
                       where p.p_model is not null and not exists (select 1 from validation_items v where v.candidate_id = p.id)
                       order by abs(p.p_model - 0.5) limit %(n)s""", dict(r=region, n=n_uncertain))
        out.append(render_review_chips(con, region) + " for the next review round (least certain candidates)")
    return "; ".join(out) or "no pool candidates in the region"


STEPS = {"linz": linz, "imagery_index": imagery_index, "imagery": imagery, "model": model, "publish_new": publish_new}
