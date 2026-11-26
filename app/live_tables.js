
// ---------------------------------------------------------------- Explore: summary tables per provider and per suburb
// For the regions in scope (the chosen study's, or all loaded): one row per provider with each statistic aggregated over its
// suburbs (mean weighted by residential sections; hover for the median, range and number of suburbs), and one sortable row per
// suburb. The data type (statistic source group) is selectable; both tables download as CSV.
const TBL = { type: store.get("tbl-type", "all"), sort: store.get("tbl-sort", "name"), dir: +store.get("tbl-dir", "1") };
const tblGroups = () => [...new Set(METRICS.map((m) => m.src || "Other"))];
// the statistics chosen for export (Export builder) also choose the table columns; the data type narrows them further
const tblMetrics = () => { xbDefaults(); return METRICS.filter((m) => XB.metrics.has(m.id) && (TBL.type === "all" || (m.src || "Other") === TBL.type)); };
function tblPickerHTML() {
  xbDefaults();
  const groups = {}; for (const m of METRICS) (groups[m.src || "Other"] = groups[m.src || "Other"] || []).push(m);
  return `<details style="margin:0 0 8px"><summary class="small">Statistics: ${XB.metrics.size} of ${METRICS.length} chosen (shared with the Export builder)</summary>
    <div class="small" style="max-height:150px;overflow:auto;margin-top:4px">${Object.entries(groups).map(([g, ms]) => `<div><b>${esc(g)}</b> ${ms.map((m) => `<label style="display:inline-flex;gap:4px;margin:2px 10px 2px 0"><input type="checkbox" data-xb-metric="${esc(m.id)}" ${XB.metrics.has(m.id) ? "checked" : ""}> ${esc(m.label)}</label>`).join("")}</div>`).join("")}
    <button class="btn" type="button" data-xb-metrics="all" style="padding:0 6px">All</button> <button class="btn" type="button" data-xb-metrics="none" style="padding:0 6px">None</button></div></details>`;
}
const tblSubs = () => studyRegions().flatMap(([k, g]) => g.suburbs.filter(resident).map((s) => ({ s, k, g })));
const provName = (code) => ((D.water_rates || []).find((w) => w.PROVIDER === code) || {}).name || code || "–";
function tblAggregate(rows, m) {
  const v = rows.map(({ s }) => [m.get(s), +s.sections || 0]).filter(([x]) => x != null && isFinite(x));
  if (!v.length) return null;
  const w = v.reduce((a, [, n]) => a + n, 0), mean = w ? v.reduce((a, [x, n]) => a + x * n, 0) / w : v.reduce((a, [x]) => a + x, 0) / v.length;
  const xs = v.map(([x]) => x).sort((a, b) => a - b), med = xs.length % 2 ? xs[(xs.length - 1) / 2] : (xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2;
  return { mean, med, min: xs[0], max: xs[xs.length - 1], n: xs.length, weighted: !!w };
}
function providerRows() {
  const by = new Map();
  for (const r of tblSubs()) { const p = r.g.provider || "–"; if (!by.has(p)) by.set(p, []); by.get(p).push(r); }
  return [...by].sort((a, b) => a[0] < b[0] ? -1 : 1).map(([p, rows]) => ({ p, rows, regions: [...new Set(rows.map((r) => r.g.label))], sections: rows.reduce((a, { s }) => a + (+s.sections || 0), 0) }));
}
function tablesHTML() {
  const ms = tblMetrics(), subs = tblSubs(), st = studyOf_ && studyOf_();
  const missing = st ? (D.index || []).filter((r) => (st.ta_codes || []).includes(r.ta_code) && !D.regions[r.id] && r.status === "published") : [];
  const head = (k, l, t = "") => `<th class="${k === "name" || k === "ta" || k === "prov" ? "l" : ""}" data-tbl-sort="${esc(k)}" style="cursor:pointer;white-space:nowrap" title="${esc(t || "Sort")}">${esc(l)}${TBL.sort === k ? (TBL.dir > 0 ? " ▲" : " ▼") : ""}</th>`;
  const prov = providerRows();
  const pTable = `<table><thead><tr><th class="l">Provider</th><th class="l">Regions</th><th>Suburbs</th><th>Sections</th>${ms.map((m) => `<th title="${esc(m.label)} (${esc(m.src || "")})">${esc(m.label)}</th>`).join("")}</tr></thead><tbody>
    ${prov.map(({ p, rows, regions, sections }) => `<tr><td class="l"><b>${esc(p)}</b> <span class="small muted">${esc(provName(p))}</span></td><td class="l small">${esc(regions.join(", "))}</td><td>${fmt(rows.length)}</td><td>${fmt(sections)}</td>
      ${ms.map((m) => { const a = tblAggregate(rows, m); return a ? `<td title="${esc(`${a.weighted ? "Mean weighted by sections" : "Mean"}; median ${fmt(a.med, m.d)}; range ${fmt(a.min, m.d)}–${fmt(a.max, m.d)}; ${a.n} suburbs`)}">${fmt(a.mean, m.d)}</td>` : "<td>–</td>"; }).join("")}</tr>`).join("") || `<tr><td colspan="${4 + ms.length}" class="muted">No suburbs in scope.</td></tr>`}</tbody></table>`;
  const key = (r) => TBL.sort === "name" ? mName(r.s) : TBL.sort === "ta" ? (r.s.ta || r.g.label) : TBL.sort === "prov" ? (r.g.provider || "") : TBL.sort === "sections" ? (+r.s.sections || 0) : (() => { const m = METRICS.find((x) => x.id === TBL.sort); const v = m && m.get(r.s); return v == null || !isFinite(v) ? null : v; })();
  const sorted = subs.slice().sort((a, b) => { const x = key(a), y = key(b); if (x == null) return 1; if (y == null) return -1; return (x < y ? -1 : x > y ? 1 : 0) * TBL.dir; });
  const sTable = `<table><thead><tr>${head("name", "Suburb")}${head("ta", "Territory")}${head("prov", "Provider")}${head("sections", "Sections")}${ms.map((m) => head(m.id, m.label, `${m.label} (${m.src || ""}): click to sort`)).join("")}</tr></thead><tbody>
    ${sorted.map((r) => `<tr><td class="l">${esc(mName(r.s))}</td><td class="l small">${esc(r.s.ta || r.g.label)}</td><td class="l small">${esc(r.g.provider || "–")}</td><td>${fmt(r.s.sections)}</td>${ms.map((m) => `<td>${fmt(m.get(r.s), m.d)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  return `<h2 id="tbl-top">Summary tables</h2>
    <div class="row" style="margin-bottom:8px"><label class="small">Data type <select id="tbl-type"><option value="all" ${TBL.type === "all" ? "selected" : ""}>All statistics</option>${tblGroups().map((g) => `<option value="${esc(g)}" ${TBL.type === g ? "selected" : ""}>${esc(g)}</option>`).join("")}</select></label>
      <span class="small muted">${st ? `Study: ${esc(st.name)}` : "All loaded regions"} · ${fmt(subs.length)} suburbs with residential sections</span>
      ${missing.length ? `<button class="btn" type="button" id="tbl-load">Load ${missing.length} more region${missing.length === 1 ? "" : "s"} of the study</button>` : ""}</div>
    ${tblPickerHTML()}
    <h3>Per provider</h3><p class="small muted">Each figure is the mean over the provider's suburbs, weighted by residential sections. Hover for the median, the range and the number of suburbs.</p>
    <div class="card scroll">${pTable}</div><p><button class="btn" type="button" data-tbl-dl="provider">Download per-provider CSV</button></p>
    <h3>Per suburb</h3><p class="small muted">Click a column heading to sort.</p>
    <div class="card scroll" style="max-height:520px">${sTable}</div><p><button class="btn" type="button" data-tbl-dl="suburb">Download per-suburb CSV</button></p>`;
}
const _vExploreTbl = V.explore;
V.explore = (...a) => { const html = _vExploreTbl(...a); return D && D.regions && Object.keys(D.regions).length && !/Before this step|isn't prepared yet/.test(html) ? html + tablesHTML() : html; };
// a statistic ticked here (or in the Export builder) redraws the tables; the builder's own handler saves the choice
document.addEventListener("change", (e) => { if (e.target && e.target.dataset && e.target.dataset.xbMetric && stage === "explore") setTimeout(() => { render(); const x = $("#tbl-top"); if (x && x.scrollIntoView) x.scrollIntoView(); }, 0); });
document.addEventListener("change", (e) => { if (e.target && e.target.id === "tbl-type") { TBL.type = e.target.value; store.set("tbl-type", TBL.type); render(); setTimeout(() => { const t = $("#tbl-top"); if (t && t.scrollIntoView) t.scrollIntoView(); }, 0); } });
document.addEventListener("click", async (e) => {
  const t = e.target; if (!t || !t.closest) return;
  const h = t.closest("[data-tbl-sort]");
  if (h) { const k = h.dataset.tblSort; TBL.dir = TBL.sort === k ? -TBL.dir : 1; TBL.sort = k; store.set("tbl-sort", k); store.set("tbl-dir", String(TBL.dir)); render(); setTimeout(() => { const x = $("#tbl-top"); if (x && x.scrollIntoView) x.scrollIntoView(); }, 0); return; }
  if (t.id === "tbl-load") { const st = studyOf_ && studyOf_(); const ids = st ? (D.index || []).filter((r) => (st.ta_codes || []).includes(r.ta_code) && !D.regions[r.id] && r.status === "published").map((r) => r.id) : [];
    t.disabled = true; t.textContent = "Loading…"; try { await ensureRegions(ids, (i, n, nm) => { t.textContent = `Loading ${i} of ${n}: ${nm}…`; }); } catch (err) { toastMsg(err.message); } render(); return; }
  const dl = t.closest("[data-tbl-dl]"); if (!dl) return;
  const ms = tblMetrics(), stamp = new Date().toISOString().slice(0, 10), tag = TBL.type === "all" ? "all" : TBL.type.replace(/[^\w]+/g, "_").toLowerCase();
  if (dl.dataset.tblDl === "provider") download(`provider_summary_${tag}_${stamp}.csv`, csv([["PROVIDER", "NAME", "REGIONS", "SUBURBS", "SECTIONS", ...ms.flatMap((m) => [m.id + "_MEAN_W", m.id + "_MEDIAN", m.id + "_MIN", m.id + "_MAX", m.id + "_N"])],
    ...providerRows().map(({ p, rows, regions, sections }) => [p, provName(p), regions.join("; "), rows.length, sections, ...ms.flatMap((m) => { const a = tblAggregate(rows, m); return a ? [+a.mean.toFixed(m.d + 1), +a.med.toFixed(m.d + 1), +a.min.toFixed(m.d + 1), +a.max.toFixed(m.d + 1), a.n] : ["", "", "", "", 0]; })])]));
  else download(`suburb_summary_${tag}_${stamp}.csv`, csv([["M_SUBURB", "M_TERRITORY", "PRVDR", "SECTIONS", ...ms.map((m) => m.id)],
    ...tblSubs().map(({ s, g }) => [mName(s), s.ta || g.label, g.provider || "", s.sections ?? "", ...ms.map((m) => { const v = m.get(s); return v == null || !isFinite(v) ? "" : +(+v).toFixed(m.d); })])]));
});
