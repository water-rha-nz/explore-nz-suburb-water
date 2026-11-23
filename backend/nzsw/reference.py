"""Reference data loaded once (not per region): TA 2023 outlines for the selection map, joined with the
source index (providers, SA2 counts, run parts). One Stats NZ Datafinder request, through limits.Client.
Usage: python -m nzsw.reference"""
import json, os
import geopandas as gpd
from shapely.geometry import MultiPolygon
from . import limits as L
from .db import connect, DbLedger, sync_rates
from .steps import key

TA_LAYER = 111193   # Territorial Authority 2023 Clipped (generalised)
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def main():
    con = connect(); sync_rates(con)
    client = L.Client(ledger=DbLedger(con))
    k = key("statsnz_datafinder")
    r = client.request("statsnz_datafinder", "GET", f"https://datafinder.stats.govt.nz/services;key={k}/wfs",
                       params=dict(service="WFS", version="2.0.0", request="GetFeature", typeNames=f"layer-{TA_LAYER}",
                                   outputFormat="application/json", srsName="EPSG:2193"),
                       redact=lambda s: s.replace(k, "<key>"), timeout=600)
    if r.status_code != 200:
        raise SystemExit(f"Datafinder HTTP {r.status_code}")
    g = gpd.GeoDataFrame.from_features(r.json()["features"], crs=2193)
    code = next(c for c in g.columns if c.upper() == "TA2023_V1_00")
    name = next(c for c in g.columns if c.upper() == "TA2023_V1_00_NAME")
    ascii_ = next((c for c in g.columns if c.upper() == "TA2023_V1_00_NAME_ASCII"), name)
    idx = json.load(open(os.path.join(ROOT, "index", "source_index.json")))["regions"]
    by = {}
    for e in idx:
        d = by.setdefault(e["ta_code"], dict(prvdrs=set(), sa2=e["sa2_count"], parts=len(e["run_parts"]), rc=e["regional_council"]))
        d["prvdrs"].add(e["prvdr"])
    n = 0
    for _, t in g.iterrows():
        c = str(t[code]).zfill(3)
        if c not in by:
            continue                      # e.g. 999 Area Outside TA
        geom = t.geometry.simplify(50, preserve_topology=True)
        geom = geom if isinstance(geom, MultiPolygon) else MultiPolygon([geom])
        b = by[c]
        con.execute("""insert into territorial_authorities (code, name, name_ascii, regional_council, prvdrs, sa2_count, run_parts, geom)
                       values (%s,%s,%s,%s,%s,%s,%s, st_geomfromwkb(%s, 2193))
                       on conflict (code) do update set name=excluded.name, name_ascii=excluded.name_ascii, prvdrs=excluded.prvdrs,
                       sa2_count=excluded.sa2_count, run_parts=excluded.run_parts, regional_council=excluded.regional_council, geom=excluded.geom""",
                    (c, t[name], t[ascii_], b["rc"], sorted(b["prvdrs"]), b["sa2"], b["parts"], geom.wkb))
        n += 1
    print(f"territorial authorities loaded: {n} (Datafinder layer {TA_LAYER}, simplified 50 m)")


if __name__ == "__main__":
    main()
