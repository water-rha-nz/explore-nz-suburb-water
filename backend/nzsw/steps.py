"""Worker steps. Every external call goes through limits.Client (budgets, pacing, throttling).
Each step is idempotent: re-running it after a pause continues where it stopped."""
import io, json, math, os, re, datetime as dt
import numpy as np, pandas as pd
from . import limits as L

ADE = "https://api.data.stats.govt.nz/rest"
OPENMETEO = "https://archive-api.open-meteo.com/v1/archive"
DAILY = ["precipitation_sum", "temperature_2m_mean", "temperature_2m_max", "et0_fao_evapotranspiration"]
ADE_TABLES = {
    "CEN23_HOU_020": ["CEN23_YEAR_001", "CEN23_GEO_013", "CEN23_NRD_002", "CEN23_THD_001", "CEN23_DTD_004"],
    "CEN23_FHH_038": ["CEN23_YEAR_001", "CEN23_GEO_013", "CEN23_HUH_001", "CEN23_NRD_002"],
    "CEN23_HOU_001": ["CEN23_YEAR_001", "CEN23_GEO_013", "CEN23_HOD_002", "CEN23_TIH_001", "CEN23_THD_001"],
}


USER_KEYS = {}   # set per job by cli.run_steps: the job creator's keys from Vault (name -> key)


def key(name):
    """The job creator's key (Supabase Vault) if they set one, else the project key: environment (GitHub
    secrets) first, then ~/.config files for local runs."""
    if USER_KEYS.get(name):
        return USER_KEYS[name]
    env = {"statsnz_ade": "STATSNZ_ADE_KEY", "statsnz_datafinder": "STATSNZ_DATAFINDER_KEY", "linz": "LINZ_API_KEY", "openmeteo": "OPENMETEO_API_KEY"}[name]
    if os.environ.get(env):
        return os.environ[env]
    f = {"statsnz_ade": "~/.config/statsnz/ade_key", "statsnz_datafinder": "~/.config/statsnz/datafinder_key", "linz": "~/.config/linz/api_key",
         "openmeteo": "~/.config/openmeteo/api_key"}[name]
    f = os.path.expanduser(f)
    return open(f).read().strip() if os.path.exists(f) else None


# ---------------------------------------------------------------- climate top-up (Open-Meteo, per grid cell)
def climate(con, client, region, log):
    cells = con.execute("""select c.id, c.lat, c.lon, max(d.date) from climate_cells c join suburb_climate_cell sc on sc.cell_id = c.id
                           join suburbs s on s.linz_id = sc.linz_id left join climate_daily d on d.cell_id = c.id
                           where s.region_id = %s group by 1, 2, 3""", (region,)).fetchall()
    if not cells:
        return "no climate cells for region (run the region setup first)"
    end = (dt.date.today() - dt.timedelta(days=2)).isoformat()   # archive lags ~2 days
    added = 0
    for cid, lat, lon, last in cells:
        start = (last + dt.timedelta(days=1)).isoformat() if last else L.RUN_CAPS["climate_backfill_start"]
        if start > end:
            continue
        w = L.openmeteo_weight(1, len(DAILY), start, end)
        omk = key("openmeteo")   # a commercial key (optional) uses Open-Meteo's customer API
        p = dict(latitude=float(lat), longitude=float(lon), start_date=start, end_date=end, daily=",".join(DAILY), timezone="Pacific/Auckland")
        if omk: p["apikey"] = omk
        r = client.request("openmeteo", "GET", OPENMETEO.replace("://archive-api", "://customer-archive-api") if omk else OPENMETEO, cost=w, params=p,
                           redact=(lambda t: t.replace(omk, "<key>")) if omk else (lambda t: t))
        if r.status_code != 200:
            raise RuntimeError(f"Open-Meteo HTTP {r.status_code}: {r.text[:200]}")
        d = r.json()["daily"]
        with con.cursor() as cur:
            for i, t in enumerate(d["time"]):
                if d["precipitation_sum"][i] is None:
                    continue
                cur.execute("""insert into climate_daily (cell_id, date, rain_mm, tmean_c, tmax_c, et0_mm) values (%s,%s,%s,%s,%s,%s)
                               on conflict (cell_id, date) do nothing""", (cid, t, d["precipitation_sum"][i], d["temperature_2m_mean"][i],
                                                                         d["temperature_2m_max"][i], d["et0_fao_evapotranspiration"][i]))
                added += 1
        log(f"climate cell {cid}: {start}..{end} (~{w:.1f} weighted calls)")
    return f"{added} new daily rows across {len(cells)} cells"


# ---------------------------------------------------------------- census (Stats NZ ADE) -> census_metrics -> suburb_census
def _ade_csv(client, df, codes):
    H = {"Ocp-Apim-Subscription-Key": key("statsnz_ade"), "Accept": "application/vnd.sdmx.data+csv;labels=both"}
    k = ".".join("+".join(codes) if d.startswith("CEN23_GEO") else "" for d in ADE_TABLES[df])
    r = client.request("statsnz_ade", "GET", f"{ADE}/data/STATSNZ,{df},1.0/{k}", params={"dimensionAtObservation": "AllDimensions"}, headers=H,
                       redact=lambda s: s.replace(H["Ocp-Apim-Subscription-Key"], "<key>"))
    if r.status_code != 200:
        raise RuntimeError(f"ADE {df}: HTTP {r.status_code}")
    t = pd.read_csv(io.StringIO(r.text), dtype=str)
    t.columns = [c.split(":")[0] for c in t.columns]
    for c in t.columns:
        if c.startswith("CEN23"):
            t[c] = t[c].str.split(":").str[0].str.strip()
    t["v"] = pd.to_numeric(t.OBS_VALUE, errors="coerce")
    geo = [c for c in t.columns if c.startswith("CEN23_GEO")][0]
    return t.rename(columns={"CEN23_YEAR_001": "year", geo: "sa2"})


def census(con, client, region, log):
    codes = [r[0] for r in con.execute("select distinct sa2_code from sections where region_id=%s and sa2_code is not null order by 1", (region,))]
    if not codes:
        return "no SA2s for region"
    if len(codes) > L.RUN_CAPS["max_sa2_per_run"]:
        raise L.RunTooLarge(f"{len(codes)} SA2s exceeds {L.RUN_CAPS['max_sa2_per_run']} per run")
    # reuse: census values already stored for an SA2 (fetched by anyone) are not requested again
    have = {r[0] for r in con.execute("select distinct sa2_code from census_metrics where sa2_code = any(%s)", (codes,))}
    need = [c for c in codes if c not in have]
    log(f"census: {len(have)} SA2(s) reused, {len(need)} to fetch")
    if not need:
        _apportion(con, region)
        return f"all {len(codes)} SA2s reused from stored census data (0 requests); suburb census rebuilt"
    codes = need
    h = pd.concat([_ade_csv(client, "CEN23_HOU_020", codes[i:i + 150]) for i in range(0, len(codes), 150)])
    f = pd.concat([_ade_csv(client, "CEN23_FHH_038", codes[i:i + 150]) for i in range(0, len(codes), 150)])
    inc = pd.concat([_ade_csv(client, "CEN23_HOU_001", codes[i:i + 150]) for i in range(0, len(codes), 150)])
    idx = lambda t, **kw: t.loc[np.logical_and.reduce([t[k] == v for k, v in kw.items()])].set_index(["sa2", "year"]).v
    out = pd.DataFrame({"households": idx(h, CEN23_NRD_002="999", CEN23_THD_001="9999", CEN23_DTD_004="999")})
    for k, code in {"all": "999", "separate": "11", "joined": "12"}.items():
        if k != "all":
            out[f"pct_{k}"] = 100 * idx(h, CEN23_NRD_002="999", CEN23_THD_001="9999", CEN23_DTD_004=code) / out.households
        out[f"bedrooms_mean_{k}"] = idx(h, CEN23_NRD_002="Mean", CEN23_THD_001="9999", CEN23_DTD_004=code)
        own = idx(h, CEN23_NRD_002="999", CEN23_THD_001="001", CEN23_DTD_004=code).add(idx(h, CEN23_NRD_002="999", CEN23_THD_001="003", CEN23_DTD_004=code), fill_value=0)
        out[f"pct_owner_{k}"] = 100 * own / idx(h, CEN23_NRD_002="999", CEN23_THD_001="7777", CEN23_DTD_004=code)
    sizes = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight or more": 8.5}
    lab = f.CEN23_HUH_001.unique()
    # composition-by-size codes: 4-digit codes whose last digit is the number of usual residents, plus one-person households
    size_of = {c: (8.5 if c[-1] == "8" else int(c[-1])) for c in lab if re.fullmatch(r"\d{4}", c) and c[-1] in "2345678"}
    size_of.update({c: 1 for c in lab if c == "5"})
    ff = f[(f.CEN23_NRD_002 == "999") & f.CEN23_HUH_001.isin(size_of)].copy()
    ff["nv"] = ff.CEN23_HUH_001.map(size_of) * ff.v
    g = ff.groupby(["sa2", "year"])[["nv", "v"]].sum()
    out["hh_size_mean"] = g.nv / g.v.replace(0, np.nan)
    out["income_median"] = idx(inc, CEN23_HOD_002="99", CEN23_TIH_001="Median", CEN23_THD_001="9999")
    out = out.reset_index()
    cols = [c for c in out.columns if c not in ("sa2", "year")]
    with con.cursor() as cur:
        for _, r in out.iterrows():
            vals = [None if pd.isna(r[c]) else float(r[c]) for c in cols]
            cur.execute(f"""insert into census_metrics (sa2_code, year, {','.join(cols)}) values (%s,%s,{','.join(['%s'] * len(cols))})
                            on conflict (sa2_code, year) do update set {','.join(f'{c}=excluded.{c}' for c in cols)}""", (r.sa2, int(r.year), *vals))
    _apportion(con, region)
    return f"{len(out)} SA2-year rows; suburb census rebuilt (weighted by sections)"


def _apportion(con, region):
    with con.cursor() as cur:
        # SA2 -> suburb, weighted by residential sections (same rule as the reference builder)
        cur.execute("""insert into suburb_census (linz_id, year, sa2s, sections, hh_size_mean, income_median, bedrooms_mean_all, pct_owner_all,
                         pct_separate, pct_joined, bedrooms_mean_separate, bedrooms_mean_joined, pct_owner_separate, pct_owner_joined)
                       select s.suburb_id, m.year, count(distinct m.sa2_code), count(*),
                         sum(m.hh_size_mean)/count(m.hh_size_mean), sum(m.income_median)/count(m.income_median),
                         avg(m.bedrooms_mean_all), avg(m.pct_owner_all), avg(m.pct_separate), avg(m.pct_joined), avg(m.bedrooms_mean_separate),
                         avg(m.bedrooms_mean_joined), avg(m.pct_owner_separate), avg(m.pct_owner_joined)
                       from sections s join census_metrics m on m.sa2_code = s.sa2_code
                       where s.region_id = %s group by s.suburb_id, m.year
                       on conflict (linz_id, year) do update set sa2s=excluded.sa2s, sections=excluded.sections, hh_size_mean=excluded.hh_size_mean,
                         income_median=excluded.income_median, bedrooms_mean_all=excluded.bedrooms_mean_all, pct_owner_all=excluded.pct_owner_all,
                         pct_separate=excluded.pct_separate, pct_joined=excluded.pct_joined, bedrooms_mean_separate=excluded.bedrooms_mean_separate,
                         bedrooms_mean_joined=excluded.bedrooms_mean_joined, pct_owner_separate=excluded.pct_owner_separate, pct_owner_joined=excluded.pct_owner_joined""",
                    (region,))



# ---------------------------------------------------------------- publish: suburb metrics from section-level results (SQL)
def publish(con, client, region, log):
    con.execute("""
      with sec as (
        select s.suburb_id, s.parcel_id, s.polygon_m2, coalesce(s.n_titles, 1) n_titles, si.capture_id, si.building_m2, si.unbuilt_m2, si.veg_m2, si.valid_m2,
               exists (select 1 from pool_candidates p where p.section_id = s.parcel_id and p.capture_id = si.capture_id and p.tool_pool) has_pool,
               (select sum(p.area_m2) from pool_candidates p where p.section_id = s.parcel_id and p.capture_id = si.capture_id and p.tool_pool) pool_m2
        from sections s join section_imagery si on si.section_id = s.parcel_id where s.region_id = %(r)s)
      update suburb_metrics m set
        sections = a.n, pools = a.pools, perc_pool = round(100.0 * a.pools / nullif(a.n, 0), 1), pool_area = a.pool_area,
        lot_size = a.lot, footprint = a.foot, unbuilt = a.unbuilt, gard_size = a.veg, gard_pct = a.vegpct,
        impervious_proxy = a.unbuilt - a.veg, shared_pct = a.shared, updated_at = now()
      from (select suburb_id, count(*) n, count(*) filter (where has_pool) pools,
              round((percentile_cont(0.5) within group (order by pool_m2) filter (where has_pool))::numeric, 1) pool_area,
              round(percentile_cont(0.5) within group (order by polygon_m2)::numeric) lot,
              round(percentile_cont(0.5) within group (order by building_m2)::numeric) foot,
              round(percentile_cont(0.5) within group (order by unbuilt_m2)::numeric) unbuilt,
              round(percentile_cont(0.5) within group (order by veg_m2)::numeric) veg,
              round((100 * percentile_cont(0.5) within group (order by veg_m2 / nullif(valid_m2, 0)))::numeric, 1) vegpct,
              round(100.0 * count(*) filter (where n_titles > 1) / count(*), 1) shared
            from sec group by suburb_id) a
      where m.linz_id = a.suburb_id""", {"r": region})
    n = con.execute("select count(*) from suburb_metrics where region_id=%s", (region,)).fetchone()[0]
    return f"suburb metrics recomputed for {n} suburbs"


# imagery (pools, vegetation) and LINZ re-loads run from the pilot pipeline for now; see docs/SPEC.md 17 / backend/README.md
STEPS = {"climate": climate, "census": census, "publish": publish}
