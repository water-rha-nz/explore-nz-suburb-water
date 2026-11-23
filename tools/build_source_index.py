#!/usr/bin/env python3
"""Build the per-region source index: every API request needed to prepare one territorial
authority (TA), as templates. NOTHING HERE CALLS THE DATA APIS. The index is consumed by the
back-end worker (docs/SPEC.md section 17), which resolves placeholders and runs the requests.

Inputs
  --lookup  path to suburb_lookup.html (the WATER constant gives providers and their TAs)
  --geo     Stats NZ code list CL_CEN23_GEO_013 (SDMX structure XML). This is reference
            metadata (RC > TA > SA2 hierarchy); fetch once with:
            curl -H "Ocp-Apim-Subscription-Key: $STATSNZ_ADE_KEY" \
              https://api.data.stats.govt.nz/rest/codelist/STATSNZ/CL_CEN23_GEO_013/latest
Outputs
  index/source_index.json   one entry per TA with request templates and dependencies
  index/regions.csv         one row per TA (provider, region, SA2 count, imagery folders)

Placeholders in templates (resolved by the worker at run time):
  {LINZ_API_KEY} {STATSNZ_DATAFINDER_KEY} {STATSNZ_ADE_KEY}   secrets, never stored
  {bbox_wgs84}      "minLat,minLon,maxLat,maxLon" of the TA's suburbs (from step linz.suburbs)
  {sa2_codes}       '+'-joined SA2 codes for one chunk (ADE) or quoted list (Datafinder)
  {lat_list} {lon_list}  suburb representative points (from linz.suburbs)
  {start_date} {end_date}  climate period, e.g. 2008-01-01 .. last full month
  {collection}      an nz-imagery collection prefix chosen from imagery.list
  {count} {startIndex}  WFS paging
"""
import argparse, json, re, unicodedata, csv, os, datetime as dt
import xml.etree.ElementTree as ET

LINZ_WFS = "https://data.linz.govt.nz/services;key={LINZ_API_KEY}/wfs"
DF_WFS = "https://datafinder.stats.govt.nz/services;key={STATSNZ_DATAFINDER_KEY}/wfs"
ADE = "https://api.data.stats.govt.nz/rest"
S3 = "https://nz-imagery.s3-ap-southeast-2.amazonaws.com/"
OPENMETEO = "https://archive-api.open-meteo.com/v1/archive"

LAYERS = {  # LINZ Data Service (CC BY 4.0)
    "suburbs": (113764, "NZ Suburbs and Localities"),
    "parcels": (50772, "NZ Primary Parcels"),
    "titles": (50804, "NZ Property Titles (no owners)"),
    "buildings": (101290, "NZ Building Outlines"),
    "addresses": (105689, "NZ Addresses (verify layer ID before first run)"),
}
SA2_LAYER = 111206          # Stats NZ Datafinder: Statistical Area 2 2023 Clipped (generalised)
SA2_FIELD = "SA22023_V1_00"
ADE_TABLES = {
    "CEN23_HOU_020": "bedrooms x tenure x private dwelling type (BRooms, Owner, housing type)",
    "CEN23_FHH_038": "household composition by usual residents x bedrooms (HhSize)",
    "CEN23_HOU_001": "basic amenities x total household income x tenure (Income median)",
    "CEN23_HOU_018": "dwelling occupancy status x dwelling type",
}
ADE_DIMS = {  # dimension order (position) per dataflow; geography dimension gets the SA2 codes
    "CEN23_HOU_020": ["CEN23_YEAR_001", "CEN23_GEO_013", "CEN23_NRD_002", "CEN23_THD_001", "CEN23_DTD_004"],
    "CEN23_FHH_038": ["CEN23_YEAR_001", "CEN23_GEO_013", "CEN23_HUH_001", "CEN23_NRD_002"],
    "CEN23_HOU_001": ["CEN23_YEAR_001", "CEN23_GEO_013", "CEN23_HOD_002", "CEN23_TIH_001", "CEN23_THD_001"],
    "CEN23_HOU_018": ["CEN23_YEAR_001", "CEN23_GEO_012", "CEN23_DOD_002", "CEN23_DTD_002"],
}
ADE_CHUNK = 150             # SA2 codes per request (keeps URLs well under 8 KB)

# nz-imagery top-level folders by regional council (Stats NZ RC code)
RC_FOLDER = {"01": "northland", "02": "auckland", "03": "waikato", "04": "bay-of-plenty", "05": "gisborne",
             "06": "hawkes-bay", "07": "taranaki", "08": "manawatu-whanganui", "09": "wellington",
             "12": "west-coast", "13": "canterbury", "14": "otago", "15": "southland", "16": "tasman",
             "17": "nelson", "18": "marlborough", "99": "chatham-islands"}
# Stats NZ TA code -> regional council code (the code list carries TA > SA2 but not RC > TA)
TA_RC = {**{c: "01" for c in ("001", "002", "003")}, **{f"{c:03d}": "03" for c in range(11, 22)},
         **{f"{c:03d}": "04" for c in range(22, 28)}, "028": "05", **{f"{c:03d}": "06" for c in range(29, 33)},
         **{f"{c:03d}": "07" for c in range(33, 36)}, **{f"{c:03d}": "08" for c in range(36, 43)},
         **{f"{c:03d}": "09" for c in range(43, 51)}, "051": "16", "052": "17", "053": "18", "054": "13",
         **{f"{c:03d}": "12" for c in range(55, 58)}, **{f"{c:03d}": "13" for c in range(58, 67)}, "067": "99",
         "068": "13", **{f"{c:03d}": "14" for c in range(69, 73)}, **{f"{c:03d}": "15" for c in range(73, 76)}, "076": "02"}
# TAs whose boundaries cross regional councils (the code list gives one parent); imagery may sit in either folder
SPANS = {"Taupo District": ["03", "04", "06", "08"], "Rotorua District": ["04", "03"], "Waitomo District": ["03", "08"],
         "Rangitikei District": ["08", "06"], "Tararua District": ["08", "09"], "Waitaki District": ["14", "13"],
         "Stratford District": ["07", "08"]}


def ascii_(s):
    return unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().replace("'", "'")


def parse_water(html):
    s = open(html, encoding="utf-8").read()
    blk = s[s.find("const WATER"):]
    out = []
    for m in re.finditer(r'\{ provider: "([^"]+)", prvd: "([^"]+)", aliases: \[([^\]]*)\], territories: \[([^\]]*)\], charging: "([^"]*)"', blk):
        end = blk.find("checks:", m.end())
        body = blk[m.end():end if end > 0 else m.end() + 3000]
        out.append(dict(provider=m.group(1), prvdr=m.group(2), territories=re.findall(r'"([^"]+)"', m.group(4)),
                        charging=m.group(5), sources=[dict(title=t, url=u) for t, u in re.findall(r'\{ t: "([^"]+)", u: "([^"]+)" \}', body)]))
    return out


def parse_geo(xml):
    root = ET.parse(xml).getroot()
    ns = {"s": "http://www.sdmx.org/resources/sdmxml/schemas/v2_1/structure",
          "c": "http://www.sdmx.org/resources/sdmxml/schemas/v2_1/common"}
    nodes = {}
    for code in root.iter("{%s}Code" % ns["s"]):
        name = code.find("c:Name[@{http://www.w3.org/XML/1998/namespace}lang='en']", ns)
        par = code.find("s:Parent/Ref", ns)
        nodes[code.get("id")] = dict(name=name.text if name is not None else code.get("id"), parent=par.get("id") if par is not None else None)
    return nodes


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lookup", required=True)
    ap.add_argument("--geo", required=True)
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "index"))
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)

    water = parse_water(a.lookup)
    geo = parse_geo(a.geo)
    kids = {}
    for c, n in geo.items():
        kids.setdefault(n["parent"], []).append(c)
    # TA codes are 3 digits under the national TA total (999999); SA2s are 6-digit descendants (via local boards in Auckland)
    ta_codes = {c: n for c, n in geo.items() if re.fullmatch(r"\d{3}", c) and n["parent"] == "999999"}
    by_name = {ascii_(n["name"]).lower(): c for c, n in ta_codes.items()}
    by_name.update({"hutt city": by_name.get("lower hutt city")})   # renamed 2019; Stats NZ keeps "Lower Hutt City"

    def sa2s(code):
        out, stack = [], [code]
        while stack:
            for k in kids.get(stack.pop(), []):
                (out if re.fullmatch(r"\d{6}", k) else stack).append(k)
        return sorted(set(out))

    entries, unmatched = [], []
    for p in water:
        for ta in p["territories"]:
            code = by_name.get(ascii_(ta).lower()) or by_name.get(ascii_(ta).lower().replace(" territory", ""))
            if not code:
                unmatched.append(ta); continue
            rc = TA_RC.get(code)
            rcs = SPANS.get(ta, [rc])
            codes = sa2s(code)
            names = sorted({ta, ascii_(ta_codes[code]["name"])})        # provider spelling and Stats NZ spelling
            ta_in = ",".join("'" + n.replace("'", "''") + "'" for n in names)
            reqs = []

            def wfs(step, base, layer, extra, desc, depends=None, page=False):
                params = dict(service="WFS", version="2.0.0", request="GetFeature", typeNames=f"layer-{layer}",
                              outputFormat="application/json", srsName="EPSG:4326")
                params.update(extra)
                if page: params.update(count="{count}", startIndex="{startIndex}")
                reqs.append(dict(step=step, service=base[0], method="GET", url=base[1], params=params, auth=base[2],
                                 depends_on=depends or [], paging="WFS count/startIndex until fewer than count returned" if page else None,
                                 output=desc))
            L = ("LINZ LDS WFS", LINZ_WFS, "key in URL path: {LINZ_API_KEY}")
            wfs("linz.suburbs", L, LAYERS["suburbs"][0], {"cql_filter": f"territorial_authority_ascii IN ({ta_in})"},
                "suburb polygons for the TA; gives {bbox_wgs84}, {lat_list}, {lon_list}")
            for k in ("parcels", "titles", "buildings", "addresses"):
                wfs(f"linz.{k}", L, LAYERS[k][0], {"bbox": "{bbox_wgs84},urn:ogc:def:crs:EPSG::4326"},
                    f"{LAYERS[k][1]} in the TA bbox (clip to suburbs after download)", ["linz.suburbs"], page=True)
            DF = ("Stats NZ Datafinder WFS", DF_WFS, "key in URL path: {STATSNZ_DATAFINDER_KEY}")
            for i in range(0, max(1, len(codes)), ADE_CHUNK):
                chunk = codes[i:i + ADE_CHUNK]
                wfs(f"statsnz.sa2[{i // ADE_CHUNK}]", DF, SA2_LAYER, {"cql_filter": f"{SA2_FIELD} IN ({','.join(repr(c) for c in chunk)})"},
                    f"SA2 2023 boundaries, {len(chunk)} SA2s")
            for df, desc in ADE_TABLES.items():
                for i in range(0, max(1, len(codes)), ADE_CHUNK):
                    chunk = codes[i:i + ADE_CHUNK]
                    key = ".".join("+".join(chunk) if d.startswith("CEN23_GEO") else "" for d in ADE_DIMS[df])
                    reqs.append(dict(step=f"statsnz.ade.{df}[{i // ADE_CHUNK}]", service="Stats NZ ADE (SDMX 2.1)", method="GET",
                                     url=f"{ADE}/data/STATSNZ,{df},1.0/{key}", params={"dimensionAtObservation": "AllDimensions"},
                                     headers={"Ocp-Apim-Subscription-Key": "{STATSNZ_ADE_KEY}", "Accept": "application/vnd.sdmx.data+csv;labels=both"},
                                     auth="header", depends_on=[], output=f"{desc}; 2013/2018/2023; {len(chunk)} SA2s"))
            folders = [RC_FOLDER[r] for r in rcs if r in RC_FOLDER]
            for f in folders:
                reqs.append(dict(step=f"imagery.list[{f}]", service="LINZ imagery (AWS Open Data, no key)", method="GET", url=S3,
                                 params={"list-type": "2", "prefix": f"{f}/", "delimiter": "/"}, auth=None, depends_on=[],
                                 output="collection prefixes; keep those with an rgbnir/2193/ folder, newest urban capture first"))
            reqs.append(dict(step="imagery.items", service="LINZ imagery (AWS Open Data, no key)", method="GET", url=S3,
                             params={"list-type": "2", "prefix": "{collection}/rgbnir/2193/", "continuation-token": "{token}"}, auth=None,
                             depends_on=["imagery.list[*]", "linz.suburbs"],
                             output="STAC item JSON keys; fetch each item, keep tiles intersecting buildings in {bbox_wgs84} (COG tiles read by window)"))
            reqs.append(dict(step="climate.daily", service="Open-Meteo archive (no key, non-commercial)", method="GET", url=OPENMETEO,
                             params={"latitude": "{lat_list}", "longitude": "{lon_list}", "start_date": "{start_date}", "end_date": "{end_date}",
                                     "daily": "precipitation_sum,temperature_2m_mean,temperature_2m_max,et0_fao_evapotranspiration",
                                     "timezone": "Pacific/Auckland"}, auth=None, depends_on=["linz.suburbs"],
                             output="daily climate per suburb point; send at most 100 points per request (each point counts as an API call on the free tier); dedupe by returned grid cell. Do not pass models=era5_land (no rain/ET0)"))
            for s in p["sources"]:
                reqs.append(dict(step="water_rates.source", service="Provider website (manual review)", method="GET", url=s["url"], params={},
                                 auth=None, depends_on=[], output=f"published charges: {s['title']}"))
            entries.append(dict(ta=ta, ta_code=code, ta_name_statsnz=ta_codes[code]["name"], regional_council_code=rc,
                                regional_council=geo.get(rc, {}).get("name"), imagery_folders=folders, prvdr=p["prvdr"], provider=p["provider"],
                                charging_type=p["charging"], sa2_count=len(codes), sa2_codes=codes, requests=reqs))

    meta = dict(generated=dt.date.today().isoformat(), executes_nothing=True, tas=len(entries), providers=len({e["prvdr"] for e in entries}),
                unmatched_territories=unmatched, linz_layers={k: dict(id=v[0], name=v[1]) for k, v in LAYERS.items()},
                datafinder_sa2_layer=SA2_LAYER, ade_tables=ADE_TABLES, ade_dimension_order=ADE_DIMS, imagery_bucket=S3,
                keys_required=["LINZ_API_KEY", "STATSNZ_DATAFINDER_KEY", "STATSNZ_ADE_KEY"],
                run_order=["linz.suburbs", "linz.parcels|titles|buildings|addresses", "statsnz.sa2", "statsnz.ade.*", "imagery.list -> imagery.items -> worker imagery job",
                           "climate.daily", "water_rates.source (editor review)"])
    json.dump(dict(meta=meta, regions=entries), open(os.path.join(a.out, "source_index.json"), "w"), indent=1, ensure_ascii=False)
    with open(os.path.join(a.out, "regions.csv"), "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["TA", "TA_CODE", "REGIONAL_COUNCIL", "PRVDR", "PROVIDER", "CHARGING_TYPE", "SA2_COUNT", "IMAGERY_FOLDERS", "REQUESTS"])
        for e in sorted(entries, key=lambda e: e["ta_code"]):
            w.writerow([e["ta"], e["ta_code"], e["regional_council"], e["prvdr"], e["provider"], e["charging_type"], e["sa2_count"],
                        " ".join(e["imagery_folders"]), len(e["requests"])])
    print(f"{len(entries)} TAs, {meta['providers']} providers, {sum(e['sa2_count'] for e in entries)} SA2s, "
          f"{sum(len(e['requests']) for e in entries)} request templates; unmatched: {unmatched}")


if __name__ == "__main__":
    main()
