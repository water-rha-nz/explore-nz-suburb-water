// Live layer for the real app: replaces the demo's simulated parts with Supabase (auth, data, jobs, rates,
// labelling, admin). Loaded after the demo script; uses its helpers ($, esc, fmt, V, STAGES, render, ...).
"use strict";
const sb = supabase.createClient(SB_URL, SB_KEY, { auth: { flowType: "pkce", detectSessionInUrl: true, persistSession: true } });
let SESSION = null, PROFILE = null, STATIC = null;
const LIVE = { jobs: [], runs: [], usage: [], rates: {}, labelQueue: [], labelPos: 0, labelling: false, chipUrls: {} };
const multi = (g) => (g.type === "Polygon" ? [g.coordinates] : g.coordinates);
const q = async (p) => { const { data, error } = await p; if (error) throw new Error(error.message); return data; };
const today = () => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------- auth gate
function gate(kind, msg) {
  document.querySelector("nav.stages").hidden = true;
  $("#region").closest("label").hidden = true;
  $("#who").innerHTML = SESSION ? esc(SESSION.user.email) : "";
  $("#signin").textContent = SESSION ? "Sign out" : "Sign in with Google";
  const g = '<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.6 13.2l7.9 6.1C12.4 13.7 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.7c4.3-4 6.9-9.9 6.9-17.1z"/><path fill="#FBBC05" d="M10.5 28.7A14.5 14.5 0 0 1 9.5 24c0-1.6.3-3.2.8-4.7l-7.9-6.1A24 24 0 0 0 0 24c0 3.9.9 7.5 2.6 10.8l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.7c-2.1 1.4-4.8 2.3-8.5 2.3-6.3 0-11.6-4.2-13.5-9.9l-7.9 6.1C6.6 42.6 14.6 48 24 48z"/></svg>';
  const body = {
    signin: `<section style="max-width:880px;margin:24px auto 0">
      <p class="small muted" style="margin:0 0 6px">Aotearoa New Zealand · residential water demand</p>
      <h1 style="font-size:2rem;line-height:1.2;margin:0 0 12px">NZ Suburb Water Profiles</h1>
      <p class="lead" style="font-size:1.05rem">Suburb-level metadata for water-demand analysis, prepared one region at a time from LINZ, Stats NZ and Open-Meteo data: swimming pools and garden area from aerial imagery, section and roof sizes, household size, income, bedrooms and tenure, daily climate, and water charges.</p>
      <div class="grid g3" style="margin:18px 0">
        <div class="card"><h3>Prepare</h3><p class="small muted" style="margin:0">Load a region, detect pools and gardens, join census and climate, within each service's free-tier limits.</p></div>
        <div class="card"><h3>Validate</h3><p class="small muted" style="margin:0">Label image chips with the arrow keys; precision and recall decide what is published.</p></div>
        <div class="card"><h3>Export</h3><p class="small muted" style="margin:0">Download files compatible with the reference builder, plus a suburb × year panel for modelling.</p></div>
      </div>
      <div class="card" style="max-width:420px"><button class="gbtn" id="go-google" type="button">${g} Sign in with Google</button>
      <p class="small muted" style="margin:10px 0 0">Access is for approved users only. New accounts are reviewed by an admin. Only your name, email and Google account ID are used.</p></div>
      <p class="small muted">Code Apache-2.0 · data CC BY 4.0 · <a href="${REPO}">source and specification</a></p></section>`,
    pending: `<h1>Waiting for approval</h1><p class="lead">You're signed in as <b>${esc(SESSION && SESSION.user.email)}</b>. An admin needs to approve your account before you can see data. Your current status is <b>${esc(PROFILE ? PROFILE.status : "unknown")}</b>.</p>`,
    error: `<h1>Something went wrong</h1><p class="lead">${esc(msg || "")}</p><p><button class="btn" type="button" onclick="location.reload()">Try again</button></p>`,
  }[kind];
  $("#main").innerHTML = body;
  const b = $("#go-google"); if (b) b.onclick = signIn;
}
const signIn = () => sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo: location.origin + location.pathname } });
$("#signin").addEventListener("click", async () => { if (SESSION) { await sb.auth.signOut(); location.reload(); } else signIn(); });
sb.auth.onAuthStateChange((ev) => { if (ev === "SIGNED_OUT") location.reload(); });

// ---------------------------------------------------------------- data (DB -> the structure the stages already use)
async function loadRegion(r) {
  const mets = await q(sb.from("suburb_metrics").select("*").eq("region_id", r.id));
  const outl = await q(sb.rpc("region_outlines", { p_region: r.id, p_kind: "suburbs" }));
  const sa2o = await q(sb.rpc("region_outlines", { p_region: r.id, p_kind: "sa2", p_tol: 15 }));
  const ids = mets.map((m) => m.linz_id);
  const cens = ids.length ? await q(sb.from("suburb_census").select("*").in("linz_id", ids)) : [];
  const cm = sa2o.length ? await q(sb.from("census_metrics").select("*").in("sa2_code", sa2o.map((x) => x.id))) : [];
  const cells = [...new Set(mets.map((m) => m.climate_cell).filter(Boolean))];
  const monthly = cells.length ? await q(sb.from("v_climate_monthly").select("*").in("cell_id", cells).order("month")) : [];
  const vs = await q(sb.from("validation_summary").select("*").eq("region_id", r.id));
  const caps = await q(sb.from("imagery_captures").select("*").in("id", r.imagery_captures || []));
  const st = (STATIC.regions || {})[r.id] || {};
  const climate_cells = {};
  for (const c of cells) {
    const rows = monthly.filter((m) => m.cell_id === c);
    const daily = await q(sb.from("climate_daily").select("date,rain_mm,et0_mm,tmax_c").eq("cell_id", c).gte("date", "2024-07-01").order("date"));
    climate_cells[c] = { months: rows.map((m) => m.month.slice(0, 7)), rain: rows.map((m) => +m.rain_mm), et0: rows.map((m) => +m.et0_mm), tmean: rows.map((m) => +m.tmean_c), tmax: rows.map((m) => +m.tmax_c),
      daily: { start: daily.length ? daily[0].date : today(), rain: daily.map((d) => +d.rain_mm), et0: daily.map((d) => +d.et0_mm), tmax: daily.map((d) => +d.tmax_c) } };
  }
  const seasonal = (cell) => {
    const rows = monthly.filter((m) => m.cell_id === cell), byY = {};
    for (const m of rows) { const y = +m.month.slice(0, 4), mo = +m.month.slice(5, 7); if (mo !== 2 && mo !== 6) continue; const s = mo === 2 ? "summer_feb" : "winter_jun";
      const o = byY[y] = byY[y] || { year: y }; o["rain_mm_" + s] = +m.rain_mm; o["et0_mm_" + s] = +m.et0_mm; o["deficit_mm_" + s] = +m.et0_mm - +m.rain_mm; o["tmean_c_" + s] = +m.tmean_c; }
    return Object.values(byY).sort((a, b) => a.year - b.year);
  };
  const annual = (cell) => { const rows = monthly.filter((m) => m.cell_id === cell && +m.month.slice(0, 4) >= 2008 && +m.month.slice(0, 4) <= 2025); const yrs = new Set(rows.map((m) => m.month.slice(0, 4))).size || 1;
    return rows.length ? { rain_mm: rows.reduce((t, m) => t + +m.rain_mm, 0) / yrs, et0_mm: rows.reduce((t, m) => t + +m.et0_mm, 0) / yrs, tmean_c: rows.reduce((t, m) => t + +m.tmean_c, 0) / rows.length } : null; };
  const censusOf = (rows, keyf) => { const o = {}; for (const c of rows) { const y = String(c.year); o[y] = { ...c }; } return o; };
  const suburbs = outl.map((o) => {
    const m = mets.find((x) => String(x.linz_id) === String(o.id)) || {};
    return { linz_id: +o.id, name: o.name, type: m.type, ta: m.territorial_authority, area_km2: m.area_km2, geom: multi(o.geom),
      sections: m.sections ?? null, titles: m.titles, hh_count_proxy: m.titles, density_per_km2: m.density_per_km2, urban_rural: m.urban_rural,
      PercPool: m.perc_pool, PoolArea: m.pool_area, pools: m.pools, LotSize: m.lot_size, SurveyArea: m.survey_area, Footprint: m.footprint,
      Unbuilt: m.unbuilt, GardSize: m.gard_size, GardPct: m.gard_pct, ImperviousProxy: m.impervious_proxy, UnbuiltPerTitle: m.unbuilt_per_title,
      SharedPct: m.shared_pct, hist_section: m.hist_section || [], hist_bins_section: m.hist_section_bins || [], hist_garden: m.hist_garden || [], hist_bins_garden: m.hist_garden_bins || [],
      census: censusOf(cens.filter((c) => c.linz_id === +o.id)), climate_seasonal: m.climate_cell ? seasonal(m.climate_cell) : [], grid: m.climate_cell || null,
      climate_annual: m.climate_cell ? annual(m.climate_cell) : null };
  });
  const cap = caps[0] || {};
  return { label: r.name, ta: (r.territorial_authorities || [])[0], imagery: cap.id ? `${cap.id} (LINZ, ${cap.bands || "RGB+NIR"})` : "–", imagery_prefix: cap.s3_prefix || "",
    capture_id: cap.id, ta_code: r.ta_code, timeline: r.timeline || {}, provider: (mets[0] || {}).prvdr || st.provider, lonlat: st.lonlat || null, status: r.status, suburbs,
    sa2: sa2o.map((a) => ({ code: a.id, name: a.name, geom: multi(a.geom), census: censusOf(cm.filter((c) => c.sa2_code === a.id)) })),
    climate_cells, validation: (vs[0] || {}).stats || st.validation, validation_tiles: st.validation_tiles || {}, validation_items: st.validation_items || [],
    source_plan: st.source_plan, area_check: st.area_check };
}
// sign-in loads only an index of the regions (one row each); a region's suburbs, census and climate load when needed
async function loadAll() {
  const regions = await q(sb.from("regions").select("id,name,territorial_authorities,suburb_names,imagery_captures,status,created_at,ta_code,scope,batch_id,prvdr,timeline").order("id"));
  const rates = await q(sb.from("water_rates").select("prvdr,charging_type,fixed_pa,volumetric_pa,threshold_lpd,date_est,note,source_url,providers(name)"));
  const d = { generated: today(), regions: {}, nz_regions: STATIC.nz_regions, limits: STATIC.limits, index_regions: STATIC.index_regions,
    water_rates: rates.map((r) => ({ PROVIDER: r.prvdr, name: (r.providers || {}).name || r.prvdr, CHARGING_TYPE: r.charging_type, FIXED_PA: r.fixed_pa, VOLUMETRIC_PA: r.volumetric_pa,
      THRESHOLD_Lpd: r.threshold_lpd, DATE_EST: r.date_est, NOTE: r.note, source: r.source_url, year: "2026/27" })) };
  d.cen = await q(sb.rpc("region_centroids")); d.index = regions; d.empty = {};
  // M_SUBURB names saved by editors
  const ms = await q(sb.from("m_suburbs").select("id,region_id,m_suburb,m_suburb_links(linz_id)"));
  edits = {}; for (const m of ms) for (const l of m.m_suburb_links || []) edits[m.region_id + ":" + l.linz_id] = m.m_suburb;
  return d;
}
// household_ref export: sections from the database (paged; PostgREST returns at most 1,000 rows per request)
loadSections = async function () {
  if (SECT) return;
  const names = {}; for (const [k, g] of Object.entries(D.regions)) for (const s of g.suburbs) names[s.linz_id] = [k, s.name];
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const page = await q(sb.from("sections").select("parcel_id,polygon_m2,n_titles,suburb_id,region_id").order("parcel_id").range(from, from + 999));
    for (const r of page) { const n = Math.max(1, r.n_titles || 1), nm = names[r.suburb_id] || [r.region_id, ""];
      rows.push([nm[0], nm[1], r.parcel_id, n > 1 ? "Shared" : "Freehold", +r.polygon_m2, n, Math.round(10 * r.polygon_m2 / n) / 10]); }
    if (page.length < 1000) break;
  }
  SECT = { rows };
};

// ---------------------------------------------------------------- allocate: persist M_SUBURB names (editors)
document.addEventListener("change", async (e) => {
  const t = e.target; if (!t.dataset || !t.dataset.msub || !can("editor")) return;
  const s = R().suburbs.find((x) => String(x.linz_id) === t.dataset.msub); const name = t.value.trim();
  try {
    const old = await q(sb.from("m_suburb_links").select("m_suburb_id").eq("linz_id", s.linz_id));
    if (old.length) await q(sb.from("m_suburbs").delete().in("id", old.map((o) => o.m_suburb_id)));
    if (name && name !== s.name) {
      const [m] = await q(sb.from("m_suburbs").insert({ region_id: region, m_suburb: name, m_territory: s.ta, prvdr: R().provider }).select("id"));
      await q(sb.from("m_suburb_links").insert({ m_suburb_id: m.id, linz_id: s.linz_id, share_rule: "full" }));
    }
    toastMsg(`Saved M_SUBURB for ${s.name}`);
  } catch (err) { toastMsg("Not saved: " + err.message); }
});
function toastMsg(m) { let el = $("#live-toast"); if (!el) { el = document.createElement("div"); el.id = "live-toast"; el.className = "tip"; el.style.cssText = "left:50%;bottom:20px;top:auto;transform:translateX(-50%)"; document.body.appendChild(el); }
  el.textContent = m; el.classList.add("show"); clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove("show"), 2200); }

// ---------------------------------------------------------------- jobs + download panel (editors)
async function refreshJobs() {
  if (!can("editor")) return;
  LIVE.jobs = await q(sb.from("jobs").select("id,type,status,reason,params,created_at,finished_at,not_before").eq("region_id", region).order("id", { ascending: false }).limit(8));
  const ids = LIVE.jobs.map((j) => j.id);
  LIVE.runs = ids.length ? await q(sb.from("job_runs").select("job_id,step,status,log,started_at").in("job_id", ids).order("id")) : [];
  LIVE.usage = await q(sb.from("api_usage").select("service,cost,bytes").eq("period", "day").eq("bucket", today()));
  const r = await q(sb.from("app_settings").select("value").eq("key", "rates").maybeSingle()); LIVE.rates = (r && r.value) || {};
  const el = $("#jobs"); if (el) el.innerHTML = jobsHTML();
  const dp = $("#dl-panel"); if (dp) dp.innerHTML = dlHTML();
}
jobsHTML = function () {
  if (!can("editor")) return "";
  if (!LIVE.jobs.length) return `<p class="small muted">No jobs for this region yet.</p>`;
  const tag = (s) => `<span class="tag ${s === "done" ? "ok" : s === "failed" ? "bad" : s === "running" ? "warn" : "info"}">${esc(s)}</span>`;
  return LIVE.jobs.map((j) => `<div class="job" style="display:block"><div class="row" style="justify-content:space-between"><span>#${j.id} ${esc(j.type)} · ${esc(((j.params || {}).steps || []).join(", "))}</span>${tag(j.status)}</div>
    ${Object.values(Object.fromEntries(LIVE.runs.filter((r) => r.job_id === j.id).map((r) => [r.step, r]))).map((r) => `<div class="small muted">${esc(r.step)}: ${tag(r.status)} ${esc((r.log || "").slice(0, 160))}</div>`).join("")}
    ${j.not_before && j.status !== "done" ? `<div class="small muted">resumes after ${esc(new Date(j.not_before).toLocaleString())}</div>` : ""}</div>`).join("");
};
const LIVE_SVCS = [["openmeteo", "Open-Meteo"], ["statsnz_ade", "Stats NZ census API"], ["statsnz_datafinder", "Stats NZ Datafinder"], ["linz_wfs", "LINZ data service"]];
dlHTML = function () {
  if (!can("editor")) return `<p class="small muted">Download rates and today's usage are visible to editors.</p>`;
  const L = D.limits || {}, de = L.defaults || {}, ce = L.ceilings || {};
  return LIVE_SVCS.map(([k, name]) => {
    const used = +((LIVE.usage.find((u) => u.service === k) || {}).cost || 0), rate = Math.min((LIVE.rates[k] || {}).per_min || (de[k] || {}).per_min || 60, (ce[k] || {}).per_min || 60);
    const budget = Math.min((LIVE.rates[k] || {}).budget_day || (de[k] || {}).budget_day || 0, (ce[k] || {}).budget_day || 0), pct = budget ? Math.min(100, 100 * used / budget) : 0;
    return `<div class="dl-row"><div><b class="small">${name}</b><br><span class="small muted">${fmt(used)} / ${fmt(budget)} today${k === "openmeteo" ? " (weighted)" : ""}</span></div>
      <div><div class="bar-out" role="progressbar" aria-valuenow="${Math.round(pct)}" aria-valuemin="0" aria-valuemax="100" aria-label="${name} usage today"><div class="bar-in" style="width:${pct.toFixed(1)}%;${pct >= 100 ? "background:var(--bad)" : ""}"></div></div>
      <span class="small muted">${pct >= 100 ? "daily budget used: jobs needing it are parked until tomorrow (UTC)" : `${fmt(budget - used)} left today`}</span></div>
      <div><label class="small">${fmt(rate)}/min <span class="muted">(default ${fmt((de[k] || {}).per_min)}, ceiling ${fmt((ce[k] || {}).per_min)})</span>
      <input type="range" min="${Math.max(1, Math.round(((de[k] || {}).per_min || 4) / 4))}" max="${(ce[k] || {}).per_min || 60}" step="1" value="${rate}" data-live-rate="${k}" aria-label="${name} requests per minute"></label></div></div>`;
  }).join("") + `<p class="small muted" style="margin:8px 0 0">Rates are saved to <code>app_settings.rates</code> and read by the worker before each request, capped at each ceiling. A rate that gets throttled is halved automatically.</p>`;
};
document.addEventListener("change", async (e) => {
  const k = e.target.dataset && e.target.dataset.liveRate; if (!k || !can("editor")) return;
  const ce = ((D.limits || {}).ceilings || {})[k] || {}; const v = Math.min(+e.target.value, ce.per_min || 60);
  const next = { ...LIVE.rates, [k]: { ...(LIVE.rates[k] || {}), per_min: v, changed_at: new Date().toISOString() } };
  try { await q(sb.from("app_settings").upsert({ key: "rates", value: next })); LIVE.rates = next; toastMsg(`${k}: ${fmt(v)}/min saved`); }
  catch (err) { toastMsg("Not saved: " + err.message); }
  const dp = $("#dl-panel"); if (dp) dp.innerHTML = dlHTML();
});
document.addEventListener("click", async (e) => {
  if (e.target.id !== "queue-live" || !can("editor")) return;
  const steps = [...document.querySelectorAll("[data-step]:checked")].map((x) => x.value);
  if (!steps.length) return toastMsg("Choose at least one step");
  try { await q(sb.from("jobs").insert({ type: "refresh", region_id: region, params: { steps }, status: "queued" })); toastMsg("Job queued: the worker picks it up on its next run"); refreshJobs(); }
  catch (err) { toastMsg("Not queued: " + err.message); }
});
const _vRegion = V.region;
// 1 Region: an overview of the data already in the database (loaded once at sign-in; no queries, no jobs here).
// Queuing jobs, job progress and download rates are on 3 Load.
const LOADING = {};
// load one region's detail (once); regions without prepared data are remembered as empty
async function ensureRegion(id, progress) {
  if (!id || D.regions[id] || D.empty[id]) return D.regions[id];
  if (LOADING[id]) return LOADING[id];
  const r = (D.index || []).find((x) => x.id === id); if (!r) return null;
  return (LOADING[id] = (async () => { if (progress) progress(r);
    try { const g = await loadRegion(r); if (g.suburbs.length) { g.lonlat = (D.cen || {})[r.id] || g.lonlat; D.regions[id] = g; rememberLoaded(); } else D.empty[id] = true; }
    finally { delete LOADING[id]; } return D.regions[id]; })());
}
async function ensureRegions(ids, progress) { let i = 0; for (const id of ids) { if (progress) progress(++i, ids.length, ((D.index || []).find((x) => x.id === id) || {}).name || id); await ensureRegion(id); } }
const rememberLoaded = () => store.set("loaded-regions", JSON.stringify(Object.keys(D.regions)));
const indexOf = (id) => (D.index || []).find((x) => x.id === id) || {};
// regions known to the study in the header (or all), from the index
const studyIndex = () => { const st = typeof studyOf === "function" ? studyOf() : null; return (D.index || []).filter((r) => !st || (st.ta_codes || []).includes(r.ta_code)); };
// stages that work on one region load it first
for (const id of ["imagery", "validate", "context", "explore", "export"]) { const f = V[id]; if (!f) continue;
  V[id] = (...a) => { if (D.regions[region]) return f(...a);
    if (!region || D.empty[region]) return `<h1>0 · ${esc((STAGES.find((x) => x[0] === id) || [])[1] || id)}</h1><p class="lead">${region && D.empty[region] ? `${esc(indexOf(region).name || region)} has no prepared data yet.` : "No region chosen."} Choose a region with data in the header, or load one on <b>1 · Overview</b>.</p>`;
    ensureRegion(region).then(() => render()).catch((e) => toastMsg("Region not loaded: " + e.message));
    return `<section role="status" style="max-width:520px;margin:48px auto;text-align:center"><div style="width:32px;height:32px;margin:0 auto 12px;border-radius:50%;border:4px solid var(--line);border-top-color:var(--accent);animation:nzsw-spin .9s linear infinite"></div><style>@keyframes nzsw-spin{to{transform:rotate(360deg)}}</style><p class="lead">Loading ${esc(indexOf(region).name || region)}…</p><p class="small muted">Suburbs, census, climate and imagery results</p></section>`; }; }
{ const fx = V.explore; if (fx) V.explore = (...a) => { const inner = fx(...a); return D.regions[region] ? detailedOverviewHTML() + '<hr style="margin:24px 0;border:0;border-top:1px solid var(--line)">' + inner : inner; }; }
// landing map: TA outlines (cached) and each region's suburb outlines, simplified and without data; click a region to load it
const LAND = { outl: {}, busy: false };
async function drawLanding() {
  const host = $("#land-map"); if (!host) return;
  try { if (!BATCH.tas) BATCH.tas = await q(sb.rpc("ta_outlines", { p_tol: 200 })); } catch (e) { BATCH.tas = BATCH.tas || []; }
  const rows = studyIndex(), need = rows.filter((r) => !LAND.outl[r.id]);
  if (need.length && !LAND.busy) { LAND.busy = true;
    Promise.all(need.map((r) => q(sb.rpc("region_outlines", { p_region: r.id, p_kind: "suburbs", p_tol: 60 })).then((o) => { LAND.outl[r.id] = o.map((x) => ({ name: x.name, geom: multi(x.geom) })); }).catch(() => { LAND.outl[r.id] = []; })))
      .then(() => { LAND.busy = false; if (stage === "region") drawLanding(); }); }
  const byTa = new Map(rows.map((r) => [r.ta_code, r]));
  const base = (BATCH.tas || []).filter((t) => t.geom && t.geom.coordinates).map((t) => { const r = byTa.get(t.code);
    return r ? { attr: `data-land-reg="${esc(r.id)}"`, click: true, d: pathD(t.geom.coordinates), fill: D.regions[r.id] ? "var(--accent-soft)" : "#eef3f8", stroke: "var(--accent)", sw: 1.2, title: `${r.name}: ${D.regions[r.id] ? "loaded" : D.empty[r.id] ? "no prepared data yet" : "click to load"}` }
      : { d: pathD(t.geom.coordinates), fill: "var(--land)", stroke: "var(--landline)", sw: 0.5, title: t.name }; });
  const subs = rows.flatMap((r) => (LAND.outl[r.id] || []).map((x) => ({ attr: `data-land-reg="${esc(r.id)}"`, click: true, d: pathD(x.geom), fill: D.regions[r.id] ? "var(--accent)" : "#ffffff", op: D.regions[r.id] ? 0.55 : 0.75, sw: 0.6, title: `${x.name} (${r.name}): ${D.regions[r.id] ? "loaded" : "click to load the region"}` })));
  const focus = (BATCH.tas || []).filter((t) => byTa.has(t.code)).map((t) => t.geom.coordinates);
  const nz = (BATCH.tas || []).length ? mapBox(BATCH.tas.map((t) => t.geom.coordinates)) : [0, 0, 1, 1];
  host.innerHTML = zoomMap("land", [...base, ...subs], nz) + `<p class="small muted" style="margin:6px 0 0">Regions in the database are outlined in blue, with their suburbs; click one to load it (loaded regions are filled). ${LAND.busy ? "Loading suburb outlines…" : ""}</p>`;
  const svg = host.querySelector && host.querySelector("svg"); if (svg && svg.setAttribute && !(BATCH.view && BATCH.view.id === "land")) setView(svg, focus.length ? mapBox(focus) : nz);
}
document.addEventListener("click", async (e) => {
  const el = e.target.closest && e.target.closest("[data-land-reg]"); if (!el || window._dragMoved || stage !== "region") return;
  const id = el.dataset.landReg; if (D.regions[id] || D.empty[id]) { region = id; store.set("region", id); return render(); }
  toastMsg(`Loading ${indexOf(id).name || id}…`);
  try { await ensureRegion(id); region = id; store.set("region", id); } catch (err) { toastMsg("Not loaded: " + err.message); }
  render();
});
// 1 Overview: a light landing page from the index; detail loads only for the regions you choose
V.region = () => {
  setTimeout(() => drawLanding().catch(() => {}), 0);
  const rows = studyIndex(), st = typeof studyOf === "function" ? studyOf() : null, loaded = rows.filter((r) => D.regions[r.id]), last = JSON.parse(store.get("loaded-regions", "[]")).filter((id) => !D.regions[id] && rows.some((r) => r.id === id));
  const tag = (r) => D.regions[r.id] ? '<span class="tag ok">loaded</span>' : D.empty[r.id] ? '<span class="tag">no data yet</span>' : LOADING[r.id] ? '<span class="tag warn">loading…</span>' : "";
  return `<h1>1 · Overview</h1><p class="lead">${st ? `Study <b>${esc(st.name)}</b>: ` : ""}${rows.length} region${rows.length === 1 ? "" : "s"} in the database${rows.length ? `, ${rows.filter((r) => r.status === "published").length} published` : ""}. Nothing is loaded until you choose: load the regions you want, then explore them on <b>3 · Load</b> or <b>Explore</b> (data map, comparisons and sources).</p>
    ${rows.length ? `<div class="row" style="gap:8px;margin:8px 0">${rows.some((r) => !D.regions[r.id] && !D.empty[r.id]) ? `<button class="btn primary" type="button" id="ov-load-all">Load ${st ? "this study's" : "all"} regions (${rows.filter((r) => !D.regions[r.id] && !D.empty[r.id]).length})</button>` : ""}
      ${last.length ? `<button class="btn" type="button" id="ov-load-last">Load last session's regions (${last.length})</button>` : ""}
      ${loaded.length ? `<button class="btn" type="button" data-goto-stage="explore">Explore loaded regions (${loaded.length}) →</button>` : ""}</div>
    <div class="grid" style="grid-template-columns:minmax(0,1.2fr) minmax(300px,1fr);gap:12px;align-items:start"><div class="card" id="land-map"><p class="muted small">Loading map…</p></div>
    <div class="card scroll"><table><thead><tr><th class="l">Region</th><th class="l">TA</th><th class="l">PRVDR</th><th class="l">Status</th><th class="l">Prepared</th><th class="l">Detail</th></tr></thead><tbody>
    ${rows.map((r) => `<tr${r.id === region ? ' style="background:var(--accent-soft)"' : ""}><td class="l"><b>${esc(r.name)}</b></td><td class="l">${esc((r.territorial_authorities || [])[0] || "–")}</td><td class="l">${esc(r.prvdr || "–")}</td>
      <td class="l"><span class="tag ${r.status === "published" ? "ok" : r.status === "draft" ? "warn" : "info"}">${esc(r.status || "–")}</span></td><td class="l small">${esc((r.created_at || "").slice(0, 10))}</td>
      <td class="l">${tag(r) || `<button class="btn" type="button" data-ov-load="${esc(r.id)}" style="padding:1px 8px">Load</button>`}</td></tr>`).join("")}</tbody></table></div></div>` : `<div class="card"><p>${st ? `The study <b>${esc(st.name)}</b> has no regions in the database yet.` : "No regions in the database yet."} Prepare them in <b>2 · Configure</b> and <b>3 · Load</b>.</p></div>`}`;
};
document.addEventListener("click", async (e) => {
  const t = e.target, b = t.closest && t.closest("[data-ov-load],#ov-load-all,#ov-load-last,[data-goto-stage]"); if (!b) return;
  if (b.dataset.gotoStage) { stage = b.dataset.gotoStage; store.set("stage", stage); render(); return scrollTo(0, 0); }
  const ids = b.dataset.ovLoad ? [b.dataset.ovLoad] : b.id === "ov-load-last" ? JSON.parse(store.get("loaded-regions", "[]")) : studyIndex().map((r) => r.id).filter((id) => !D.regions[id] && !D.empty[id]);
  b.disabled = true;
  try { await ensureRegions(ids, (i, n, name) => { b.textContent = `Loading ${i} of ${n}: ${name}…`; }); if (b.dataset.ovLoad) region = b.dataset.ovLoad; }
  catch (err) { toastMsg("Not loaded: " + err.message); }
  render();
});
// the detailed overview (data map, regions table, comparisons, sources): shown on 3 Load and Explore, for the loaded regions
function regionPicker() {
  const rows = studyIndex(); if (!rows.length) return "";
  return `<div class="row small" style="gap:6px;flex-wrap:wrap;margin:6px 0 10px"><span class="muted">Regions on the map:</span>${rows.map((r) => D.regions[r.id] ? `<span class="tag ok">${esc(r.name)}</span>` : D.empty[r.id] ? `<span class="tag" title="No prepared data yet">${esc(r.name)}</span>` : `<button class="btn" type="button" data-ov-load="${esc(r.id)}" style="padding:0 8px">+ ${esc(r.name)}</button>`).join("")}</div>`;
}
function detailedOverviewHTML() {
  setTimeout(() => { drawDataMap().then(() => { if (MAPV.sel) suburbInfo(MAPV.sel, MAPV.selSet); }).catch((e) => { const m = $("#mv-map"); if (m) m.innerHTML = `<p class="small muted">Map unavailable: ${esc(e.message)}</p>`; }); }, 0);
  const regs = studyRegions(), st = studyOf();
  if (!regs.length) return `<h2>Data overview</h2>${regionPicker()}<p class="lead">${st ? `No region of the study <b>${esc(st.name)}</b> is loaded yet.` : "No region is loaded yet."} Load regions above (or on <b>1 · Overview</b>) to see them on the map.</p>
    <div style="margin-top:12px">${dataMapHTML()}</div>${sourcesHTML()}`;
  const g = (regs.find(([k]) => k === region) || regs[0])[1];
  const yrs = (x) => [...new Set(x.suburbs.flatMap((s) => Object.keys(s.census || {})))].sort().join(", ") || "–";
  const clim = (x) => { const c = Object.values(x.climate_cells || {}); if (!c.length) return "–"; const m = c.flatMap((y) => y.months || []).filter(Boolean).sort(), n = `${c.length} cell${c.length === 1 ? "" : "s"}`; return m.length ? `${n}, ${m[0].slice(0, 4)}–${m[m.length - 1].slice(0, 4)}` : `${n}, no months yet`; };
  const row = (k, x) => { const sub = x.suburbs.filter(resident), pools = sub.reduce((t, s) => t + (+s.pools || 0), 0);
    return { k, name: x.label, ta: x.ta || "–", prvdr: x.provider || "–", suburbs: x.suburbs.length, housing: sub.length, sections: sub.reduce((t, s) => t + (s.sections || 0), 0), sa2: x.sa2.length,
      imagery: x.capture_id || "–", pools, garden: sub.some((s) => s.GardSize != null), census: yrs(x), climate: clim(x), status: x.status || "–" }; };
  const rows = regs.map(([k, x]) => row(k, x)), tot = (f) => rows.reduce((t, r) => t + r[f], 0);
  const cell = (v) => typeof v === "number" ? fmt(v) : esc(v);
  return `<h2>Data overview</h2>${regionPicker()}<p class="lead">${st ? `Study <b>${esc(st.name)}</b>: ${rows.length} loaded region${rows.length === 1 ? "" : "s"}.` : `${rows.length} loaded region${rows.length === 1 ? "" : "s"}.`} Click a region on the map or in the table to explore it in the later stages. To prepare more, use <b>2 · Configure</b>; jobs and download rates are on <b>3 · Load</b>.</p>
  <div class="kpis">
    <div class="kpi"><span>Regions</span><b>${fmt(rows.length)}</b></div><div class="kpi"><span>LINZ suburbs (with housing)</span><b>${fmt(tot("suburbs"))}</b><span>${fmt(tot("housing"))}</span></div>
    <div class="kpi"><span>Residential sections</span><b>${fmt(tot("sections"))}</b></div><div class="kpi"><span>SA2 areas</span><b>${fmt(tot("sa2"))}</b></div>
    <div class="kpi"><span>Pools detected</span><b>${fmt(tot("pools"))}</b></div><div class="kpi"><span>Water providers</span><b>${fmt(new Set(rows.map((r) => r.prvdr)).size)}</b></div></div>
  <div style="margin-top:12px">${dataMapHTML()}</div>
  <div class="grid g2" style="margin-top:12px">
    <div class="card"><h3>Selected region: ${esc(g.label)}</h3>
      <table><tbody>
        <tr><td>Territorial authority</td><td>${esc(g.ta || "–")}</td></tr>
        <tr><td>Water provider (PRVDR)</td><td>${esc(g.provider || "–")}</td></tr>
        <tr><td>LINZ suburbs (with housing)</td><td>${g.suburbs.length} (${g.suburbs.filter(resident).length})</td></tr>
        <tr><td>Residential sections</td><td>${fmt(g.suburbs.filter(resident).reduce((a, s) => a + s.sections, 0))}</td></tr>
        <tr><td>SA2 areas</td><td>${g.sa2.length}</td></tr>
        <tr><td>Imagery capture</td><td class="l" style="white-space:normal">${esc(g.imagery)}</td></tr>
        <tr><td>Census years</td><td>${esc(yrs(g))}</td></tr>
        <tr><td>Climate (Open-Meteo)</td><td>${esc(clim(g))}</td></tr>
        <tr><td>Status</td><td><span class="tag ${g.status === "published" ? "ok" : g.status === "draft" ? "warn" : "info"}">${esc(g.status || "–")}</span></td></tr>
      </tbody></table></div>
    <div class="card"><h3>About this overview</h3><p class="small">Everything shown comes from data already prepared and stored, loaded once when you signed in. Choose one statistic to colour the suburbs, add pool, green-space and rainfall symbols on top, and zoom in: at full zoom, detected pools and imagery chips appear. Each layer's source is linked in the legend and below.</p></div></div>
  <h2>${st ? "Regions in this study" : "All regions in the database"}</h2>
  <div class="card scroll"><table><thead><tr><th class="l">Region</th><th class="l">TA</th><th class="l">PRVDR</th><th>Suburbs</th><th>With housing</th><th>Sections</th><th>SA2s</th><th class="l">Imagery</th><th>Pools</th><th class="l">Gardens</th><th class="l">Census</th><th class="l">Climate</th><th class="l">Status</th></tr></thead>
    <tbody>${rows.map((r) => `<tr data-reg="${esc(r.k)}" style="cursor:pointer${r.k === region ? ";background:var(--accent-soft)" : ""}"><td class="l"><b>${esc(r.name)}</b></td><td class="l">${esc(r.ta)}</td><td class="l">${esc(r.prvdr)}</td><td>${cell(r.suburbs)}</td><td>${cell(r.housing)}</td><td>${cell(r.sections)}</td><td>${cell(r.sa2)}</td>
      <td class="l small">${esc(r.imagery)}</td><td>${cell(r.pools)}</td><td class="l">${r.garden ? "yes" : "–"}</td><td class="l">${esc(r.census)}</td><td class="l small">${esc(r.climate)}</td><td class="l"><span class="tag ${r.status === "published" ? "ok" : r.status === "draft" ? "warn" : "info"}">${esc(r.status)}</span></td></tr>`).join("")}
    ${rows.length > 1 ? `<tr><td class="l"><b>Total</b></td><td></td><td></td><td><b>${fmt(tot("suburbs"))}</b></td><td><b>${fmt(tot("housing"))}</b></td><td><b>${fmt(tot("sections"))}</b></td><td><b>${fmt(tot("sa2"))}</b></td><td></td><td><b>${fmt(tot("pools"))}</b></td><td colspan="4"></td></tr>` : ""}</tbody></table></div>${sourcesHTML()}`;
};

// ---------------------------------------------------------------- validation: real labelling (labellers)
const KEYMAP = { pool: { ArrowLeft: "not_pool", ArrowUp: "water", ArrowDown: "unknown", ArrowRight: "pool" }, garden: { ArrowLeft: "over", ArrowUp: "about_right", ArrowDown: "unknown", ArrowRight: "under" } };
const KEYTXT = { not_pool: "Not pool", water: "Water, not pool", unknown: "Unknown", pool: "Pool", over: "Too much garden", about_right: "About right", under: "Too little garden" };
async function startLabelling() {
  const cap = R().capture_id;
  const items = await q(sb.from("validation_items").select("id,task,grp,chip_path,tool_verdict").eq("capture_id", cap).order("id"));
  const mine = await q(sb.from("validation_labels").select("item_id").eq("user_id", SESSION.user.id));
  const done = new Set(mine.map((m) => m.item_id));
  LIVE.labelQueue = items.filter((i) => !done.has(i.id)); LIVE.labelPos = 0; LIVE.labelling = true; LIVE.total = items.length;
  await showLabel();
}
async function chipUrl(path) {
  if (!LIVE.chipUrls[path]) { const { data, error } = await sb.storage.from("chips").createSignedUrl(path, 3600); if (error) throw error; LIVE.chipUrls[path] = data.signedUrl; }
  return LIVE.chipUrls[path];
}
async function showLabel() {
  const el = $("#label-panel"); if (!el) return;
  const it = LIVE.labelQueue[LIVE.labelPos];
  if (!it) { el.innerHTML = `<p>Nothing left to label in this capture. Thank you!</p>`; LIVE.labelling = false; return; }
  const img = await chipUrl(it.chip_path), img2 = it.task === "garden" ? await chipUrl(it.chip_path.replace(/\.jpg$/, "_veg.jpg")).catch(() => null) : null;
  const keys = KEYMAP[it.task];
  el.innerHTML = `<p class="small muted">${LIVE.total - LIVE.labelQueue.length + LIVE.labelPos} of ${LIVE.total} labelled by you · ${esc(it.task)} item #${it.id}${it.task === "pool" ? " · candidate in the red circle" : " · section in yellow; green = measured vegetation"}</p>
    <div class="grid ${img2 ? "g2" : ""}" style="max-width:${img2 ? 720 : 380}px"><div style="position:relative"><img src="${img}" alt="Validation chip" style="width:100%;border-radius:8px;display:block">${it.task === "pool" ? '<span style="position:absolute;left:50%;top:50%;width:34px;height:34px;margin:-17px 0 0 -17px;border:2px solid #ff3b30;border-radius:50%"></span>' : ""}</div>
    ${img2 ? `<img src="${img2}" alt="Vegetation overlay" style="width:100%;border-radius:8px;display:block">` : ""}</div>
    <div class="keys" style="margin-top:10px">${Object.entries(keys).map(([k, v]) => `<button class="key ${{ ArrowUp: "k-up", ArrowLeft: "k-left", ArrowDown: "k-down", ArrowRight: "k-right" }[k]}" data-label="${v}" type="button"><kbd>${{ ArrowUp: "↑", ArrowLeft: "←", ArrowDown: "↓", ArrowRight: "→" }[k]}</kbd><span class="small">${KEYTXT[v]}</span></button>`).join("")}</div>
    <p class="small muted">Arrow keys label and advance; Backspace goes back. Labels are saved to your account.</p>`;
}
async function saveLabel(label) {
  const it = LIVE.labelQueue[LIVE.labelPos]; if (!it) return;
  try { await q(sb.from("validation_labels").upsert({ item_id: it.id, user_id: SESSION.user.id, label }, { onConflict: "item_id,user_id" })); }
  catch (err) { return toastMsg("Not saved: " + err.message); }
  LIVE.labelPos++; showLabel();
}
document.addEventListener("keydown", (e) => {
  if (!LIVE.labelling || stage !== "validate" || e.target.matches("input,select,textarea")) return;
  const it = LIVE.labelQueue[LIVE.labelPos]; if (!it) return;
  const v = KEYMAP[it.task][e.key];
  if (v) { e.preventDefault(); saveLabel(v); } else if (e.key === "Backspace" && LIVE.labelPos > 0) { e.preventDefault(); LIVE.labelPos--; showLabel(); }
});
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-label]"); if (b && LIVE.labelling) return saveLabel(b.dataset.label);
  if (e.target.id === "start-label") startLabelling().catch((err) => toastMsg(err.message));
});
const _vValidate = V.validate;
V.validate = () => _vValidate().replace(/<div class="card"><h3>Labelling keys<\/h3>[\s\S]*?<\/div>\s*<div class="card"><h3>Quality gate/, () =>
  `<div class="card"><h3>Label this capture</h3>${can("labeller") ? `<div id="label-panel"><p class="small muted">Image chips are private: they're served to signed-in labellers through short-lived signed links.</p><button class="btn primary" id="start-label" type="button">Start labelling</button></div>` : lock("labeller", "Labelling")}</div>
  <div class="card"><h3>Quality gate`);

// ---------------------------------------------------------------- admin: approve users, set roles
V.admin = () => {
  if (!can("admin")) return lock("admin", "User administration");
  setTimeout(loadUsers, 0);
  return `<h1>Admin</h1><p class="lead">New Google sign-ins arrive as <b>viewer</b> / <b>pending</b>. Approve them by setting status to <b>active</b>, and choose a role. Changes are recorded in the audit log.</p><div class="card scroll" id="users"><p class="muted">Loading users…</p></div>`;
};
async function loadUsers() {
  const el = $("#users"); if (!el) return;
  const us = await q(sb.from("profiles").select("id,email,display_name,role,status,created_at").order("created_at"));
  el.innerHTML = `<table><thead><tr><th>User</th><th class="l">Role</th><th class="l">Status</th><th>Joined</th><th></th></tr></thead><tbody>${us.map((u) => `<tr>
    <td class="l">${esc(u.display_name || "")}<br><span class="small muted">${esc(u.email)}</span></td>
    <td class="l"><select data-urole="${u.id}">${["viewer", "labeller", "editor", "admin"].map((r) => `<option ${r === u.role ? "selected" : ""}>${r}</option>`).join("")}</select></td>
    <td class="l"><select data-ustatus="${u.id}">${["pending", "active", "disabled"].map((s) => `<option ${s === u.status ? "selected" : ""}>${s}</option>`).join("")}</select></td>
    <td>${esc(new Date(u.created_at).toLocaleDateString())}</td><td><button class="btn" data-usave="${u.id}" type="button">Save</button></td></tr>`).join("")}</tbody></table>`;
}
document.addEventListener("click", async (e) => {
  const id = e.target.dataset && e.target.dataset.usave; if (!id || !can("admin")) return;
  const role = $(`[data-urole="${id}"]`).value, status = $(`[data-ustatus="${id}"]`).value;
  if (id === SESSION.user.id && (role !== "admin" || status !== "active") && !confirm("This removes your own admin access. Continue?")) return;
  try { await q(sb.from("profiles").update({ role, status }).eq("id", id)); toastMsg("Saved"); loadUsers(); } catch (err) { toastMsg("Not saved: " + err.message); }
});

document.addEventListener("click", (e) => { const b = e.target.closest && e.target.closest("[data-goto]"); if (!b) return;
  stage = b.dataset.goto; store.set("stage", stage); render(); scrollTo(0, 0); });

// ---------------------------------------------------------------- header + boot
const _renderHeader = renderHeader;
renderHeader = function () {
  _renderHeader();
  $("#who").innerHTML = `${esc(PROFILE.email)} · <span class="tag info">${esc(PROFILE.role)}</span>
    <button class="btn" type="button" data-goto="account" ${stage === "account" ? 'aria-current="page"' : ""}>Account</button>
    ${can("admin") ? `<button class="btn" type="button" data-goto="admin" ${stage === "admin" ? 'aria-current="page"' : ""}>Admin</button>` : ""}`;
  $("#signin").textContent = "Sign out";
};
// loading view: shown from the first moment, so a refresh never shows an empty page
function loadingView(step, detail) {
  const m = $("#main"); if (!m) return;
  if (!$("#boot-load")) m.innerHTML = `<section id="boot-load" role="status" aria-live="polite" style="max-width:520px;margin:64px auto;text-align:center">
    <style>@keyframes nzsw-spin{to{transform:rotate(360deg)}}</style>
    <div style="width:38px;height:38px;margin:0 auto 14px;border-radius:50%;border:4px solid var(--line);border-top-color:var(--accent);animation:nzsw-spin .9s linear infinite" aria-hidden="true"></div>
    <h2 style="margin:0 0 4px">NZ Suburb Water Profiles</h2><p id="boot-step" class="lead" style="margin:0"></p><p id="boot-detail" class="small muted" style="margin:6px 0 0;min-height:1.3em"></p></section>`;
  $("#boot-step").textContent = step; $("#boot-detail").textContent = detail || "";
}
(async function boot() {
  loadingView("Starting…");
  try {
    STATIC = await fetch("data/demo.json").then((r) => r.json());
    loadingView("Checking your sign-in…");
    const { data: { session } } = await sb.auth.getSession(); SESSION = session;
    if (!session) return gate("signin");          // only signed-out visitors see the landing page
    document.querySelector("nav.stages").hidden = false; $("#region").closest("label").hidden = false;
    loadingView("Signing in…", session.user.email);
    PROFILE = await q(sb.from("profiles").select("email,role,status").eq("id", session.user.id).maybeSingle());
    if (!PROFILE || PROFILE.status !== "active") return gate("pending");
    user = { email: PROFILE.email, role: PROFILE.role };
    loadingView("Loading the region index…");
    D = await loadAll();
    if (!D.index.some((r) => r.id === region)) region = (D.index[0] || {}).id;
    $("#foot").innerHTML = `NZ Suburb Water Profiles · data from LINZ, Stats NZ and Open-Meteo (CC BY 4.0), see <a href="${REPO}/blob/main/ATTRIBUTION.md">ATTRIBUTION.md</a> · <a href="${REPO}/blob/main/docs/SPEC.md">specification</a> · Water consumption isn't handled here.`;
    render();
  } catch (err) { gate("error", err.message); }
})();
