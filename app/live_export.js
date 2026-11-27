
// ---------------------------------------------------------------- export builder: configure, then stream from Supabase
// Choose the regions (any prepared region in the database, loaded or not), the statistics and the formats; the data is fetched
// from Supabase when you export (regions not in the session are fetched for the export only and released afterwards), and the
// files come as one .zip of CSVs (with a manifest) or one .xlsx. Two formats are new here: water charges by period (each
// component with its start and end date) and climate time series (daily, monthly or annual; per climate cell or per suburb).
const XB = { regions: null, metrics: null, formats: null, running: false };
const XB_FORMATS = () => [
  ...Object.keys(EXPORTS).filter((f) => /\.(csv|tsv|txt)$/i.test(f) && !f.startsWith("validation_")).map((f) => [f, EXPORTS[f].desc]),
  ["water_charges_by_period.csv", "REGION, TA_CODE, TERRITORY, PROVIDER, NAME, COMPONENT, VALUE, UNIT, START, END, CHARGING_TYPE, VERIFIED, WEBSITE_URL, POLICY_URL: each region's charges (its territory's, else the provider's), per component and period (END is the day before the next period; blank = current)"],
  ["climate_timeseries.csv", "Climate per climate cell or per suburb over the chosen dates: rain, ET₀, mean and max temperature (daily, monthly or annual)"],
];
const xbStore = (k, d) => { try { return JSON.parse(store.get("xb-" + k, "null")) ?? d; } catch (e) { return d; } };
const xbSave = (k, v) => store.set("xb-" + k, JSON.stringify(v));
// a region's period: its own timeline (set per region on 3 · Load), else the study's timeline for its TA (Configure), else all
// stored data; a date typed in the export builder overrides it for every region
function xbPeriod(k, kind) {
  const r = indexOf(k), own = r.timeline || {}, has = (t) => t && (t.climate_start || t.climate_end || (t.census_years || []).length);
  const t = has(own) ? own : (BATCH.tl || {})[r.ta_code] || {}, o = xbStore(kind, {});
  return { from: o.from || t.climate_start || "", to: o.to || t.climate_end || "", census: t.census_years || [],
           src: o.from || o.to ? "override" : has(own) ? "region timeline" : has((BATCH.tl || {})[r.ta_code]) ? "study timeline" : "all stored" };
}
// union of several regions' periods (blank = open)
const xbUnion = (ps) => ({ from: ps.some((p) => !p.from) ? "" : ps.map((p) => p.from).sort()[0], to: ps.some((p) => !p.to) ? "" : ps.map((p) => p.to).sort().slice(-1)[0] });
const xbIn = (d, p) => (!p.from || d >= p.from) && (!p.to || d <= p.to);
function xbDefaults() {
  const st = studyScope();
  if (!XB.regions) XB.regions = new Set(xbStore("regions", null) || st.ids);
  if (!XB.metrics) XB.metrics = new Set(xbStore("metrics", null) || METRICS.map((m) => m.id));
  if (!XB.formats) XB.formats = new Set(xbStore("formats", null) || ["nz_suburb_demographics.csv", "water_charges_by_period.csv", "climate_timeseries.csv"]);
}
function exportBuilderHTML() {
  xbDefaults();
  const idx = (D.index || []), groups = {};
  for (const m of METRICS) (groups[m.src || "Other"] = groups[m.src || "Other"] || []).push(m);
  const cb = (attr, v, on, label, title = "") => `<label class="small" style="display:inline-flex;gap:4px;align-items:center;margin:2px 10px 2px 0" title="${esc(title)}"><input type="checkbox" ${attr}="${esc(v)}" ${on ? "checked" : ""}> ${label}</label>`;
  const cl = xbStore("climate", { from: "", to: "", agg: "monthly", per: "cell" }), rt = xbStore("rates", { from: "", to: "", shape: "long" });
  return `<div class="card" style="margin-bottom:12px"><h3>Export builder</h3>
    <p class="small">Choose regions, statistics and formats. The data is fetched from the database when you export, so regions don't need to be loaded first.</p>
    <h4 style="margin:8px 0 2px">Regions <span class="small muted">(${XB.regions.size} chosen)</span> <button class="btn" type="button" data-xb-regions="study" style="padding:0 6px">Study</button> <button class="btn" type="button" data-xb-regions="all" style="padding:0 6px">All</button> <button class="btn" type="button" data-xb-regions="none" style="padding:0 6px">None</button></h4>
    <div style="max-height:110px;overflow:auto">${idx.map((r) => cb("data-xb-region", r.id, XB.regions.has(r.id), `${esc(r.name || r.id)}${r.status === "published" ? "" : ` <span class="muted">(${esc(r.status || "not ready")})</span>`}`)).join("") || '<span class="small muted">No regions in the database yet.</span>'}</div>
    <h4 style="margin:8px 0 2px">Statistics <span class="small muted">(${XB.metrics.size} of ${METRICS.length}: columns of nz_suburb_demographics.csv and the data dictionary)</span> <button class="btn" type="button" data-xb-metrics="all" style="padding:0 6px">All</button> <button class="btn" type="button" data-xb-metrics="none" style="padding:0 6px">None</button></h4>
    <div style="max-height:150px;overflow:auto">${Object.entries(groups).map(([g, ms]) => `<div><b class="small">${esc(g)}</b> ${ms.map((m) => cb("data-xb-metric", m.id, XB.metrics.has(m.id), esc(m.label), m.id)).join("")}</div>`).join("")}</div>
    <h4 style="margin:8px 0 2px">Formats</h4>
    <div>${XB_FORMATS().map(([f, d]) => cb("data-xb-format", f, XB.formats.has(f), `<code>${esc(f)}</code>`, d)).join("")}</div>
    <div class="grid g2" style="margin-top:6px">
      <div class="small" style="grid-column:1/-1"><b>Periods</b> come from each region's timeline (3 · Load), else the study's timeline for its TA (2 · Configure), else all stored data:
        ${[...XB.regions].filter((k) => indexOf(k).id).map((k) => { const p = xbPeriod(k, "climate"); return `${esc(indexOf(k).name || k)} <span class="muted">${p.from || "start"} to ${p.to || "latest"} (${p.src}${p.census.length ? "; census " + p.census.join(", ") : ""})</span>`; }).join(" · ") || '<span class="muted">choose regions</span>'}</div>
      <div class="small"><b>Water charges by period</b><br>Periods overlapping each region's timeline; override: <input type="date" id="xb-r-from" value="${esc(rt.from)}"> to <input type="date" id="xb-r-to" value="${esc(rt.to)}"><br>
        <label><input type="radio" name="xb-r-shape" value="long" ${rt.shape !== "wide" ? "checked" : ""}> one row per component</label> <label><input type="radio" name="xb-r-shape" value="wide" ${rt.shape === "wide" ? "checked" : ""}> one row per period</label><br><span class="muted">Providers of the chosen regions.</span></div>
      <div class="small"><b>Climate time series</b><br>Each region's timeline; override: <input type="date" id="xb-c-from" value="${esc(cl.from)}"> to <input type="date" id="xb-c-to" value="${esc(cl.to)}"><br>
        <select id="xb-c-agg"><option value="daily" ${cl.agg === "daily" ? "selected" : ""}>Daily</option><option value="monthly" ${cl.agg === "monthly" ? "selected" : ""}>Monthly</option><option value="annual" ${cl.agg === "annual" ? "selected" : ""}>Annual</option></select>
        <select id="xb-c-per"><option value="cell" ${cl.per !== "suburb" ? "selected" : ""}>per climate cell</option><option value="suburb" ${cl.per === "suburb" ? "selected" : ""}>per suburb</option></select><br><span class="muted">Sums for rain and ET₀, means for temperatures. Partial months or years are flagged with their day count.</span></div>
    </div>
    <p class="small" style="margin:6px 0 0"><label><input type="checkbox" id="xb-hh-std" ${store.get("hh-standard", "0") === "1" ? "checked" : ""}> <code>nz_household_ref.csv</code>: standard six columns only (leave off the per-household spatial and imagery columns)</label></p>
    <p class="small" style="margin:2px 0 0"><label><input type="checkbox" id="xb-rates-legacy" ${store.get("rates-legacy", "0") === "1" ? "checked" : ""}> Water rates: original tool headers (<code>FIXED_PA</code>, <code>VOLUMETRIC_PA</code>, <code>THRESHOLD_Lpd</code>) instead of headers with units (<code>FIXED_NZD_PA</code>, <code>VOLUMETRIC_NZD_PER_M3</code>, <code>THRESHOLD_L_PER_DAY</code>)</label></p>
    <div class="row" style="margin-top:10px"><button class="btn primary" type="button" id="xb-zip" ${user ? "" : "disabled"}>Export .zip of CSVs</button> <button class="btn" type="button" id="xb-xlsx" ${user ? "" : "disabled"}>Export .xlsx</button> <span class="small muted" id="xb-status"></span></div></div>`;
}
const _vExportXB = V.export;
V.export = (...a) => { const html = _vExportXB(...a); return D && D.index ? html.replace(/(<p class="lead">[\s\S]*?<\/p>)/, `$1${exportBuilderHTML()}`) : html; };

document.addEventListener("change", (e) => {
  const t = e.target; if (!t || !t.dataset) return;
  const tog = (set, key, v) => { t.checked ? set.add(v) : set.delete(v); xbSave(key, [...set]); };
  if (t.dataset.xbRegion) tog(XB.regions, "regions", t.dataset.xbRegion);
  else if (t.dataset.xbMetric) tog(XB.metrics, "metrics", t.dataset.xbMetric);
  else if (t.dataset.xbFormat) tog(XB.formats, "formats", t.dataset.xbFormat);
  else if (t.id === "xb-hh-std") store.set("hh-standard", t.checked ? "1" : "0");
  else if (t.id === "xb-rates-legacy") store.set("rates-legacy", t.checked ? "1" : "0");
  else if (/^xb-c-/.test(t.id)) xbSave("climate", { from: $("#xb-c-from").value, to: $("#xb-c-to").value, agg: $("#xb-c-agg").value, per: $("#xb-c-per").value });
  else if (/^xb-r-/.test(t.id) || t.name === "xb-r-shape") xbSave("rates", { from: $("#xb-r-from").value, to: $("#xb-r-to").value, shape: (document.querySelector('input[name="xb-r-shape"]:checked') || {}).value || "long" });
});
document.addEventListener("click", async (e) => {
  const t = e.target; if (!t || !t.closest) return;
  const rb = t.closest("[data-xb-regions]"), mb = t.closest("[data-xb-metrics]");
  if (rb) { xbDefaults(); const w = rb.dataset.xbRegions; XB.regions = new Set(w === "all" ? (D.index || []).map((r) => r.id) : w === "study" ? studyScope().ids : []); xbSave("regions", [...XB.regions]); render(); return; }
  if (mb) { xbDefaults(); XB.metrics = new Set(mb.dataset.xbMetrics === "all" ? METRICS.map((m) => m.id) : []); xbSave("metrics", [...XB.metrics]); render(); return; }
  if (t.id === "xb-zip" || t.id === "xb-xlsx") {
    if (XB.running) return; XB.running = true; t.disabled = true;
    const say = (m) => { const s = $("#xb-status"); if (s) s.textContent = m; };
    try { const files = await xbBuild(say); if (!files.length) throw new Error("choose at least one region and one format");
      const stamp = new Date().toISOString().slice(0, 10), base = `nz_suburb_export_${String(studyScope().name).replace(/[^\w-]+/g, "_").slice(0, 40)}_${stamp}`;
      let blob, fn;
      if (t.id === "xb-zip") { blob = await zipFiles(files.map((f) => [f.name, f.text])); blob = new Blob([blob], { type: "application/zip" }); fn = base + ".zip"; }
      else { ({ blob } = await buildXlsx(files.map((f) => ({ name: f.name.replace(/\.(csv|tsv|txt)$/i, "").replace(/^nz_/, ""), rows: f.rows || parseDelimited(f.text), kind: f.name === "MANIFEST.txt" ? "text" : "table" })))); fn = base + ".xlsx"; }
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = fn; document.body.appendChild(a); a.click(); a.remove();
      say(`Saved ${fn}: ${files.length} files, ${(blob.size / 1e6).toFixed(1)} MB.`); }
    catch (err) { say("Export failed: " + (err.message || err)); }
    XB.running = false; t.disabled = false;
  }
});

// fetch the chosen regions (those not in the session only for this export), then build each chosen format
async function xbBuild(say) {
  xbDefaults();
  const ids = [...XB.regions].filter((k) => (D.index || []).some((r) => r.id === k)); if (!ids.length) return [];
  const tmp = {}, keepRegs = D.regions, keepScope = store.get("scope", "region"), keepMetrics = METRICS.slice(), keepSect = SECT;
  for (const [i, k] of ids.entries()) {
    if (D.regions[k]) { tmp[k] = D.regions[k]; continue; }
    const r = (D.index || []).find((x) => x.id === k);
    say(`Fetching ${r.name || k} (${i + 1} of ${ids.length})…`);
    const g = await loadRegion(r, (what) => say(`Fetching ${r.name || k} (${i + 1} of ${ids.length}): ${what}…`));
    if (g && g.suburbs && g.suburbs.length) { g.lonlat = (D.cen || {})[k] || g.lonlat; tmp[k] = g; }
  }
  const files = [], picked = XB.formats;
  try {
    D.regions = tmp; store.set("scope", "all"); SECT = null;   // households load per region (cached in HHR) for the chosen regions
    METRICS.splice(0, METRICS.length, ...keepMetrics.filter((m) => XB.metrics.has(m.id)));
    for (const f of [...picked]) {
      if (!EXPORTS[f]) continue; say(`Building ${f}…`);
      try { files.push({ name: f, text: await EXPORTS[f].make() }); } catch (err) { files.push({ name: f.replace(/\.\w+$/, "") + "_ERROR.txt", text: String(err.message || err) }); }
    }
  } finally { METRICS.splice(0, METRICS.length, ...keepMetrics); D.regions = keepRegs; store.set("scope", keepScope); SECT = keepSect; }
  if (picked.has("water_charges_by_period.csv")) { say("Water charges by period…"); files.push({ name: "water_charges_by_period.csv", text: await xbRates(Object.entries(tmp)) }); }
  if (picked.has("climate_timeseries.csv")) files.push({ name: "climate_timeseries.csv", text: await xbClimate(tmp, say) });
  const regs = ids.filter((k) => tmp[k]).map((k) => tmp[k].label);
  files.push({ name: "MANIFEST.txt", text: [`NZ Suburb Water Profiles export (${new Date().toLocaleString("en-NZ")})`, `Study: ${studyScope().name}`, `Regions (${regs.length}): ${regs.join(", ")}`,
    ...ids.filter((k) => tmp[k]).map((k) => { const p = xbPeriod(k, "climate"); return `  ${tmp[k].label}: climate ${p.from || "start"} to ${p.to || "latest"} (${p.src})${p.census.length ? "; census " + p.census.join(", ") : ""}`; }),
    `Statistics (${XB.metrics.size}): ${[...XB.metrics].join(", ")}`, `Files: ${files.map((f) => f.name).join(", ")}`, "Fetched from the database at export time.",
    "Sources: LINZ (CC BY 4.0), Stats NZ (CC BY 4.0), Open-Meteo (CC BY 4.0), water providers' published charges."].join("\n") });
  return files;
}

// charges per region are its territory's (any provider; see regionCharges); periods
// overlapping the region's period (its timeline) are kept
async function xbRates(regs) {
  const list = regs.map(([k, g]) => { const ix = (D.index || []).find((r) => r.id === k) || {}; const ta = (BATCH.tas || []).find((x) => x.code === ix.ta_code) || {};
    return { id: k, name: g.label, ta_code: ix.ta_code, ta_name: ta.name || ix.ta_code || "", prvdr: g.provider || ix.prvdr || "" }; });
  const tas = [...new Set(list.map((r) => r.ta_code).filter(Boolean))];
  if (!tas.length) return csv([["REGION", "NOTE"], ["", "no territory set for the chosen regions"]]);
  const all = await q(sb.from("water_rates").select("prvdr,ta_code,valid_from,charging_type,fixed_pa,volumetric_pa,threshold_lpd,value_rate,value_basis,date_est,note,source_url,website_url,policy_url,verified,providers(name)").in("ta_code", tas).order("ta_code").order("valid_from"));
  const R = xbStore("rates", { from: "", to: "", shape: "long" }), out = [];
  for (const reg of list) { const w = xbPeriod(reg.id, "rates");
    for (const r of regionCharges(reg, all).filter((r) => (!w.to || r.valid_from <= w.to) && (!w.from || !r.end || r.end >= w.from))) out.push({ reg, r }); }
  const name = (r) => (r.providers || {}).name || r.prvdr;
  if (R.shape === "wide") return unitHeaders(csv([["REGION", "TA_CODE", "TERRITORY", "PROVIDER", "NAME", "STUDY_LINKED_PROVIDER", "START", "END", "CHARGING_TYPE", "FIXED_PA", "VOLUMETRIC_PA", "THRESHOLD_Lpd", "VALUE_RATE_PER_DOLLAR", "VALUE_BASIS", "DATE_EST", "VERIFIED", "WEBSITE_URL", "POLICY_URL", "NOTE"],
    ...out.map(({ reg, r }) => [reg.name, reg.ta_code || "", reg.ta_name, r.prvdr, name(r), r.differs ? r.linked : "", r.valid_from, r.end, r.charging_type || "", r.fixed_pa ?? "", r.volumetric_pa ?? "", r.threshold_lpd ?? "", r.value_rate ?? "", r.value_basis || "", r.date_est || "", r.verified ? "yes" : "no", r.website_url || "", r.policy_url || r.source_url || "", r.note || ""])]));
  const comps = [["FIXED", "fixed_pa", () => "NZD/yr"], ["VOLUMETRIC", "volumetric_pa", () => "NZD/m³"], ["THRESHOLD", "threshold_lpd", () => "L/day"], ["VALUE_BASED", "value_rate", (r) => `NZD per NZD of ${r.value_basis || "property value"}`]];
  return csv([["REGION", "TA_CODE", "TERRITORY", "PROVIDER", "NAME", "STUDY_LINKED_PROVIDER", "COMPONENT", "VALUE", "UNIT", "START", "END", "CHARGING_TYPE", "VERIFIED", "WEBSITE_URL", "POLICY_URL"],
    ...out.flatMap(({ reg, r }) => comps.filter(([, k]) => r[k] != null).map(([c, k, u]) => [reg.name, reg.ta_code || "", reg.ta_name, r.prvdr, name(r), r.differs ? r.linked : "", c, r[k], u(r), r.valid_from, r.end, r.charging_type || "", r.verified ? "yes" : "no", r.website_url || "", r.policy_url || r.source_url || ""]))]);
}

// climate: stored days per cell (keyset paged) over its regions' periods; per suburb, each region's own period
async function xbClimate(regs, say) {
  const C = xbStore("climate", { from: "", to: "", agg: "monthly", per: "cell" }), subsOf = {};
  for (const [k, g] of Object.entries(regs)) for (const s of g.suburbs) { const cc = s.grid || s.climate_cell; if (cc) (subsOf[cc] = subsOf[cc] || []).push([mName(s), s.ta || g.label, k]); }
  const cells = Object.keys(subsOf); if (!cells.length) return csv([["NOTE"], ["no climate cells for the chosen regions"]]);
  const out = [], key = (d) => C.agg === "daily" ? d.date : C.agg === "monthly" ? d.date.slice(0, 7) : d.date.slice(0, 4);
  const full = (k) => C.agg === "daily" ? 1 : C.agg === "monthly" ? new Date(Date.UTC(+k.slice(0, 4), +k.slice(5, 7), 0)).getUTCDate() : (+k % 4 === 0 && (+k % 100 !== 0 || +k % 400 === 0) ? 366 : 365);
  const series = (days, p) => { const agg = new Map();
    for (const d of days) { if (!xbIn(d.date, p)) continue; const k = key(d), a = agg.get(k) || { n: 0, rain: 0, et0: 0, tm: 0, tmn: 0, tx: 0, txn: 0 }; a.n++;
      a.rain += +d.rain_mm || 0; a.et0 += +d.et0_mm || 0; if (d.tmean_c != null) { a.tm += +d.tmean_c; a.tmn++; } if (d.tmax_c != null) { a.tx += +d.tmax_c; a.txn++; } agg.set(k, a); }
    return [...agg].map(([k, a]) => [k, a.n, a.n < full(k) ? "partial" : "", +a.rain.toFixed(1), +a.et0.toFixed(1), a.tmn ? +(a.tm / a.tmn).toFixed(2) : "", a.txn ? +(a.tx / a.txn).toFixed(2) : ""]); };
  for (const [i, c] of cells.entries()) {
    say(`Climate: cell ${i + 1} of ${cells.length}…`);
    const rk = [...new Set(subsOf[c].map((x) => x[2]))], w = xbUnion(rk.map((k) => xbPeriod(k, "climate")));
    const days = await pagedAll((last) => { let b = sb.from("climate_daily").select("date,rain_mm,et0_mm,tmean_c,tmax_c").eq("cell_id", c); if (last) b = b.gt("date", last); else if (w.from) b = b.gte("date", w.from); return b.order("date"); }, "date");
    if (C.per === "suburb") { for (const k of rk) { const rows = series(days, xbPeriod(k, "climate")); for (const [sn, ta, kk] of subsOf[c]) if (kk === k) for (const row of rows) out.push([sn, ta, c, ...row]); } }
    else for (const row of series(days, w)) out.push([c, subsOf[c].length, rk.map((k) => regs[k].label).join("; "), ...row]);
  }
  const head = ["PERIOD", "DAYS", "COMPLETE", "RAIN_MM", "ET0_MM", "TMEAN_C", "TMAX_C"];
  return csv([C.per === "suburb" ? ["M_SUBURB", "M_TERRITORY", "CLIMATE_CELL", ...head] : ["CLIMATE_CELL", "SUBURBS", "REGIONS", ...head], ...out]);
}

// ---------------------------------------------------------------- households: per-household rows and area per title holder
// nz_household_ref keeps its six standard columns first (suburb_lookup.html format) and adds each household's spatial measures and,
// for editors, its imagery measures. nz_suburb_hh_area_stats gives, per suburb, the centre and spread of area per title holder:
// LINZ land area, and the imagery-derived roof, unbuilt and garden areas.
const HHR = {};
loadSections = async function () {
  const ks = scopeRegions(), p = $("#preview");
  for (const [i, k] of ks.entries()) {
    if (HHR[k]) continue;
    const rows = [];
    for (let last = null; ;) {
      const page = await retry(() => q(sb.rpc("household_rows", { p_region: k, p_after: last, p_limit: 1000 })));
      for (const x of page) rows.push(x);
      const msg = `Loading households: ${(D.regions[k] || {}).label || k} (${i + 1} of ${ks.length}): ${rows.length.toLocaleString("en-NZ")}…`;
      if (p && !p.hidden) p.textContent = msg; const xs = $("#xb-status"); if (xs && XB.running) xs.textContent = msg;
      if (page.length < 1000) break; last = page[page.length - 1].parcel_id;
    }
    HHR[k] = rows;
  }
  const names = {}; for (const k of ks) for (const s of (D.regions[k] || { suburbs: [] }).suburbs) names[s.linz_id] = [k, s.name, s];
  SECT = { rows: ks.flatMap((k) => (HHR[k] || []).map((r) => { const n = Math.max(1, r.n_titles || 1), nm = names[r.suburb_id] || [k, ""];
    return [nm[0], nm[1], r.parcel_id, n > 1 ? "Shared" : "Freehold", +r.polygon_m2, n, Math.round(10 * r.polygon_m2 / n) / 10, r, nm[2]]; })) };
};
const HH_EXTRA = [["SUBURB_LINZ_ID", (r) => r.suburb_id], ["SA2_CODE", (r) => r.sa2_code], ["PARCEL_INTENT", (r) => r.parcel_intent],
  ["NZTM_X", (r) => r.x], ["NZTM_Y", (r) => r.y], ["LON", (r) => r.lon], ["LAT", (r) => r.lat], ["PERIMETER_M", (r) => r.perimeter_m], ["COMPACTNESS", (r) => r.compactness],
  ["ROOF_M2", (r) => r.roof_m2], ["UNBUILT_M2", (r) => r.unbuilt_m2], ["GARDEN_M2", (r) => r.garden_m2], ["POOLS", (r) => r.pools], ["POOL_M2", (r) => r.pool_m2], ["IMAGERY_CAPTURE", (r) => r.capture_id]];
EXPORTS["nz_household_ref.csv"] = { desc: "M_SUBURB, M_DWELLING_ID, SECTION_TYPE, SECTION_SIZE_M2, NUM_SECTIONS, SECTION_AVG_M2 (LINZ parcels), then per household: LINZ suburb and SA2, centre (NZTM and lon/lat), perimeter, compactness, and for editors roof, unbuilt and garden m², pools and pool m² from imagery",
  lazy: true, make: async () => { await loadSections(); const ks = scopeRegions(), std = store.get("hh-standard", "0") === "1", nm = {};
    for (const k of ks) for (const s of (D.regions[k] || { suburbs: [] }).suburbs) nm[k + ":" + s.name] = mName(s);
    return csv([["M_SUBURB", "M_DWELLING_ID", "SECTION_TYPE", "SECTION_SIZE_M2", "NUM_SECTIONS", "SECTION_AVG_M2", ...(std ? [] : HH_EXTRA.map((c) => c[0]))],
      ...SECT.rows.filter((r) => ks.includes(r[0])).map((r) => [nm[r[0] + ":" + r[1]] || r[1], r[2], r[3], r[4], r[5], r[6], ...(std ? [] : HH_EXTRA.map(([, f]) => { const v = f(r[7] || {}); return v == null ? "" : v; }))])]); } };
// centre and spread per suburb
function hhStats(vals) {
  const v = vals.filter((x) => x != null && isFinite(x)).sort((a, b) => a - b), n = v.length; if (!n) return null;
  const q = (p) => { const i = (n - 1) * p, lo = Math.floor(i); return v[lo] + (v[Math.min(n - 1, lo + 1)] - v[lo]) * (i - lo); };
  const mean = v.reduce((a, b) => a + b, 0) / n, sd = n > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  return { n, mean, median: q(0.5), sd, p10: q(0.1), p25: q(0.25), p75: q(0.75), p90: q(0.9), iqr: q(0.75) - q(0.25) };
}
const HH_MEASURES = [["LAND_M2_PER_TITLE", "LINZ parcels and titles", (r) => +r.polygon_m2 / Math.max(1, r.n_titles || 1)],
  ["ROOF_M2_PER_TITLE", "LINZ building outlines (roof)", (r) => r.roof_m2 == null ? null : +r.roof_m2 / Math.max(1, r.n_titles || 1)],
  ["UNBUILT_M2_PER_TITLE", "LINZ parcels minus roofs", (r) => r.unbuilt_m2 == null ? null : +r.unbuilt_m2 / Math.max(1, r.n_titles || 1)],
  ["GARDEN_M2_PER_TITLE", "Aerial imagery (vegetation, NDVI)", (r) => r.garden_m2 == null ? null : +r.garden_m2 / Math.max(1, r.n_titles || 1)],
  ["TITLES_PER_SECTION", "LINZ titles", (r) => Math.max(1, r.n_titles || 1)]];
EXPORTS["nz_suburb_hh_area_stats.csv"] = { desc: "Per suburb and measure: centre and spread of household area per title holder (N, MEAN, MEDIAN, SD, P10, P25, P75, P90, IQR): LINZ land area, and roof, unbuilt and garden area (imagery measures for editors)",
  lazy: true, make: async () => { await loadSections(); const ks = scopeRegions(), by = new Map();
    for (const r of SECT.rows) { if (!ks.includes(r[0]) || !r[8]) continue; const key = r[0] + ":" + r[8].linz_id; if (!by.has(key)) by.set(key, { s: r[8], rows: [] }); by.get(key).rows.push(r[7]); }
    const out = [];
    for (const { s, rows } of by.values()) for (const [m, src, f] of HH_MEASURES) { const st = hhStats(rows.map(f)); if (!st) continue;
      out.push([mName(s), s.ta || "", s.linz_id, m, src, st.n, +st.mean.toFixed(1), +st.median.toFixed(1), +st.sd.toFixed(1), +st.p10.toFixed(1), +st.p25.toFixed(1), +st.p75.toFixed(1), +st.p90.toFixed(1), +st.iqr.toFixed(1)]); }
    return csv([["M_SUBURB", "M_TERRITORY", "SUBURB_LINZ_ID", "MEASURE", "SOURCE", "N", "MEAN", "MEDIAN", "SD", "P10", "P25", "P75", "P90", "IQR"], ...out]); } };

// ---------------------------------------------------------------- water rates: headers that state their units
// FIXED_PA is NZD per year, VOLUMETRIC_PA is NZD per m³ (not per year) and THRESHOLD_Lpd litres per day (suburb_lookup.html's own
// definitions). Exports name the units; the export builder's "original tool headers" option keeps the old names for that tool.
const RATE_HEADERS = { FIXED_PA: "FIXED_NZD_PA", VOLUMETRIC_PA: "VOLUMETRIC_NZD_PER_M3", THRESHOLD_Lpd: "THRESHOLD_L_PER_DAY" };
const unitHeaders = (text) => { if (store.get("rates-legacy", "0") === "1") return text; const i = text.indexOf("\n"), head = i < 0 ? text : text.slice(0, i);
  return head.split(",").map((h) => RATE_HEADERS[h] || h).join(",") + (i < 0 ? "" : text.slice(i)); };
{ const e = EXPORTS["nz_water_rates.csv"], mk = e.make;
  e.make = async (...a) => unitHeaders(await mk(...a));
  e.desc = "PROVIDER, CHARGING_TYPE, FIXED_NZD_PA (water + wastewater, NZD/yr), VOLUMETRIC_NZD_PER_M3 (NZD per m³ of water), THRESHOLD_L_PER_DAY, DATE_EST, NOTE (original headers FIXED_PA, VOLUMETRIC_PA, THRESHOLD_Lpd as an option)"; }
