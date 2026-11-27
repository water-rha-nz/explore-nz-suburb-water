
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
    ${prov.map(({ p, rows, regions, sections }) => `<tr><td class="l" title="${esc(p)}"><b>${esc(providerLegalName(p))}</b></td><td class="l small">${esc(regions.join(", "))}</td><td>${fmt(rows.length)}</td><td>${fmt(sections)}</td>
      ${ms.map((m) => { const a = tblAggregate(rows, m); return a ? `<td title="${esc(`${a.weighted ? "Mean weighted by sections" : "Mean"}; median ${fmt(a.med, m.d)}; range ${fmt(a.min, m.d)}–${fmt(a.max, m.d)}; ${a.n} suburbs`)}">${fmt(a.mean, m.d)}</td>` : "<td>–</td>"; }).join("")}</tr>`).join("") || `<tr><td colspan="${4 + ms.length}" class="muted">No suburbs in scope.</td></tr>`}</tbody></table>`;
  const key = (r) => TBL.sort === "name" ? mName(r.s) : TBL.sort === "ta" ? (r.s.ta || r.g.label) : TBL.sort === "prov" ? (r.g.provider || "") : TBL.sort === "sections" ? (+r.s.sections || 0) : (() => { const m = METRICS.find((x) => x.id === TBL.sort); const v = m && m.get(r.s); return v == null || !isFinite(v) ? null : v; })();
  const sorted = subs.slice().sort((a, b) => { const x = key(a), y = key(b); if (x == null) return 1; if (y == null) return -1; return (x < y ? -1 : x > y ? 1 : 0) * TBL.dir; });
  const sTable = `<table><thead><tr>${head("name", "Suburb")}${head("ta", "Territory")}${head("prov", "Provider")}${head("sections", "Sections")}${ms.map((m) => head(m.id, m.label, `${m.label} (${m.src || ""}): click to sort`)).join("")}</tr></thead><tbody>
    ${sorted.map((r) => `<tr><td class="l">${esc(mName(r.s))}</td><td class="l small">${esc(r.s.ta || r.g.label)}</td><td class="l small" title="${esc(r.g.provider || "")}">${esc(r.g.provider ? providerLegalName(r.g.provider) : "–")}</td><td>${fmt(r.s.sections)}</td>${ms.map((m) => `<td>${fmt(m.get(r.s), m.d)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
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
// Billing is per region / territory: each in-scope region gets the charges of its territorial authority (water_rates.ta_code),
// else its provider's territory-wide rows (no ta_code). Periods run from their start date to the day before the next period of the
// same provider and territory. Read from the database when shown.
const BILL = { rows: null, key: "" };
function billRegions() {
  const st = studyOf_ && studyOf_();
  return (D.index || []).filter((r) => !st || (st.ta_codes || []).includes(r.ta_code)).map((r) => {
    const ta = (BATCH.tas || []).find((t) => t.code === r.ta_code) || {};
    return { id: r.id, name: r.name || r.id, ta_code: r.ta_code, ta_name: ta.name || r.ta_code || "", prvdr: ((D.regions || {})[r.id] || {}).provider || r.prvdr || (ta.prvdrs || [])[0] || "" };
  });
}
// kept for callers that want providers in scope
function billProviders() { const out = new Map(); for (const r of billRegions()) if (r.prvdr) { if (!out.has(r.prvdr)) out.set(r.prvdr, []); out.get(r.prvdr).push(r.name); } return out; }
// charges are read by the territories of the regions in scope (any provider)
async function loadBilling() {
  const tas = [...new Set(billRegions().map((r) => r.ta_code).filter(Boolean))].sort(), key = tas.join(",");
  if (BILL.key === key && BILL.rows && BILL.rows.length) return;   // empty results are re-read next time
  BILL.key = key; BILL.rows = null;
  try { BILL.rows = tas.length ? await q(sb.from("water_rates").select("prvdr,ta_code,valid_from,charging_type,fixed_pa,volumetric_pa,threshold_lpd,value_rate,value_basis,date_est,note,source_url,website_url,policy_url,verified,tariff,providers(name)").in("ta_code", tas).order("ta_code").order("valid_from")) : []; }
  catch (e) { BILL.rows = []; BILL.err = e.message; }
  const el = $("#bill-body"); if (el) el.innerHTML = billingTable();
}
const dayBeforeISO = (d) => { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() - 1); return x.toISOString().slice(0, 10); };
// a region's charges are its territory's (whichever provider bills it); each provider's periods end the day before its next one.
// linked = the provider the study links the region to; differs = the territory is billed by another provider.
function regionCharges(reg, all) {
  const rows = all.filter((w) => w.ta_code && w.ta_code === reg.ta_code).slice().sort((x, y) => x.prvdr < y.prvdr ? -1 : x.prvdr > y.prvdr ? 1 : x.valid_from < y.valid_from ? -1 : 1);
  return rows.map((w, i) => { const nx = rows[i + 1] && rows[i + 1].prvdr === w.prvdr ? rows[i + 1].valid_from : null;
    return { ...w, end: nx ? dayBeforeISO(nx) : "", linked: reg.prvdr || "", differs: !!(reg.prvdr && reg.prvdr !== w.prvdr) }; });
}
let billingTable = function () {
  if (!BILL.rows) return `<p class="small muted">Loading charges…</p>`;
  if (!BILL.rows.length) return `<p class="small muted">${BILL.err ? "Charges unavailable: " + esc(BILL.err) : "No charges recorded for these regions yet."}</p>`;
  const today = new Date().toISOString().slice(0, 10), regs = billRegions();
  const body = regs.map((reg) => { const ch = regionCharges(reg, BILL.rows);
    if (!ch.length) return `<tr><td class="l"><b>${esc(reg.name)}</b></td><td class="l small">${esc(reg.ta_name)}</td><td class="l small">${esc(reg.prvdr ? providerLegalName(reg.prvdr) : "–")}</td><td colspan="8" class="muted small">No charges recorded for this territory yet.</td></tr>`;
    return ch.map((r, i) => { const cur = r.valid_from <= today && (!r.end || r.end >= today);
      return `<tr${cur ? ' style="background:var(--accent-soft)"' : ""}>${i === 0 ? `<td class="l" rowspan="${ch.length}"><b>${esc(reg.name)}</b></td><td class="l small" rowspan="${ch.length}">${esc(reg.ta_name)}</td><td class="l small" rowspan="${ch.length}"><span title="${esc(r.prvdr)}">${esc((r.providers || {}).name || providerLegalName(r.prvdr))}</span>${r.differs ? `<br><span class="tag warn" title="The study links this region to ${esc(r.linked)}; the charges shown are the territory's, billed by ${esc(r.prvdr)}">study links ${esc(providerLegalName(r.linked))}</span>` : ""}</td>` : ""}
        <td class="l small">${esc(r.valid_from)} to ${r.end ? esc(r.end) : "now"}${cur ? ' <span class="tag ok">current</span>' : ""}</td><td class="l small">${esc(r.charging_type || "–")}</td>
        <td>${r.fixed_pa == null ? "–" : "$" + fmt(r.fixed_pa, 2)}</td><td>${r.volumetric_pa == null ? "–" : "$" + fmt(r.volumetric_pa, 2)}</td><td>${r.threshold_lpd == null ? "–" : fmt(r.threshold_lpd)}</td>
        <td class="small" title="${r.value_rate == null ? "" : esc(`${r.value_rate} per $ of ${r.value_basis || "value"}`)}">${r.value_rate == null ? "–" : `$${fmt(r.value_rate * 1e6)} per $1M ${esc(r.value_basis || "value")}`}</td>
        <td class="l small">${r.verified ? '<span class="tag ok">verified</span>' : '<span class="tag warn">not verified</span>'}${r.date_est ? ` ${esc(r.date_est)}` : ""}</td>
        <td class="l small">${r.website_url ? `<a href="${esc(r.website_url)}" target="_blank" rel="noopener">website</a>` : '<span class="muted">website –</span>'} · ${(r.policy_url || r.source_url) ? `<a href="${esc(r.policy_url || r.source_url)}" target="_blank" rel="noopener">pricing policy</a>` : '<span class="muted">policy –</span>'}${r.note ? ` <span class="muted" title="${esc(r.note)}">note</span>` : ""}</td></tr>`; }).join(""); }).join("");
  return `<table><thead><tr><th class="l">Region</th><th class="l">Territory</th><th class="l">Provider</th><th class="l">Period</th><th class="l">Charging</th><th>Fixed NZD/yr</th><th>Volumetric NZD/m³</th><th>Threshold L/day</th><th title="Water and wastewater charged on property value: dollars per $1 million of value">Value-based</th><th class="l">Checked</th><th class="l">Sources</th></tr></thead><tbody>${body}</tbody></table>
    <p class="small muted">Charges belong to the territory: each region shows what its territorial authority's provider charges there, whichever provider the study links to the region (a different link is flagged). Each period runs from its start date to the day before the next; the highlighted row applies today. Fixed charges are water plus wastewater per year; volumetric charges are per m³ of water used; value-based charges are shown per $1 million of capital or land value (a $700,000 property pays 0.7 times that). Each charge cites the provider's website and its pricing policy document.</p>`;
};
{ const _dov = detailedOverviewHTML;
  detailedOverviewHTML = (...a) => {
    const html = _dov(...a), i = html.search(/<h2>(Regions in this study|All regions in the database)<\/h2>/); if (i < 0) return html;
    const j = html.indexOf("</table></div>", i); if (j < 0) return html;
    setTimeout(() => loadBilling(), 0);   // billing rows are per region / territory
    const at = j + "</table></div>".length;
    return html.slice(0, at) + `<h2>Billing</h2><div class="card scroll" id="bill-body">${billingTable()}</div>` + html.slice(at);
  }; }

// ---------------------------------------------------------------- billing estimator (providers that publish a full tariff)
// Tiaki Wai 2026/27: parameters from its billing-page calculator (validated against its Pricing Policy). The formula is rebuilt from
// those parameters and the policy's rules (its own calculator code is not published with the page), residential properties only:
//  Wellington: water = fixed + per $CV (or metered: fixed + per m3); wastewater = fixed + per $CV
//  Hutt: water = per household (or metered: fixed + per m3); wastewater = per household
//  Porirua: water = per SUIP (or metered: per m3); wastewater = per pan, a home counting as one pan per SUIP
//  Upper Hutt: water = per SUIP + per $CV (or metered: fixed + per m3); wastewater = per pan, one per SUIP
//  Stormwater: fixed (per SUIP in Hutt) + per $CV, shown separately (not part of water + wastewater)
function tiakiwaiEstimate(R, city, cv, metered, m3, suip) {
  const r = R[city]; if (!r) return null; suip = Math.max(1, +suip || 1); cv = +cv || 0; m3 = +m3 || 0;
  let water, ww, sw;
  if (city === "WCC") { water = metered ? r.waterMeterFixed + r.waterMeterRate * m3 : r.waterResFixed + r.waterResCVRate * cv; ww = r.wwResFixed + r.wwResCVRate * cv; sw = r.swResFixed + r.swResCVRate * cv; }
  else if (city === "HCC") { water = metered ? r.waterMeterFixed + r.waterMeterRate * m3 : r.waterSUIPFixed * suip; ww = r.wwSUIPFixed * suip; sw = r.swResFixed * suip + r.swResCVRate * cv; }
  else if (city === "PCC") { water = metered ? r.waterMeterRate * m3 : r.waterSUIPFixed * suip; ww = r.wwPanFixed * suip; sw = r.swResFixed * suip + r.swResCVRate * cv; }
  else if (city === "UHCC") { water = metered ? r.waterMeterFixed + r.waterMeterRateRes * m3 : r.waterNoMeterFixed * suip + r.waterNoMeterCVRate * cv; ww = r.wwPanFixed * suip; sw = r.swResFixed + r.swResCVRate * cv; }
  else return null;
  return { water, ww, sw, total: water + ww };
}
const TW_CITY = { "047": "WCC", "046": "HCC", "044": "PCC", "045": "UHCC" };
const EST = { city: store.get("est-city", "") || "WCC", cv: store.get("est-cv", "800000"), metered: store.get("est-met", "0") === "1", m3: store.get("est-m3", "200"), suip: store.get("est-suip", "1") };
function estimatorHTML() {
  const t = (BILL.rows || []).find((r) => r.tariff && r.tariff.model === "tiakiwai-2026-27"); if (!t) return "";
  if (!store.get("est-city", "")) { const r = billRegions().find((x) => TW_CITY[x.ta_code]); if (r) EST.city = TW_CITY[r.ta_code]; }
  const R = t.tariff.rates, e = tiakiwaiEstimate(R, EST.city, EST.cv, EST.metered, EST.m3, EST.suip), names = { WCC: "Wellington City", HCC: "Hutt City", PCC: "Porirua City", UHCC: "Upper Hutt City" };
  const money = (v) => v == null ? "–" : "$" + fmt(v, 2);
  return `<div class="card" id="est-card" style="margin-top:10px"><h3>Estimate a bill: ${esc(t.prvdr)} 2026/27 (residential)</h3>
    <div class="row small" style="gap:10px;flex-wrap:wrap">
      <label>City <select id="est-city">${Object.keys(R).map((k) => `<option value="${k}" ${k === EST.city ? "selected" : ""}>${names[k] || k}</option>`).join("")}</select></label>
      <label>Rateable capital value $ <input type="number" id="est-cv" min="0" step="10000" value="${esc(EST.cv)}" style="width:110px"></label>
      <label><input type="checkbox" id="est-met" ${EST.metered ? "checked" : ""}> water meter</label>
      <label>Water used m³/yr <input type="number" id="est-m3" min="0" step="10" value="${esc(EST.m3)}" style="width:80px" ${EST.metered ? "" : "disabled"}></label>
      <label>Households on the property <input type="number" id="est-suip" min="1" step="1" value="${esc(EST.suip)}" style="width:60px"></label></div>
    ${e ? `<table style="margin-top:6px"><tbody><tr><td>Drinking water</td><td>${money(e.water)}</td></tr><tr><td>Wastewater</td><td>${money(e.ww)}</td></tr><tr><td><b>Water + wastewater</b></td><td><b>${money(e.total)}</b></td></tr><tr><td class="muted">Stormwater (also billed)</td><td class="muted">${money(e.sw)}</td></tr></tbody></table>` : ""}
    <p class="small muted">Uses the rates published in ${esc(t.prvdr)}'s billing calculator, checked against its <a href="${esc(t.policy_url || t.source_url || "")}" target="_blank" rel="noopener">pricing policy</a>. The formula is rebuilt from those rates and the policy's rules (the provider's own calculator code isn't published with the page), so treat results as indicative; the bill confirms the charge.</p></div>`;
}
{ const _bt = billingTable; billingTable = (...a) => _bt(...a) + estimatorHTML(); }
document.addEventListener("input", (e) => {
  const id = e.target && e.target.id; if (!/^est-/.test(id || "")) return;
  if (id === "est-city") EST.city = e.target.value; else if (id === "est-cv") EST.cv = e.target.value; else if (id === "est-met") EST.metered = e.target.checked; else if (id === "est-m3") EST.m3 = e.target.value; else if (id === "est-suip") EST.suip = e.target.value;
  for (const [k, v] of Object.entries({ "est-city": EST.city, "est-cv": EST.cv, "est-met": EST.metered ? "1" : "0", "est-m3": EST.m3, "est-suip": EST.suip })) store.set(k, String(v));
  const c = $("#est-card"); if (c) c.outerHTML = estimatorHTML();
});
document.addEventListener("change", (e) => { if (e.target && (e.target.id === "est-met" || e.target.id === "est-city")) e.target.dispatchEvent(new Event("input", { bubbles: true })); });
