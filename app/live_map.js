// 1 Region: a navigable data map of everything in the database. Lightweight by design: all layers are drawn from data the
// app already loaded at sign-in (plus one cached request for TA outlines). One fill layer (a suburb statistic) combines with
// any of the symbol overlays (pools, green space, rainfall); the legend adds one entry per active layer, each linked to its
// source. Imagery is fetched only at full zoom, and only for detected pools and validation chips (pools and gardens) in view.
"use strict";
const SRC = {
  linz_suburbs: ["LINZ NZ Suburbs and Localities (layer 113764)", "https://data.linz.govt.nz/layer/113764/"],
  linz_parcels: ["LINZ NZ Primary Parcels (layer 50772)", "https://data.linz.govt.nz/layer/50772/"],
  linz_titles: ["LINZ NZ Property Titles (layer 50804)", "https://data.linz.govt.nz/layer/50804/"],
  linz_buildings: ["LINZ NZ Building Outlines (layer 101290)", "https://data.linz.govt.nz/layer/101290/"],
  imagery: ["LINZ aerial imagery, RGB + near-infrared (nz-imagery open data)", "https://registry.opendata.aws/nz-imagery/"],
  cen_hou020: ["Stats NZ Census, dwellings and tenure (CEN23_HOU_020)", "https://explore.data.stats.govt.nz/vis?df[ds]=ds-nsiws-disseminate&df[id]=CEN23_HOU_020&df[ag]=STATSNZ"],
  cen_fhh038: ["Stats NZ Census, household composition and size (CEN23_FHH_038)", "https://explore.data.stats.govt.nz/vis?df[ds]=ds-nsiws-disseminate&df[id]=CEN23_FHH_038&df[ag]=STATSNZ"],
  cen_hou001: ["Stats NZ Census, household income (CEN23_HOU_001)", "https://explore.data.stats.govt.nz/vis?df[ds]=ds-nsiws-disseminate&df[id]=CEN23_HOU_001&df[ag]=STATSNZ"],
  sa2: ["Stats NZ Statistical Area 2 2023 (Datafinder layer 111206)", "https://datafinder.stats.govt.nz/layer/111206/"],
  openmeteo: ["Open-Meteo Historical Weather API (ERA5 reanalysis)", "https://open-meteo.com/en/docs/historical-weather-api"],
};
const srcLink = (k) => SRC[k] ? `<a href="${SRC[k][1]}" target="_blank" rel="noopener">${esc(SRC[k][0])}</a>` : "";
const MAPV = { fill: store.get("map-fill", "hh_size"), year: store.get("map-year", ""), over: new Set(JSON.parse(store.get("map-over", '["pools","green"]'))),
  items: {}, urls: {}, sel: null, cent: {}, raf: 0, fetchT: 0, note: "" };
const cenOf = (s) => { const c = s.census || {}; const y = MAPV.year && c[MAPV.year] ? MAPV.year : Object.keys(c).sort().pop(); return y ? c[y] : {}; };
// fill layers: [key, label, unit/format digits, value(s), sources, diverging]
const FILLS = [
  ["none", "None"],
  ["hh_size", "Household size (mean, persons)", 2, (s) => cenOf(s).hh_size_mean, ["cen_fhh038", "sa2"]],
  ["income", "Median household income ($)", 0, (s) => cenOf(s).income_median, ["cen_hou001", "sa2"]],
  ["owner", "Owner-occupied households (%)", 0, (s) => cenOf(s).pct_owner_all, ["cen_hou020", "sa2"]],
  ["separate", "Separate houses (%)", 0, (s) => cenOf(s).pct_separate, ["cen_hou020", "sa2"]],
  ["bedrooms", "Bedrooms per dwelling (mean)", 1, (s) => cenOf(s).bedrooms_mean_all, ["cen_hou020", "sa2"]],
  ["density", "Titles per km²", 0, (s) => s.density_per_km2, ["linz_titles", "linz_suburbs"]],
  ["lot", "Median section (m²)", 0, (s) => s.LotSize, ["linz_parcels"]],
  ["garden", "Median garden per section (m²)", 0, (s) => s.GardSize, ["imagery", "linz_parcels", "linz_buildings"]],
  ["pool", "Sections with a pool (%)", 1, (s) => s.PercPool, ["imagery", "linz_parcels"]],
  ["rain", "Annual rainfall (mm)", 0, (s) => s.climate_annual && s.climate_annual.rain_mm, ["openmeteo"]],
  ["et0", "Annual evapotranspiration ET₀ (mm)", 0, (s) => s.climate_annual && s.climate_annual.et0_mm, ["openmeteo"]],
  ["deficit", "Rainfall − ET₀ (mm/yr)", 0, (s) => s.climate_annual && s.climate_annual.rain_mm - s.climate_annual.et0_mm, ["openmeteo"], true],
];
// overlays (combine freely): [key, label, colour, value(s) for symbol size, unit, sources]
const OVERS = [
  ["pools", "Pool area (≈ pools × median pool m²)", "#1f78d1", (s) => (+s.pools || 0) * (+s.PoolArea || 0), "m²", ["imagery", "linz_parcels"]],
  ["green", "Green space (≈ sections × median garden m²)", "#2e9e4f", (s) => (+s.sections || 0) * (+s.GardSize || 0), "m²", ["imagery", "linz_parcels", "linz_buildings"]],
  ["rainbar", "Annual rainfall bars", "#5b6ee1", (s) => s.climate_annual && s.climate_annual.rain_mm, "mm", ["openmeteo"]],
  ["labels", "Suburb names", "var(--ink)", null, "", ["linz_suburbs"]],
];
const RAMP = ["#f1eef6", "#bdc9e1", "#74a9cf", "#2b8cbe", "#045a8d"], DIV = ["#b2182b", "#ef8a62", "#f7f7f7", "#67a9cf", "#2166ac"];
const allSubs = () => Object.entries(D.regions || {}).flatMap(([k, g]) => g.suburbs.filter((s) => Array.isArray(s.geom) && s.geom.length).map((s) => ({ s, k, g })));
function centroid(s) {
  if (MAPV.cent[s.linz_id]) return MAPV.cent[s.linz_id];
  let best = null, ba = -1;
  for (const p of s.geom || []) { const r = p[0]; let a = 0, cx = 0, cy = 0;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const f = r[j][0] * r[i][1] - r[i][0] * r[j][1]; a += f; cx += (r[j][0] + r[i][0]) * f; cy += (r[j][1] + r[i][1]) * f; }
    if (Math.abs(a) > ba) { ba = Math.abs(a); best = a ? [cx / (3 * a), cy / (3 * a)] : r[0]; } }
  return (MAPV.cent[s.linz_id] = best || [0, 0]);
}
function breaks(vals) { const v = vals.filter((x) => x != null && isFinite(x)).sort((a, b) => a - b); if (!v.length) return null;
  return [0.2, 0.4, 0.6, 0.8].map((p) => v[Math.min(v.length - 1, Math.floor(p * v.length))]).concat([v[v.length - 1]]).map((x, i, a) => i ? Math.max(x, a[i - 1]) : x).concat([v[0]]); }
function fillColour(v, br, div) { if (v == null || !isFinite(v) || !br) return null; const pal = div ? DIV : RAMP; for (let i = 0; i < 4; i++) if (v <= br[i]) return pal[i]; return pal[4]; }

// ---------------------------------------------------------------- shell
function dataMapHTML() {
  const years = [...new Set(allSubs().flatMap(({ s }) => Object.keys(s.census || {})))].sort();
  const f = FILLS.find((x) => x[0] === MAPV.fill) || FILLS[0];
  return `<div class="card" id="datamap"><div class="row" style="gap:10px;flex-wrap:wrap;margin-bottom:8px">
      <label class="small">Fill <select id="mv-fill">${FILLS.map(([k, l]) => `<option value="${k}" ${k === MAPV.fill ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>
      ${years.length ? `<label class="small">Census year <select id="mv-year">${years.map((y) => `<option ${y === (MAPV.year || years[years.length - 1]) ? "selected" : ""}>${y}</option>`).join("")}</select></label>` : ""}
      ${OVERS.map(([k, l, c]) => `<label class="small"><input type="checkbox" data-mvover="${k}" ${MAPV.over.has(k) ? "checked" : ""}> <span style="color:${c}">●</span> ${esc(l.split(" (")[0])}</label>`).join("")}</div>
    <div class="grid" style="grid-template-columns:minmax(0,3fr) minmax(220px,1fr);gap:12px">
      <div id="mv-map"><p class="muted small">Loading map…</p></div>
      <div><div id="mv-legend" class="small"></div><div id="mv-info" class="small" style="margin-top:10px"></div></div></div>
    <p class="small muted" style="margin:6px 0 0">Scroll to zoom, drag to pan. Suburb symbols scale with the zoom; imagery of detected pools and validated pools/gardens loads only at full zoom (under ~2.5 km across). Click a suburb for its figures and sources.</p></div>`;
}
async function drawDataMap() {
  const host = $("#mv-map"); if (!host) return;
  try { if (!BATCH.tas) BATCH.tas = await q(sb.rpc("ta_outlines", { p_tol: 200 })); } catch (e) { BATCH.tas = BATCH.tas || []; }
  const subs = allSubs(), f = FILLS.find((x) => x[0] === MAPV.fill) || FILLS[0];
  const br = f[3] ? breaks(subs.map(({ s }) => f[3](s))) : null;
  const base = (BATCH.tas || []).filter((t) => t.geom && t.geom.coordinates).map((t) => ({ d: pathD(t.geom.coordinates), fill: "var(--land)", stroke: "var(--landline)", sw: 0.6, title: t.name }));
  const fills = subs.map(({ s, k, g }) => { const v = f[3] ? f[3](s) : null, c = fillColour(v, br, f[5]);
    return { attr: `data-mvsub="${s.linz_id}" data-reg="${esc(k)}"`, click: true, d: pathD(s.geom), fill: c || (f[3] ? "var(--land)" : "#e8e4da"), op: c ? 0.85 : 0.9, sw: 0.5,
      title: `${s.name} (${g.label})${f[3] ? `: ${v == null || !isFinite(v) ? "no data" : fmt(v, f[2])}` : ""}` }; });
  const all = subs.length ? mapBox(subs.map(({ s }) => s.geom)) : mapBox((BATCH.tas || []).map((t) => t.geom.coordinates));
  const nz = (BATCH.tas || []).length ? mapBox(BATCH.tas.map((t) => t.geom.coordinates)) : all;
  host.innerHTML = zoomMap("ovw", [...base, ...fills], nz).replace("</svg>", '<g id="mv-dyn"></g></svg>').replace('data-zoom="sel">Selection', 'data-zoom="sel">Data');
  const svg = host.querySelector("svg"); if (svg) { if (!(BATCH.view && BATCH.view.id === "ovw")) setView(svg, all); else dynLayers(svg, BATCH.view.box); }
  legendHTML(br, f);
}
// symbols that keep a constant screen size: redrawn whenever the view changes
function dynLayers(svg, box) {
  const g = svg.querySelector("#mv-dyn"); if (!g) return;
  const px = box[2] / Math.max(1, svg.getBoundingClientRect().width || 800);   // metres per screen pixel
  const subs = allSubs().filter(({ s }) => { const [x, y] = centroid(s); return x > box[0] - box[2] * 0.1 && x < box[0] + box[2] * 1.1 && -y > box[1] - box[3] * 0.1 && -y < box[1] + box[3] * 1.1; });
  let h = "";
  const sym = (k) => { const o = OVERS.find((x) => x[0] === k); const max = Math.max(1, ...allSubs().map(({ s }) => +o[3](s) || 0)); return { o, max }; };
  if (MAPV.over.has("green")) { const { o, max } = sym("green");
    for (const { s } of subs) { const v = +o[3](s) || 0; if (!v) continue; const [x, y] = centroid(s), r = Math.max(2, 14 * Math.sqrt(v / max)) * px;
      h += `<circle cx="${x - r * 0.6}" cy="${-y}" r="${r}" fill="${o[2]}" fill-opacity=".55" stroke="#fff" stroke-width="${0.8 * px}"><title>${esc(s.name)}: ≈ ${fmt(v / 1e4, 1)} ha green space</title></circle>`; } }
  if (MAPV.over.has("pools")) { const { o, max } = sym("pools");
    for (const { s } of subs) { const v = +o[3](s) || 0; if (!v) continue; const [x, y] = centroid(s), r = Math.max(2, 10 * Math.sqrt(v / max)) * px;
      h += `<circle cx="${x + r * 0.6}" cy="${-y}" r="${r}" fill="${o[2]}" fill-opacity=".75" stroke="#fff" stroke-width="${0.8 * px}"><title>${esc(s.name)}: ${fmt(s.pools)} pools, ≈ ${fmt(v)} m² of pool</title></circle>`; } }
  if (MAPV.over.has("rainbar")) { const { o, max } = sym("rainbar");
    for (const { s } of subs) { const v = +o[3](s) || 0; if (!v) continue; const [x, y] = centroid(s), hgt = 24 * (v / max) * px, w = 4 * px;
      h += `<rect x="${x - w / 2}" y="${-y - hgt - 3 * px}" width="${w}" height="${hgt}" fill="${o[2]}" stroke="#fff" stroke-width="${0.5 * px}"><title>${esc(s.name)}: ${fmt(v)} mm rain per year</title></rect>`; } }
  if (MAPV.over.has("labels") && box[2] < 60000) for (const { s } of subs) { const [x, y] = centroid(s);
    h += `<text x="${x}" y="${-y + 14 * px}" font-size="${11 * px}" text-anchor="middle" style="fill:var(--ink);paint-order:stroke;stroke:var(--panel);stroke-width:${3 * px}px;pointer-events:none">${esc(s.name)}</text>`; }
  // full zoom: pools and imagery chips in view (property-level detail: editors / labellers)
  if (box[2] <= 2500) {
    const key = box.map((v) => Math.round(v / 250)).join(","), it = MAPV.items[key];
    if (it) { for (const p of it.pools) { const r = Math.max(Math.sqrt((+p.area || 20) / Math.PI), 2 * px);
        h += `<circle cx="${p.x}" cy="${-p.y}" r="${r}" fill="#1f78d1" fill-opacity=".8" stroke="#fff" stroke-width="${px}"><title>Detected pool, ≈ ${fmt(p.area)} m²</title></circle>`; }
      for (const c of it.chips) { const u = MAPV.urls[c.chip_path]; if (!u) continue; const w = 40;
        h += `<g><image href="${esc(u)}" x="${c.x - w / 2}" y="${-c.y - w / 2}" width="${w}" height="${w}" preserveAspectRatio="xMidYMid slice" opacity=".95"/><rect x="${c.x - w / 2}" y="${-c.y - w / 2}" width="${w}" height="${w}" fill="none" stroke="${c.task === "pool" ? "#1f78d1" : "#2e9e4f"}" stroke-width="${2 * px}"><title>${c.task === "pool" ? "Pool" : "Garden"} validation chip (placement approximate)${c.tool_verdict ? ": tool says " + esc(c.tool_verdict) : ""}</title></rect></g>`; }
      MAPV.note = it.pools.length + it.chips.length ? `${it.pools.length} detected pools and ${it.chips.length} imagery chips in view.` : can("labeller") ? "No detected pools or imagery chips in view." : "Pool locations and imagery chips are visible to labellers and editors.";
    } else { MAPV.note = "Loading pools and imagery in view…"; clearTimeout(MAPV.fetchT); MAPV.fetchT = setTimeout(() => fetchItems(svg, box, key), 300); }
  } else MAPV.note = "";
  g.innerHTML = h; const n = $("#mv-note"); if (n) n.textContent = MAPV.note;
}
async function fetchItems(svg, box, key) {
  const cx = box[0] + box[2] / 2, cy = -(box[1] + box[3] / 2);
  const hit = allSubs().find(({ s }) => { const b = mapBox([s.geom]); return cx >= b[0] && cx <= b[0] + b[2] && -cy >= b[1] && -cy <= b[1] + b[3]; }) || allSubs()[0];
  const x0 = Math.max(box[0], cx - 1500), x1 = Math.min(box[0] + box[2], cx + 1500), y0 = Math.max(-(box[1] + box[3]), cy - 1500), y1 = Math.min(-box[1], cy + 1500);
  try {
    const r = hit ? await q(sb.rpc("map_items", { p_region: hit.k, p_x0: x0, p_y0: y0, p_x1: x1, p_y1: y1 })) : { pools: [], chips: [] };
    const need = (r.chips || []).map((c) => c.chip_path).filter((p) => !MAPV.urls[p]);
    if (need.length) { const { data } = await sb.storage.from("chips").createSignedUrls(need, 3600); for (const d of data || []) if (d.signedUrl) MAPV.urls[d.path] = d.signedUrl; }
    MAPV.items[key] = { pools: r.pools || [], chips: r.chips || [] };
  } catch (e) { MAPV.items[key] = { pools: [], chips: [] }; MAPV.note = "Imagery detail unavailable: " + e.message; }
  if (BATCH.view && BATCH.view.id === "ovw") dynLayers(svg, BATCH.view.box);
}
// additive legend: one block per active layer, each with its sources
function legendHTML(br, f) {
  const el = $("#mv-legend"); if (!el) return;
  let h = "";
  if (f[3]) { const pal = f[5] ? DIV : RAMP;
    h += `<div style="margin-bottom:8px"><b>${esc(f[1])}</b>${["hh_size", "income", "owner", "separate", "bedrooms"].includes(f[0]) ? ` <span class="muted">(census ${esc(MAPV.year || "latest")})</span>` : ""}<br>
      ${br ? pal.map((c, i) => `<span style="display:inline-block;width:14px;height:10px;background:${c};border:1px solid var(--line)"></span> ${i === 0 ? "≤ " + fmt(br[0], f[2]) : i < 4 ? "≤ " + fmt(br[i], f[2]) : "> " + fmt(br[3], f[2])}`).join("<br>") + '<br><span style="display:inline-block;width:14px;height:10px;background:var(--land);border:1px solid var(--line)"></span> no data' : '<span class="muted">no data yet</span>'}
      <br><span class="muted">Source: ${f[4].map(srcLink).join("; ")}</span></div>`; }
  for (const [k, l, c, , unit, src] of OVERS) if (MAPV.over.has(k)) {
    h += `<div style="margin-bottom:8px"><span style="color:${c};font-size:16px">${k === "rainbar" ? "▮" : k === "labels" ? "A" : "●"}</span> <b>${esc(l)}</b>${unit ? ` <span class="muted">(symbol size ∝ ${unit})</span>` : ""}<br><span class="muted">Source: ${src.map(srcLink).join("; ")}</span></div>`; }
  h += `<div class="muted">At full zoom: <span style="color:#1f78d1">●</span> detected pools (true size), <span style="color:#1f78d1">▢</span> pool and <span style="color:#2e9e4f">▢</span> garden imagery chips. Source: ${srcLink("imagery")}.</div><div id="mv-note" class="muted" style="margin-top:4px">${esc(MAPV.note)}</div>`;
  el.innerHTML = h;
}
function suburbInfo(id) {
  const el = $("#mv-info"); if (!el) return;
  const hit = allSubs().find(({ s }) => String(s.linz_id) === String(id)); if (!hit) { el.innerHTML = ""; return; }
  const { s, g } = hit, c = cenOf(s), w = (D.water_rates || []).find((x) => x.PROVIDER === g.provider) || {};
  const row = (l, v, d, src) => `<tr><td class="l">${l}</td><td>${v == null || v === "" || (typeof v === "number" && !isFinite(v)) ? "–" : typeof v === "number" ? fmt(v, d) : esc(v)}</td><td class="l">${src ? `<a href="${SRC[src][1]}" target="_blank" rel="noopener" title="${esc(SRC[src][0])}">source</a>` : ""}</td></tr>`;
  el.innerHTML = `<h3 style="margin:0 0 4px">${esc(s.name)}</h3><span class="muted">${esc(g.label)} · ${esc(g.provider || "")}</span>
    <table style="margin-top:6px"><tbody>
    ${row("LINZ type", s.type, 0, "linz_suburbs")}${row("Sections", s.sections, 0, "linz_parcels")}${row("Titles per km²", s.density_per_km2, 0, "linz_titles")}${row("Median section m²", s.LotSize, 0, "linz_parcels")}
    ${row("Sections with a pool %", s.PercPool, 1, "imagery")}${row("Median garden m²", s.GardSize, 0, "imagery")}
    ${row("Household size", c.hh_size_mean, 2, "cen_fhh038")}${row("Median income $", c.income_median, 0, "cen_hou001")}${row("Owner-occupied %", c.pct_owner_all, 0, "cen_hou020")}${row("Separate houses %", c.pct_separate, 0, "cen_hou020")}
    ${row("Rain mm/yr", s.climate_annual && s.climate_annual.rain_mm, 0, "openmeteo")}${row("ET₀ mm/yr", s.climate_annual && s.climate_annual.et0_mm, 0, "openmeteo")}
    <tr><td class="l">Water charges</td><td class="l" style="white-space:normal">${w.PROVIDER ? `${esc(w.CHARGING_TYPE || "–")}${w.VOLUMETRIC_PA != null ? `, $${fmt(w.VOLUMETRIC_PA, 2)}/m³` : ""}` : "–"}</td><td class="l">${w.source ? `<a href="${esc(w.source)}" target="_blank" rel="noopener">source</a>` : ""}</td></tr>
    </tbody></table>${g.imagery_prefix ? `<p class="muted" style="margin:4px 0 0">Imagery: <a href="https://nz-imagery.s3-ap-southeast-2.amazonaws.com/${esc(g.imagery_prefix)}/rgbnir/collection.json" target="_blank" rel="noopener">${esc(g.capture_id || "capture")} (STAC)</a></p>` : ""}`;
}
// all sources used on this page
function sourcesHTML() {
  const caps = [...new Map(Object.values(D.regions || {}).filter((g) => g.imagery_prefix).map((g) => [g.capture_id, g])).values()];
  const rates = [...new Map(Object.values(D.regions || {}).map((g) => (D.water_rates || []).find((w) => w.PROVIDER === g.provider)).filter((w) => w && w.source).map((w) => [w.PROVIDER, w])).values()];
  return `<h2>Sources</h2><div class="card small"><ul style="margin:0;padding-left:18px">${Object.keys(SRC).map((k) => `<li>${srcLink(k)}</li>`).join("")}
    ${caps.map((g) => `<li>Imagery capture <a href="https://nz-imagery.s3-ap-southeast-2.amazonaws.com/${esc(g.imagery_prefix)}/rgbnir/collection.json" target="_blank" rel="noopener">${esc(g.capture_id)}</a> (STAC collection)</li>`).join("")}
    ${rates.map((w) => `<li>Water charges, ${esc(w.name)} (${esc(w.PROVIDER)}): <a href="${esc(w.source)}" target="_blank" rel="noopener">provider source</a>, checked ${esc(w.DATE_EST || "–")}</li>`).join("")}</ul>
    <p class="muted" style="margin:6px 0 0">LINZ and Stats NZ data are licensed for reuse under CC BY 4.0; Open-Meteo data under CC BY 4.0. See ATTRIBUTION.md in the repository.</p></div>`;
}
window.onZoomMap = (svg, box) => { if (svg.closest(".zmap").dataset.zmap !== "ovw") return; cancelAnimationFrame(MAPV.raf); MAPV.raf = requestAnimationFrame(() => dynLayers(svg, box)); };
document.addEventListener("change", (e) => {
  const t = e.target;
  if (t.id === "mv-fill") { MAPV.fill = t.value; store.set("map-fill", t.value); return drawDataMap(); }
  if (t.id === "mv-year") { MAPV.year = t.value; store.set("map-year", t.value); return drawDataMap(); }
  if (t.dataset && t.dataset.mvover) { t.checked ? MAPV.over.add(t.dataset.mvover) : MAPV.over.delete(t.dataset.mvover); store.set("map-over", JSON.stringify([...MAPV.over]));
    const f = FILLS.find((x) => x[0] === MAPV.fill) || FILLS[0]; legendHTML(f[3] ? breaks(allSubs().map(({ s }) => f[3](s))) : null, f);
    const svg = $("#mv-map svg"); if (svg && BATCH.view) dynLayers(svg, BATCH.view.box); }
});
document.addEventListener("click", (e) => {
  const p = e.target.closest && e.target.closest("[data-mvsub]"); if (!p || window._dragMoved) return;
  MAPV.sel = p.dataset.mvsub; setTimeout(() => suburbInfo(MAPV.sel), 0);   // region switch (data-reg) re-renders the page first
});
