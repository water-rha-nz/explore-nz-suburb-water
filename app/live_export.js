
// ---------------------------------------------------------------- export builder: configure, then stream from Supabase
// Choose the regions (any prepared region in the database, loaded or not), the statistics and the formats; the data is fetched
// from Supabase when you export (regions not in the session are fetched for the export only and released afterwards), and the
// files come as one .zip of CSVs (with a manifest) or one .xlsx. Two formats are new here: water charges by period (each
// component with its start and end date) and climate time series (daily, monthly or annual; per climate cell or per suburb).
const XB = { regions: null, metrics: null, formats: null, running: false };
const XB_FORMATS = () => [
  ...Object.keys(EXPORTS).filter((f) => /\.(csv|tsv|txt)$/i.test(f) && !f.startsWith("validation_")).map((f) => [f, EXPORTS[f].desc]),
  ["water_charges_by_period.csv", "PROVIDER, NAME, COMPONENT, VALUE, UNIT, START, END, CHARGING_TYPE, VERIFIED, SOURCE: each charge component per period (END is the day before the next period starts; blank = current)"],
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
    D.regions = tmp; store.set("scope", "all"); SECT = null;
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

// charges: each provider's periods start at valid_from and end the day before its next period (blank = current)
async function xbRates(regs) {
  const byProv = {}; for (const [k, g] of regs) if (g.provider) (byProv[g.provider] = byProv[g.provider] || []).push([k, g]);
  const provs = Object.keys(byProv);
  if (!provs.length) return csv([["PROVIDER", "NOTE"], ["", "no provider set for the chosen regions"]]);
  const rows = await q(sb.from("water_rates").select("prvdr,valid_from,charging_type,fixed_pa,volumetric_pa,threshold_lpd,date_est,note,source_url,verified,providers(name)").in("prvdr", provs).order("prvdr").order("valid_from"));
  const R = xbStore("rates", { from: "", to: "", shape: "long" }), dayBefore = (d) => { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() - 1); return x.toISOString().slice(0, 10); };
  const per = rows.map((r, i) => { const nx = rows[i + 1] && rows[i + 1].prvdr === r.prvdr ? rows[i + 1].valid_from : null; return { ...r, start: r.valid_from, end: nx ? dayBefore(nx) : "" }; })
    .filter((r) => { const w = xbUnion(byProv[r.prvdr].map(([k]) => xbPeriod(k, "rates"))); return (!w.to || r.start <= w.to) && (!w.from || !r.end || r.end >= w.from); });
  const regsOf = (r) => byProv[r.prvdr].map(([, g]) => g.label).join("; ");
  const name = (r) => (r.providers || {}).name || r.prvdr;
  if (R.shape === "wide") return csv([["PROVIDER", "NAME", "REGIONS", "START", "END", "CHARGING_TYPE", "FIXED_PA", "VOLUMETRIC_PA", "THRESHOLD_Lpd", "DATE_EST", "VERIFIED", "SOURCE", "NOTE"],
    ...per.map((r) => [r.prvdr, name(r), regsOf(r), r.start, r.end, r.charging_type || "", r.fixed_pa ?? "", r.volumetric_pa ?? "", r.threshold_lpd ?? "", r.date_est || "", r.verified ? "yes" : "no", r.source_url || "", r.note || ""])]);
  const comps = [["FIXED", "fixed_pa", "NZD/yr"], ["VOLUMETRIC", "volumetric_pa", "NZD/m³"], ["THRESHOLD", "threshold_lpd", "L/day"]];
  return csv([["PROVIDER", "NAME", "REGIONS", "COMPONENT", "VALUE", "UNIT", "START", "END", "CHARGING_TYPE", "VERIFIED", "SOURCE"],
    ...per.flatMap((r) => comps.filter(([, k]) => r[k] != null).map(([c, k, u]) => [r.prvdr, name(r), regsOf(r), c, r[k], u, r.start, r.end, r.charging_type || "", r.verified ? "yes" : "no", r.source_url || ""]))]);
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
