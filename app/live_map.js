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
const SRC_N = Object.fromEntries(Object.keys(SRC).map((k, i) => [k, i + 1]));
const srcRef = (keys) => `<sup class="muted">${[].concat(keys).filter((k) => SRC_N[k]).map((k) => `<a href="#src-${k}" title="${esc(SRC[k][0])}" style="text-decoration:none">${SRC_N[k]}</a>`).join(",")}</sup>`;
const srcLink = (k) => SRC[k] ? `<a href="${SRC[k][1]}" target="_blank" rel="noopener">${esc(SRC[k][0])}</a>` : "";
const MAPV = { fill: store.get("map-fill", "hh_size"), year: store.get("map-year", ""), over: new Set(JSON.parse(store.get("map-over", '["pools","green"]'))),
  items: {}, urls: {}, sel: null, cent: {}, bb: {}, raf: 0, fetchT: 0, note: "" };
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
// tile overlays (combine freely): [key, label, colour, value(s), digits, sources, ramp]; each active one is a stripe of every tile
const OVERS = [
  ["pools", "Sections with a pool (%)", "#2b8cbe", (s) => s.PercPool, 1, ["imagery", "linz_parcels"], ["#eff3ff", "#bdd7e7", "#6baed6", "#3182bd", "#08519c"]],
  ["green", "Median garden per section (m²)", "#31a354", (s) => s.GardSize, 0, ["imagery", "linz_parcels", "linz_buildings"], ["#edf8e9", "#bae4b3", "#74c476", "#31a354", "#006d2c"]],
  ["rainbar", "Annual rainfall (mm)", "#756bb1", (s) => s.climate_annual && s.climate_annual.rain_mm, 0, ["openmeteo"], ["#f2f0f7", "#cbc9e2", "#9e9ac8", "#756bb1", "#54278f"]],
  ["labels", "Suburb names", "var(--ink)", null, 0, ["linz_suburbs"]],
];
const TILE_PX = 22;   // tile size on screen
const niceStep = (m) => { const e = Math.pow(10, Math.floor(Math.log10(m))); for (const f of [1, 2, 5, 10]) if (f * e >= m) return f * e; return 10 * e; };
// point in a suburb (MultiPolygon rings, even-odd)
function inPoly(geom, x, y) {
  let ins = false;
  for (const poly of geom) for (const r of poly) for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) ins = !ins; }
  return ins;
}
const bboxOf = (s) => MAPV.bb[s.linz_id] || (MAPV.bb[s.linz_id] = mapBox([s.geom]));
const FILL_GROUP = (f) => !f[4] ? "" : f[4].some((k) => k.startsWith("cen_")) ? "Census" : f[4].includes("openmeteo") ? "Climate" : f[4].includes("imagery") ? "Imagery" : "Property (LINZ)";
const RAMP = ["#f1eef6", "#bdc9e1", "#74a9cf", "#2b8cbe", "#045a8d"], DIV = ["#b2182b", "#ef8a62", "#f7f7f7", "#67a9cf", "#2166ac"];
// the header's study filters the overview to its TAs' regions with data (none if it has none yet)
const studyOf_ = () => (typeof studyOf === "function" ? studyOf() : null);
const studyRegions = () => { const st = studyOf_(), all = Object.entries(D.regions || {}); return st ? all.filter(([, g]) => (st.ta_codes || []).includes(g.ta_code)) : all; };
const allSubs = () => studyRegions().flatMap(([k, g]) => g.suburbs.filter((s) => Array.isArray(s.geom) && s.geom.length).map((s) => ({ s, k, g })));
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
  return `<div class="card" id="datamap"><div class="grid" style="grid-template-columns:minmax(0,1fr) minmax(250px,320px);gap:12px;align-items:start">
      <div><div id="mv-map"><p class="muted small">Loading map…</p></div>
        <p class="small muted" style="margin:4px 0 0">Scroll to zoom, drag to pan. Tiles keep their size as you zoom; imagery of detected pools and validated pools/gardens loads only at full zoom (under ~2.5 km across). Click a suburb for its figures. Superscript numbers refer to the sources below.</p>
        <div id="mv-info" class="small" style="margin-top:8px"></div></div>
      <div id="mv-legend" class="small" style="max-height:640px;overflow:auto"></div></div></div>`;
}
async function drawDataMap() {
  const host = $("#mv-map"); if (!host) return;
  try { if (!BATCH.tas) BATCH.tas = await q(sb.rpc("ta_outlines", { p_tol: 200 })); } catch (e) { BATCH.tas = BATCH.tas || []; }
  const subs = allSubs(), f = FILLS.find((x) => x[0] === MAPV.fill) || FILLS[0];
  const br = f[3] ? breaks(subs.map(({ s }) => f[3](s))) : null;
  const st = studyOf_(), inStudy = (t) => st && (st.ta_codes || []).includes(t.code);
  const base = (BATCH.tas || []).filter((t) => t.geom && t.geom.coordinates).map((t) => ({ d: pathD(t.geom.coordinates), fill: inStudy(t) ? "var(--accent-soft)" : "var(--land)", stroke: inStudy(t) ? "var(--accent)" : "var(--landline)", sw: inStudy(t) ? 1.4 : 0.6, title: t.name + (inStudy(t) ? " (in this study)" : "") }));
  const fills = subs.map(({ s, k, g }) => { const v = f[3] ? f[3](s) : null, c = fillColour(v, br, f[5]);
    return { attr: `data-mvsub="${s.linz_id}" data-reg="${esc(k)}"`, click: true, d: pathD(s.geom), fill: c || (f[3] ? "var(--land)" : "#e8e4da"), op: c ? 0.85 : 0.9, sw: 0.5,
      title: `${s.name} (${g.label})${f[3] ? `: ${v == null || !isFinite(v) ? "no data" : fmt(v, f[2])}` : ""}` }; });
  const stTas = (BATCH.tas || []).filter(inStudy);
  const all = subs.length ? mapBox(subs.map(({ s }) => s.geom)) : stTas.length ? mapBox(stTas.map((t) => t.geom.coordinates)) : mapBox((BATCH.tas || []).map((t) => t.geom.coordinates));
  const nz = (BATCH.tas || []).length ? mapBox(BATCH.tas.map((t) => t.geom.coordinates)) : all;
  host.innerHTML = zoomMap("ovw", [...base, ...fills], nz).replace("</svg>", '<g id="mv-dyn"></g></svg>').replace('data-zoom="sel">Selection', 'data-zoom="sel">Data');
  const svg = host.querySelector("svg"), sk = st ? String(st.id) : "";
  if (svg) { if (!(BATCH.view && BATCH.view.id === "ovw") || MAPV.study !== sk) { MAPV.study = sk; setView(svg, all); } else dynLayers(svg, BATCH.view.box); }
  legendHTML(br, f);
}
// symbols that keep a constant screen size: redrawn whenever the view changes
function dynLayers(svg, box) {
  const g = svg.querySelector("#mv-dyn"); if (!g) return;
  const px = box[2] / Math.max(1, svg.getBoundingClientRect().width || 800);   // metres per screen pixel
  const subs = allSubs().filter(({ s }) => { const [x, y] = centroid(s); return x > box[0] - box[2] * 0.1 && x < box[0] + box[2] * 1.1 && -y > box[1] - box[3] * 0.1 && -y < box[1] + box[3] * 1.1; });
  let h = "";
  // geometric tiles: an embedded heatmap over the suburb fill. A grid of fixed screen size (snapped to round distances so it
  // stays put while panning); each tile takes the suburb under its centre and shows one stripe per active overlay, coloured on
  // that overlay's own ramp. Inset, so the chosen fill shows around the tiles. Replaced by imagery at full zoom.
  const act = OVERS.filter((o) => o[3] && MAPV.over.has(o[0]));
  if (act.length && box[2] > 2500) {
    const step = niceStep(TILE_PX * px), x0 = Math.floor(box[0] / step) * step, y0 = Math.floor(-(box[1] + box[3]) / step) * step;
    const brs = act.map((o) => breaks(allSubs().map(({ s }) => o[3](s))));
    const cand = subs.map((o) => ({ ...o, b: bboxOf(o.s) }));
    const ins = step * 0.12, w = (step - 2 * ins) / act.length;
    for (let x = x0; x < box[0] + box[2]; x += step) for (let y = y0; y < -box[1]; y += step) {
      const cx = x + step / 2, cy = y + step / 2;
      const hit = cand.find((o) => cx >= o.b[0] && cx <= o.b[0] + o.b[2] && -cy >= o.b[1] && -cy <= o.b[1] + o.b[3] && inPoly(o.s.geom, cx, cy)); if (!hit) continue;
      act.forEach((o, i) => { const v = o[3](hit.s), c = fillColour(v, brs[i], false);
        h += `<rect x="${x + ins + i * w}" y="${-(y + step - ins)}" width="${w}" height="${step - 2 * ins}" fill="${c || "none"}" stroke="${c ? "rgba(255,255,255,.7)" : "var(--line)"}" stroke-width="${0.6 * px}"><title>${esc(hit.s.name)}: ${esc(o[1])} ${v == null || !isFinite(v) ? "no data" : fmt(v, o[4])}</title></rect>`; });
    }
  }
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
  const years = [...new Set(allSubs().flatMap(({ s }) => Object.keys(s.census || {})))].sort();
  const sw = (pal, w = 9) => pal.map((c) => `<i style="display:inline-block;width:${w}px;height:9px;background:${c}"></i>`).join("");
  const groups = ["Census", "Property (LINZ)", "Imagery", "Climate"];
  // every fill layer as a compact clickable item, grouped by source; the active one expands into its class breaks
  let h = `<div class="row" style="justify-content:space-between;margin-bottom:4px"><b>Colour suburbs by</b>
      <span>${years.length ? `<label>Census year <select id="mv-year">${years.map((y) => `<option ${y === (MAPV.year || years[years.length - 1]) ? "selected" : ""}>${y}</option>`).join("")}</select></label>` : ""}
      <button class="btn" type="button" data-mvfill="none" style="padding:1px 8px" ${MAPV.fill === "none" ? 'aria-pressed="true"' : ""}>No fill</button></span></div>
    <div style="display:grid;grid-template-columns:1fr;gap:2px">${groups.map((gname) => {
      const items = FILLS.filter((x) => FILL_GROUP(x) === gname); if (!items.length) return "";
      return `<div><div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:.04em;margin:4px 0 2px">${gname}</div>${items.map((x) => { const on = x[0] === MAPV.fill;
        return `<button type="button" data-mvfill="${x[0]}" aria-pressed="${on}" style="display:flex;align-items:center;gap:6px;width:100%;text-align:left;border:1px solid ${on ? "var(--accent)" : "transparent"};background:${on ? "var(--accent-soft)" : "transparent"};border-radius:6px;padding:2px 6px;cursor:pointer;font:inherit;color:inherit">
          <span style="white-space:nowrap">${sw(x[5] ? DIV : RAMP, 6)}</span><span>${esc(x[1])}${srcRef(x[4])}</span></button>`; }).join("")}</div>`; }).join("")}</div>`;
  if (f[3]) { const pal = f[5] ? DIV : RAMP;
    h += `<div style="margin-top:8px;padding:6px 8px;border:1px solid var(--line);border-radius:6px"><b>${esc(f[1])}</b>${FILL_GROUP(f) === "Census" ? ` <span class="muted">(census ${esc(MAPV.year || years[years.length - 1] || "latest")})</span>` : ""}
      <div style="display:flex;flex-wrap:wrap;gap:2px 10px;margin:4px 0">${br ? pal.map((c, i) => `<span><i style="display:inline-block;width:14px;height:10px;background:${c};border:1px solid var(--line);vertical-align:-1px"></i> ${i < 4 ? "≤ " + fmt(br[i], f[2]) : "> " + fmt(br[3], f[2])}</span>`).join("")
        + '<span><i style="display:inline-block;width:14px;height:10px;background:var(--land);border:1px solid var(--line);vertical-align:-1px"></i> no data</span>' : '<span class="muted">no data yet</span>'}</div>
      </div>`; }
  // tile overlays: toggles, each with its ramp and breaks; a sample tile shows the stripe order
  const act = OVERS.filter((o) => o[3] && MAPV.over.has(o[0]));
  h += `<div style="margin-top:8px"><div class="row" style="justify-content:space-between"><b>Tiles (heatmap over the fill)</b>${act.length ? `<span class="muted">tile: ${act.map((o) => `<i style="display:inline-block;width:12px;height:14px;background:${o[6][3]};border:1px solid #fff;vertical-align:-3px"></i>`).join("")} = ${act.map((o) => esc(o[1].split(" (")[0])).join(" · ")}</span>` : ""}</div>
    <div style="display:grid;grid-template-columns:1fr;gap:2px;margin-top:2px">${OVERS.map((o) => { const [k, l, c, val, d, src, ramp] = o, on = MAPV.over.has(k);
      const br = on && val ? breaks(allSubs().map(({ s }) => val(s))) : null;
      return `<label style="display:block"><input type="checkbox" data-mvover="${k}" ${on ? "checked" : ""}> ${ramp ? ramp.map((x) => `<i style="display:inline-block;width:6px;height:9px;background:${x}"></i>`).join("") : '<b style="color:var(--ink)">A</b>'} ${esc(l)}${srcRef(src)}
        ${on ? `<br><span class="muted" style="margin-left:20px">${br ? ramp.map((x, i) => `<i style="display:inline-block;width:9px;height:9px;background:${x};vertical-align:-1px"></i> ${i < 4 ? "≤" + fmt(br[i], d) : ">" + fmt(br[3], d)}`).join(" ") : ""}</span>` : ""}</label>`; }).join("")}</div></div>
    <div class="muted" style="margin-top:6px">At full zoom: <span style="color:#1f78d1">●</span> detected pools (true size), <span style="color:#1f78d1">▢</span> pool and <span style="color:#2e9e4f">▢</span> garden imagery chips.${srcRef("imagery")}</div><div id="mv-note" class="muted" style="margin-top:2px">${esc(MAPV.note)}</div>`;
  el.innerHTML = h;
}
function suburbInfo(id) {
  const el = $("#mv-info"); if (!el) return;
  const hit = allSubs().find(({ s }) => String(s.linz_id) === String(id)); if (!hit) { el.innerHTML = ""; return; }
  const { s, g } = hit, c = cenOf(s), w = (D.water_rates || []).find((x) => x.PROVIDER === g.provider) || {};
  const row = (l, v, d, src) => `<tr><td class="l">${l}${src ? srcRef(src) : ""}</td><td>${v == null || v === "" || (typeof v === "number" && !isFinite(v)) ? "–" : typeof v === "number" ? fmt(v, d) : esc(v)}</td></tr>`;
  el.innerHTML = `<h3 style="margin:0 0 4px">${esc(s.name)}</h3><span class="muted">${esc(g.label)} · ${esc(g.provider || "")}</span>
    <table style="margin-top:6px"><tbody>
    ${row("LINZ type", s.type, 0, "linz_suburbs")}${row("Sections", s.sections, 0, "linz_parcels")}${row("Titles per km²", s.density_per_km2, 0, "linz_titles")}${row("Median section m²", s.LotSize, 0, "linz_parcels")}
    ${row("Sections with a pool %", s.PercPool, 1, "imagery")}${row("Median garden m²", s.GardSize, 0, "imagery")}
    ${row("Household size", c.hh_size_mean, 2, "cen_fhh038")}${row("Median income $", c.income_median, 0, "cen_hou001")}${row("Owner-occupied %", c.pct_owner_all, 0, "cen_hou020")}${row("Separate houses %", c.pct_separate, 0, "cen_hou020")}
    ${row("Rain mm/yr", s.climate_annual && s.climate_annual.rain_mm, 0, "openmeteo")}${row("ET₀ mm/yr", s.climate_annual && s.climate_annual.et0_mm, 0, "openmeteo")}
    <tr><td class="l">Water charges${w.source ? `<sup><a href="#src-rate-${esc(w.PROVIDER)}" style="text-decoration:none">R</a></sup>` : ""}</td><td class="l" style="white-space:normal">${w.PROVIDER ? `${esc(w.CHARGING_TYPE || "–")}${w.VOLUMETRIC_PA != null ? `, $${fmt(w.VOLUMETRIC_PA, 2)}/m³` : ""}` : "–"}</td></tr>
    </tbody></table>${g.imagery_prefix ? `<p class="muted" style="margin:4px 0 0">Imagery: <a href="https://nz-imagery.s3-ap-southeast-2.amazonaws.com/${esc(g.imagery_prefix)}/rgbnir/collection.json" target="_blank" rel="noopener">${esc(g.capture_id || "capture")} (STAC)</a></p>` : ""}`;
}
// all sources used on this page
function sourcesHTML() {
  const caps = [...new Map(studyRegions().map(([, g]) => g).filter((g) => g.imagery_prefix).map((g) => [g.capture_id, g])).values()];
  const rates = [...new Map(studyRegions().map(([, g]) => g).map((g) => (D.water_rates || []).find((w) => w.PROVIDER === g.provider)).filter((w) => w && w.source).map((w) => [w.PROVIDER, w])).values()];
  return `<h2>Sources</h2><div class="card small"><ol style="margin:0;padding-left:22px">${Object.keys(SRC).map((k) => `<li id="src-${k}" value="${SRC_N[k]}">${srcLink(k)}</li>`).join("")}
    ${caps.map((g) => `<li style="list-style:none">↳ Imagery capture <a href="https://nz-imagery.s3-ap-southeast-2.amazonaws.com/${esc(g.imagery_prefix)}/rgbnir/collection.json" target="_blank" rel="noopener">${esc(g.capture_id)}</a> (STAC collection)</li>`).join("")}
    ${rates.map((w) => `<li id="src-rate-${esc(w.PROVIDER)}" style="list-style:none">R · Water charges, ${esc(w.name)} (${esc(w.PROVIDER)}): <a href="${esc(w.source)}" target="_blank" rel="noopener">provider source</a>, checked ${esc(w.DATE_EST || "–")}</li>`).join("")}</ol>
    <p class="muted" style="margin:6px 0 0">LINZ and Stats NZ data are licensed for reuse under CC BY 4.0; Open-Meteo data under CC BY 4.0. See ATTRIBUTION.md in the repository.</p></div>`;
}
function recolour() {
  const f = FILLS.find((x) => x[0] === MAPV.fill) || FILLS[0], br = f[3] ? breaks(allSubs().map(({ s }) => f[3](s))) : null, svg = $("#mv-map svg");
  if (!svg || !svg.querySelectorAll) return drawDataMap();
  const by = new Map(allSubs().map((o) => [String(o.s.linz_id), o]));
  for (const p of svg.querySelectorAll("[data-mvsub]")) { const o = by.get(p.dataset.mvsub); if (!o) continue; const v = f[3] ? f[3](o.s) : null, c = fillColour(v, br, f[5]);
    p.setAttribute("fill", c || (f[3] ? "var(--land)" : "#e8e4da")); p.setAttribute("fill-opacity", c ? 0.85 : 0.9);
    const t = p.querySelector("title"); if (t) t.textContent = `${o.s.name} (${o.g.label})${f[3] ? `: ${v == null || !isFinite(v) ? "no data" : fmt(v, f[2])}` : ""}`; }
  legendHTML(br, f);
}
// symbols are redrawn once a zoom or pan settles (wheel events arrive in bursts)
window.onZoomMap = (svg, box) => { if (svg.closest(".zmap").dataset.zmap !== "ovw") return; clearTimeout(MAPV.raf); MAPV.raf = setTimeout(() => dynLayers(svg, BATCH.view ? BATCH.view.box : box), 90); };
document.addEventListener("change", (e) => {
  const t = e.target;

  if (t.id === "mv-year") { MAPV.year = t.value; store.set("map-year", t.value); recolour(); if (MAPV.sel) suburbInfo(MAPV.sel); return; }
  if (t.dataset && t.dataset.mvover) { t.checked ? MAPV.over.add(t.dataset.mvover) : MAPV.over.delete(t.dataset.mvover); store.set("map-over", JSON.stringify([...MAPV.over]));
    const f = FILLS.find((x) => x[0] === MAPV.fill) || FILLS[0]; legendHTML(f[3] ? breaks(allSubs().map(({ s }) => f[3](s))) : null, f);
    const svg = $("#mv-map svg"); if (svg && BATCH.view) dynLayers(svg, BATCH.view.box); }
});
document.addEventListener("click", (e) => {
  const fb = e.target.closest && e.target.closest("[data-mvfill]");
  if (fb) { MAPV.fill = fb.dataset.mvfill; store.set("map-fill", MAPV.fill); return recolour(); }
  const p = e.target.closest && e.target.closest("[data-mvsub]"); if (!p || window._dragMoved) return;
  MAPV.sel = p.dataset.mvsub; setTimeout(() => suburbInfo(MAPV.sel), 0);   // region switch (data-reg) re-renders the page first
});
