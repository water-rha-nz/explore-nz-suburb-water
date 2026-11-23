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
    capture_id: cap.id, ta_code: r.ta_code, provider: (mets[0] || {}).prvdr || st.provider, lonlat: st.lonlat || null, status: r.status, suburbs,
    sa2: sa2o.map((a) => ({ code: a.id, name: a.name, geom: multi(a.geom), census: censusOf(cm.filter((c) => c.sa2_code === a.id)) })),
    climate_cells, validation: (vs[0] || {}).stats || st.validation, validation_tiles: st.validation_tiles || {}, validation_items: st.validation_items || [],
    source_plan: st.source_plan, area_check: st.area_check };
}
async function loadAll() {
  const regions = await q(sb.from("regions").select("*").order("id"));
  const rates = await q(sb.from("water_rates").select("prvdr,charging_type,fixed_pa,volumetric_pa,threshold_lpd,date_est,note,source_url,providers(name)"));
  const d = { generated: today(), regions: {}, nz_regions: STATIC.nz_regions, limits: STATIC.limits, index_regions: STATIC.index_regions,
    water_rates: rates.map((r) => ({ PROVIDER: r.prvdr, name: (r.providers || {}).name || r.prvdr, CHARGING_TYPE: r.charging_type, FIXED_PA: r.fixed_pa, VOLUMETRIC_PA: r.volumetric_pa,
      THRESHOLD_Lpd: r.threshold_lpd, DATE_EST: r.date_est, NOTE: r.note, source: r.source_url, year: "2026/27" })) };
  const cen = await q(sb.rpc("region_centroids"));
  for (const r of regions) { const g = await loadRegion(r); if (g.suburbs.length) { g.lonlat = cen[r.id] || g.lonlat; d.regions[r.id] = g; } }   // drafts without data yet are listed on the Batch stage
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
  const next = { ...LIVE.rates, [k]: { ...(LIVE.rates[k] || {}), per_min: v, changed_at: new Date().toISOString(), reason: "user: " + user.email } };
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
V.region = () => {
  const h = _vRegion().replace(/<h3 style="margin-top:14px">Pipeline jobs<\/h3>[\s\S]*?<div id="jobs"/, `<h3 style="margin-top:14px">Pipeline jobs</h3>
    ${can("editor") ? `<div class="row small">${[["climate", "Climate top-up"], ["census", "Census"], ["publish", "Recompute metrics"]].map(([v, l]) => `<label><input type="checkbox" data-step value="${v}" checked> ${l}</label>`).join("")}</div>
    <div class="row" style="margin-top:6px"><button class="btn primary" id="queue-live" type="button">Queue job</button><button class="btn" type="button" onclick="refreshJobs()">Refresh</button></div>
    <p class="small muted">One region per job, run by the worker (GitHub Actions) within each service's free-tier budget. Data already stored, by anyone, is reused, not downloaded again. To prepare new regions, use the Batch stage.</p>` : lock("editor", "Queuing jobs")}
    <div id="jobs"`);
  setTimeout(refreshJobs, 0);
  return h;
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
(async function boot() {
  try {
    STATIC = await fetch("data/demo.json").then((r) => r.json());
    const { data: { session } } = await sb.auth.getSession(); SESSION = session;
    if (!session) return gate("signin");          // only signed-out visitors see the landing page
    document.querySelector("nav.stages").hidden = false; $("#region").closest("label").hidden = false;
    PROFILE = await q(sb.from("profiles").select("email,role,status").eq("id", session.user.id).maybeSingle());
    if (!PROFILE || PROFILE.status !== "active") return gate("pending");
    user = { email: PROFILE.email, role: PROFILE.role };
    $("#main").innerHTML = `<p class="muted">Loading regions…</p>`;
    D = await loadAll();
    if (!D.regions[region]) region = Object.keys(D.regions)[0];
    $("#foot").innerHTML = `NZ Suburb Water Profiles · data from LINZ, Stats NZ and Open-Meteo (CC BY 4.0), see <a href="${REPO}/blob/main/ATTRIBUTION.md">ATTRIBUTION.md</a> · <a href="${REPO}/blob/main/docs/SPEC.md">specification</a> · Water consumption isn't handled here.`;
    render();
  } catch (err) { gate("error", err.message); }
})();
