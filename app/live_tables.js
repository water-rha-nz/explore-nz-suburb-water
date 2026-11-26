
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

// ---------------------------------------------------------------- Explore: billing beneath "Regions in this study"
// Each in-scope provider's charging periods (water_rates: one row per provider and start date; a period ends the day before the
// provider's next one), read from the database when shown: type, fixed NZD/yr, volumetric NZD per m³, threshold, verified, source.
const BILL = { rows: null, key: "" };
function billProviders() {
  const st = studyOf_ && studyOf_(), idx = (D.index || []).filter((r) => !st || (st.ta_codes || []).includes(r.ta_code)), out = new Map();
  for (const r of idx) { const p = ((D.regions || {})[r.id] || {}).provider || r.prvdr || ((BATCH.tas || []).find((t) => t.code === r.ta_code) || { prvdrs: [] }).prvdrs[0];
    if (p) { if (!out.has(p)) out.set(p, []); out.get(p).push(r.name || r.id); } }
  return out;
}
async function loadBilling(provs) {
  const key = [...provs].sort().join(","); if (BILL.key === key && BILL.rows && BILL.rows.length) return;   // empty results are re-read next time
  BILL.key = key; BILL.rows = null;
  try { BILL.rows = provs.length ? await q(sb.from("water_rates").select("prvdr,valid_from,charging_type,fixed_pa,volumetric_pa,threshold_lpd,value_rate,value_basis,date_est,note,source_url,website_url,policy_url,verified,providers(name)").in("prvdr", provs).order("prvdr").order("valid_from")) : []; }
  catch (e) { BILL.rows = []; BILL.err = e.message; }
  const el = $("#bill-body"); if (el) el.innerHTML = billingTable(billProviders());
}
function billingTable(pm) {
  if (!BILL.rows) return `<p class="small muted">Loading charges…</p>`;
  if (!BILL.rows.length) return `<p class="small muted">${BILL.err ? "Charges unavailable: " + esc(BILL.err) : "No charges recorded for these providers yet."}</p>`;
  const today = new Date().toISOString().slice(0, 10), dayBefore = (d) => { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() - 1); return x.toISOString().slice(0, 10); };
  const rows = BILL.rows.map((r, i) => { const nx = BILL.rows[i + 1] && BILL.rows[i + 1].prvdr === r.prvdr ? BILL.rows[i + 1].valid_from : null; return { ...r, end: nx ? dayBefore(nx) : "" }; });
  return `<table><thead><tr><th class="l">Provider</th><th class="l">Regions</th><th class="l">Period</th><th class="l">Charging</th><th>Fixed NZD/yr</th><th>Volumetric NZD/m³</th><th>Threshold L/day</th><th title="Water and wastewater charged on property value: dollars per $1 million of value">Value-based</th><th class="l">Checked</th><th class="l">Sources</th></tr></thead><tbody>
    ${rows.map((r) => { const cur = r.valid_from <= today && (!r.end || r.end >= today);
      return `<tr${cur ? ' style="background:var(--accent-soft)"' : ""}><td class="l"><b>${esc(r.prvdr)}</b> <span class="small muted">${esc((r.providers || {}).name || "")}</span></td><td class="l small">${esc((pm.get(r.prvdr) || []).join(", "))}</td>
        <td class="l small">${esc(r.valid_from)} to ${r.end ? esc(r.end) : "now"}${cur ? ' <span class="tag ok">current</span>' : ""}</td><td class="l small">${esc(r.charging_type || "–")}</td>
        <td>${r.fixed_pa == null ? "–" : "$" + fmt(r.fixed_pa, 2)}</td><td>${r.volumetric_pa == null ? "–" : "$" + fmt(r.volumetric_pa, 2)}</td><td>${r.threshold_lpd == null ? "–" : fmt(r.threshold_lpd)}</td>
        <td class="small" title="${r.value_rate == null ? "" : esc(`${r.value_rate} per $ of ${r.value_basis || "value"}`)}">${r.value_rate == null ? "–" : `$${fmt(r.value_rate * 1e6)} per $1M ${esc(r.value_basis || "value")}`}</td>
        <td class="l small">${r.verified ? '<span class="tag ok">verified</span>' : '<span class="tag warn">not verified</span>'}${r.date_est ? ` ${esc(r.date_est)}` : ""}</td>
        <td class="l small">${r.website_url ? `<a href="${esc(r.website_url)}" target="_blank" rel="noopener">website</a>` : '<span class="muted">website –</span>'} · ${(r.policy_url || r.source_url) ? `<a href="${esc(r.policy_url || r.source_url)}" target="_blank" rel="noopener">pricing policy</a>` : '<span class="muted">policy –</span>'}${r.note ? ` <span class="muted" title="${esc(r.note)}">note</span>` : ""}</td></tr>`; }).join("")}</tbody></table>
    <p class="small muted">Each period runs from its start date to the day before the provider's next period; the highlighted row applies today. Fixed charges are water plus wastewater per year; volumetric charges are per m³ of water used; value-based charges are shown per $1 million of capital or land value (a $700,000 property pays 0.7 times that). Each charge cites the provider's website and its pricing policy document (rates resolution, funding impact statement or fees schedule).</p>`;
}
{ const _dov = detailedOverviewHTML;
  detailedOverviewHTML = (...a) => {
    const html = _dov(...a), i = html.search(/<h2>(Regions in this study|All regions in the database)<\/h2>/); if (i < 0) return html;
    const j = html.indexOf("</table></div>", i); if (j < 0) return html;
    const pm = billProviders(); setTimeout(() => loadBilling([...pm.keys()]), 0);
    const at = j + "</table></div>".length;
    return html.slice(0, at) + `<h2>Billing</h2><div class="card scroll" id="bill-body">${billingTable(pm)}</div>` + html.slice(at);
  }; }
