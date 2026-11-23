// 1 Overview: a navigable data map. Two separate things are shown:
//  - suburb statistics, on several axes at once: a glyph per suburb (colour, a radar in the suburb's own shape, or a treemap
//    of the typical section's make-up), an optional size axis (non-contiguous cartogram) and a layout (geographic, or an
//    equal-area tile grid);
//  - where pools and green space actually are: dots aggregated to a grid at lower zoom (server-side, privacy floor) and
//    individual pools and gardens at full zoom.
// Kept light: statistics come from data loaded at sign-in, outlines from one cached request, presence per region and zoom
// step on demand. Sources are numbered references to the list below the map.
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
const jget = (k, d) => { try { return JSON.parse(store.get(k, JSON.stringify(d))); } catch (_) { return d; } };
const MAPV = { fill: store.get("map-fill", "hh_size"), year: store.get("map-year", ""), layout: store.get("map-layout", "geo"), glyph: store.get("map-glyph", "colour"),
  axes: jget("map-axes", ["hh_size", "income", "garden", "pool", "rain"]), sizeBy: store.get("map-size", "none"), pres: new Set(jget("map-pres", ["pools", "green"])),
  labels: store.get("map-labels", "1") === "1", info: null, dom: jget("map-dom", {}), stretch: store.get("map-stretch", "rank"), items: {}, urls: {}, presence: {}, sel: null, cent: {}, bb: {}, prof: {}, grid: null, raf: 0, fetchT: 0, presT: 0, note: "" };
const cenOf = (s) => { const c = s.census || {}; const y = MAPV.year && c[MAPV.year] ? MAPV.year : Object.keys(c).sort().pop(); return y ? c[y] : {}; };
// suburb statistics: [key, label, digits, value(s), sources, diverging]
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
const FILL_GROUP = (f) => !f[4] ? "" : f[4].some((k) => k.startsWith("cen_")) ? "Census" : f[4].includes("openmeteo") ? "Climate" : f[4].includes("imagery") ? "Imagery" : "Property (LINZ)";
const fillOf = (k) => FILLS.find((x) => x[0] === k) || FILLS[0];
const INFO = {
  hh_size: "Mean number of usual residents per household. Census household composition by size, for each Statistical Area 2 (SA2), apportioned to suburbs by their share of each SA2's residential sections.",
  income: "Median household income (total, all sources). SA2 medians from the census, combined per suburb weighted by residential sections; an approximation of the suburb median.",
  owner: "Share of households whose dwelling is owned or partly owned, or held in a family trust, rather than rented. Census tenure by SA2, apportioned to suburbs by sections.",
  separate: "Share of households living in a separate (stand-alone) house rather than a joined dwelling such as a unit, townhouse or apartment. Census dwelling type by SA2.",
  bedrooms: "Mean number of bedrooms per occupied dwelling. Census dwellings by SA2, apportioned to suburbs by sections.",
  density: "LINZ property titles per km² of suburb area. Counts units and cross-leases separately, so it tracks dwellings better than sections do.",
  lot: "Median area of a residential section (LINZ primary parcel) in the suburb, in m². Roads, reserves and untitled parcels are excluded.",
  garden: "Median green (vegetated) area per residential section, in m², detected from near-infrared aerial imagery, excluding building footprints.",
  pool: "Share of residential sections where a swimming pool was detected in the aerial imagery (validated against hand-labelled samples).",
  rain: "Mean annual rainfall for the suburb's climate grid cell (about 9 km), averaged over 2008–2025 (the years stored for that cell), from ERA5 reanalysis via Open-Meteo.",
  et0: "Mean annual reference evapotranspiration (FAO-56 Penman–Monteith): the water a well-watered grass surface would lose to the air. Same grid cell and years as rainfall.",
  deficit: "Annual rainfall minus reference evapotranspiration. Negative (red) means more water demand from the air than rain supplies, typically more garden watering; positive (blue) is a surplus.",
  "size:none": "Every suburb is drawn at its real size and shape.",
  "size:sections": "Each suburb shrinks about its own centre so that its area is proportional to its number of residential sections. Dense urban suburbs stay large; big, sparsely settled localities shrink. The suburb with the most sections per km² keeps its real size.",
  "size:titles": "As for sections, but proportional to the number of property titles, which also counts units and cross-leased flats: closer to the number of dwellings.",
  "size:pools": "Area proportional to the number of detected swimming pools, so the suburbs that contribute most pools stand out regardless of their land area.",
  "size:tiles": "In the tile layout the same choice sets each tile's area (equal tiles when 'Real area' is chosen).",
  "stretch:rank": "Rank: colour (or wedge length) shows a suburb's position among the suburbs shown, lowest to highest, evenly spread. Best for telling suburbs apart; the gaps between values are not shown.",
  "stretch:value": "Value: colour is proportional to the actual value across the full range, on a logarithmic scale when the values are right-skewed (all positive, a long tail of high values). Shows true differences, but one outlier can make the rest look alike.",
};
const infoBtn = (k) => `<sup><button type="button" data-mvinfo="${k}" aria-expanded="${MAPV.info === k}" aria-label="What does this mean?" title="What does this mean?" style="border:1px solid var(--line);background:${MAPV.info === k ? "var(--accent)" : "var(--panel)"};color:${MAPV.info === k ? "#fff" : "var(--accent)"};border-radius:50%;width:14px;height:14px;padding:0;font:italic 700 9px/12px serif;cursor:pointer;vertical-align:1px">i</button></sup>`;
const infoBox = (k) => MAPV.info === k && INFO[k] ? `<div class="small" style="margin:3px 0 6px;padding:5px 8px;border-left:3px solid var(--accent);background:var(--accent-soft);border-radius:0 6px 6px 0;white-space:normal">${esc(INFO[k])}</div>` : "";
const SIZES = [["none", "Real area"], ["sections", "Sections", (s) => s.sections, ["linz_parcels"]], ["titles", "Titles", (s) => s.titles, ["linz_titles"]], ["pools", "Pools", (s) => s.pools, ["imagery"]]];
const AXIS_COL = ["#1b9e77", "#d95f02", "#7570b3", "#e7298a", "#66a61e", "#e6ab02"];
const MAKEUP = [["Building", "#8d7b6f", (s) => +s.Footprint || 0], ["Garden", "#4daf4a", (s) => +s.GardSize || 0], ["Pool", "#2b83ba", (s) => (+s.PercPool || 0) / 100 * (+s.PoolArea || 0)],
  ["Other open / paved", "#d9d4c7", (s) => Math.max(0, (+s.LotSize || 0) - (+s.Footprint || 0) - (+s.GardSize || 0) - (+s.PercPool || 0) / 100 * (+s.PoolArea || 0))]];
const PRES = { pools: ["Pools", "#0b6fb8"], green: ["Green space", "#2f9a3e"] };
const RAMP = ["#c6dbef", "#9ecae1", "#6baed6", "#3182bd", "#08519c"], DIV = ["#b2182b", "#ef8a62", "#f7f7f7", "#67a9cf", "#2166ac"];
const niceStep = (m) => { const e = Math.pow(10, Math.floor(Math.log10(m))); for (const f of [1, 2, 5, 10]) if (f * e >= m) return f * e; return 10 * e; };
const finite = (v) => v != null && isFinite(v);

// the header's study filters the overview to its TAs' regions with data (none if it has none yet)
const studyOf_ = () => (typeof studyOf === "function" ? studyOf() : null);
const studyRegions = () => { const st = studyOf_(), all = Object.entries(D.regions || {}); return st ? all.filter(([, g]) => (st.ta_codes || []).includes(g.ta_code)) : all; };
const allSubs = () => studyRegions().flatMap(([k, g]) => g.suburbs.filter((s) => Array.isArray(s.geom) && s.geom.length).map((s) => ({ s, k, g })));
const bboxOf = (s) => MAPV.bb[s.linz_id] || (MAPV.bb[s.linz_id] = mapBox([s.geom]));
function centroid(s) {
  if (MAPV.cent[s.linz_id]) return MAPV.cent[s.linz_id];
  let best = null, ba = -1;
  for (const p of s.geom || []) { const r = p[0]; let a = 0, cx = 0, cy = 0;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const f = r[j][0] * r[i][1] - r[i][0] * r[j][1]; a += f; cx += (r[j][0] + r[i][0]) * f; cy += (r[j][1] + r[i][1]) * f; }
    if (Math.abs(a) > ba) { ba = Math.abs(a); best = a ? [cx / (3 * a), cy / (3 * a)] : r[0]; } }
  return (MAPV.cent[s.linz_id] = best || [0, 0]);
}
const areaOf = (s) => { let t = 0; for (const p of s.geom) p.forEach((r, k) => { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1]; t += (k ? -1 : 1) * Math.abs(a) / 2; }); return Math.max(t, 1); };

// continuous scales: the full data range by default, logarithmic when the values are right-skewed (all positive, skewness > 1),
// centred on zero for diverging statistics; MAPV.dom[key] = [a, b] narrows the range (fractions of it, set by scrolling over
// the legend spectrum)
function skewness(v) { const n = v.length; if (n < 3) return 0; const m = v.reduce((t, x) => t + x, 0) / n, sd = Math.sqrt(v.reduce((t, x) => t + (x - m) ** 2, 0) / n);
  return sd ? v.reduce((t, x) => t + ((x - m) / sd) ** 3, 0) / n : 0; }
function scaleFor(f) {
  if (!f || !f[3]) return null;
  const v = allSubs().map(({ s }) => f[3](s)).filter(finite); if (!v.length) return null;
  let lo = Math.min(...v), hi = Math.max(...v); const div = !!f[5];
  if (div) { const m = Math.max(Math.abs(lo), Math.abs(hi)) || 1; lo = -m; hi = m; }
  const [a, b] = MAPV.dom[f[0]] || [0, 1];
  if (!div && MAPV.stretch === "rank" && v.length > 1) {
    const sv = v.slice().sort((x, y) => x - y), n = sv.length;
    const rank = (x) => { let lo2 = 0, eq = 0; for (const y of sv) { if (y < x) lo2++; else if (y === x) eq++; } return (lo2 + Math.max(eq - 1, 0) / 2) / (n - 1); };
    const t = (x) => finite(x) ? Math.min(1, Math.max(0, (Math.min(1, rank(x)) - a) / ((b - a) || 1))) : null;
    const inv = (u) => { const w = (a + u * (b - a)) * (n - 1), i = Math.min(n - 2, Math.floor(w)); return sv[i] + (sv[i + 1] - sv[i]) * (w - i); };
    return { key: f[0], label: f[1], digits: f[2], src: f[4], t, inv, log: false, rank: true, div, lo, hi, a, b, zoomed: a > 0 || b < 1, n };
  }
  const log = !div && lo > 0 && skewness(v) > 1, g = log ? Math.log : (x) => x, G0 = g(lo), G1 = g(hi), span = G1 - G0;
  const t = (x) => { if (!finite(x) || (log && x <= 0)) return null; const w = span ? (g(x) - G0) / span : 1; return Math.min(1, Math.max(0, (w - a) / ((b - a) || 1))); };
  const inv = (u) => { const y = G0 + (a + u * (b - a)) * span; return log ? Math.exp(y) : y; };
  return { key: f[0], label: f[1], digits: f[2], src: f[4], t, inv, log, div, lo, hi, a, b, zoomed: a > 0 || b < 1, n: v.length };
}
const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
function interp(stops, t) { if (t == null) return null; const x = t * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(x)), f = x - i, A = hex(stops[i]), B = hex(stops[i + 1]);
  return "#" + A.map((v, k) => Math.round(v + (B[k] - v) * f).toString(16).padStart(2, "0")).join(""); }
const colourOf = (v, sc) => sc ? interp(sc.div ? DIV : RAMP, sc.t(v)) : null;
// radar wedges follow the same scale as the legend spectrum (log when skewed, narrowed range if set)
function normaliser(f) { const sc = scaleFor(f); return (x) => sc ? sc.t(x) : null; }
// a spectrum: name above, no printed values; hover shows the value under the cursor and the span, scroll narrows / widens
const specInfo = (sc) => [sc.rank ? "rank" : sc.log ? "log scale" : sc.div ? "centred on 0" : "linear", sc.zoomed ? "narrowed" : "", "hover for values"].filter(Boolean).join(" · ");
function spectrumHTML(sc, stops, label, src) {
  const k = sc ? sc.key : null;
  if (!sc) return `<div style="margin:6px 0"><b>${esc(label)}</b>${srcRef(src || [])} <span class="muted">no data yet</span></div>`;
  return `<div style="margin:6px 0"><div><b>${esc(label)}</b>${srcRef(src || [])}${INFO[k] ? infoBtn(k) : ""}</div>${infoBox(k)}
    <div data-spec="${sc.key}" role="img" aria-label="${esc(label)}: ${fmt(sc.inv(0), sc.digits)} to ${fmt(sc.inv(1), sc.digits)}" title="Hover for values; scroll to narrow or widen the range; double-click to reset"
      style="height:12px;margin-top:2px;border-radius:3px;border:1px solid var(--line);cursor:ew-resize;background:linear-gradient(90deg,${stops.join(",")})"></div>
    <div class="muted" data-specinfo="${sc.key}" style="height:1.35em;line-height:1.35em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:11.5px">${specInfo(sc)}</div></div>`;
}
const specScale = (key) => scaleFor(fillOf(key));
// size axis: shrink each suburb about its centre so its area is proportional to the chosen count (largest stays full size)
function sizeFactors() {
  const sz = SIZES.find((x) => x[0] === MAPV.sizeBy); if (!sz || !sz[2]) return null;
  const subs = allSubs(), raw = new Map(subs.map(({ s }) => [s.linz_id, Math.sqrt(Math.max(0, +sz[2](s) || 0) / (MAPV.layout === "tiles" ? 1 : areaOf(s)))]));
  const mx = Math.max(...raw.values()) || 1; return new Map([...raw].map(([k, v]) => [k, Math.max(0.12, v / mx)]));
}

// radial profile of a suburb from its centre (72 directions): the radar is drawn in the suburb's own shape
function profile(s) {
  if (MAPV.prof[s.linz_id]) return MAPV.prof[s.linz_id];
  const [cx, cy] = centroid(s), out = [];
  for (let k = 0; k < 72; k++) { const a = k * Math.PI / 36, dx = Math.cos(a), dy = Math.sin(a); let best = 0;
    for (const p of s.geom) for (const r of p) for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const ex = r[i][0] - r[j][0], ey = r[i][1] - r[j][1], den = dx * ey - dy * ex; if (Math.abs(den) < 1e-9) continue;
      const wx = r[j][0] - cx, wy = r[j][1] - cy, t = (wx * ey - wy * ex) / den, u = (wx * dy - wy * dx) / den;
      if (t > 0 && u >= 0 && u <= 1 && t > best) best = t; }
    out.push(best); }
  return (MAPV.prof[s.linz_id] = out);
}
const squareProfile = (half) => Array.from({ length: 72 }, (_, k) => { const a = k * Math.PI / 36; return half / Math.max(Math.abs(Math.cos(a)), Math.abs(Math.sin(a))); });
// one wedge per axis, its reach = (20% + 80% of the axis value) of the shape's own radius in that direction
function radarSVG(cx, cy, prof, vals, f, title) {
  const k = vals.length; if (!k) return "";
  let h = `<path d="${Array.from({ length: 72 }, (_, i) => { const a = i * Math.PI / 36; return (i ? "L" : "M") + (cx + Math.cos(a) * prof[i] * f) + "," + -(cy + Math.sin(a) * prof[i] * f); }).join("")}Z" fill="var(--panel)" fill-opacity=".55" stroke="var(--ink)" stroke-opacity=".35" stroke-width="1" vector-effect="non-scaling-stroke"><title>${esc(title)}</title></path>`;
  vals.forEach((v, i) => { if (v == null) return; const s = (0.2 + 0.8 * v) * f, a0 = 90 - i * 360 / k, a1 = 90 - (i + 1) * 360 / k, pts = [];
    for (let d = a0; d >= a1 - 0.01; d -= 5) { const idx = (((Math.round(d / 5)) % 72) + 72) % 72, a = d * Math.PI / 180; pts.push((cx + Math.cos(a) * prof[idx] * s) + "," + -(cy + Math.sin(a) * prof[idx] * s)); }
    h += `<path d="M${cx},${-cy}L${pts.join("L")}Z" fill="${AXIS_COL[i % AXIS_COL.length]}" fill-opacity=".85" stroke="#fff" stroke-width=".8" vector-effect="non-scaling-stroke" style="pointer-events:none"/>`; });
  return h;
}
// treemap of the typical section: building, garden, pool, other (slice and dice, largest first)
function treemapSVG(x, y, w, h, s, title) {
  const parts = MAKEUP.map(([l, c, f]) => [l, c, f(s)]).filter((p) => p[2] > 0).sort((a, b) => b[2] - a[2]);
  const tot = parts.reduce((t, p) => t + p[2], 0); if (!tot) return "";
  let out = `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#fff" stroke="var(--ink)" stroke-opacity=".5" stroke-width="1" vector-effect="non-scaling-stroke"><title>${esc(title)}</title></rect>`, rest = tot;
  for (const [l, c, v] of parts) { const horiz = w >= h, frac = v / rest;
    const rw = horiz ? w * frac : w, rh = horiz ? h : h * frac;
    out += `<rect x="${x}" y="${y}" width="${rw}" height="${rh}" fill="${c}" stroke="#fff" stroke-width=".8" vector-effect="non-scaling-stroke" style="pointer-events:none"/>`;
    if (horiz) { x += rw; w -= rw; } else { y += rh; h -= rh; } rest -= v; }
  return out;
}
// equal-area tile grid: one square per suburb, placed in the free cell nearest its real centre
function tileGrid() {
  const subs = allSubs(), key = subs.map(({ s }) => s.linz_id).join(","); if (MAPV.grid && MAPV.grid.key === key) return MAPV.grid;
  const L = Math.sqrt(subs.reduce((t, { s }) => t + areaOf(s), 0) / Math.max(1, subs.length)) * 0.8 || 1000, taken = new Set(), pos = new Map();
  const order = subs.slice().sort((a, b) => areaOf(b.s) - areaOf(a.s));
  for (const { s } of order) { const [cx, cy] = centroid(s), gx = Math.round(cx / L), gy = Math.round(cy / L); let done = false;
    for (let r = 0; r < 60 && !done; r++) for (let dx = -r; dx <= r && !done; dx++) for (let dy = -r; dy <= r && !done; dy++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; const k = (gx + dx) + "," + (gy + dy);
      if (!taken.has(k)) { taken.add(k); pos.set(s.linz_id, [(gx + dx) * L, (gy + dy) * L]); done = true; } } }
  return (MAPV.grid = { key, L, pos });
}

// ---------------------------------------------------------------- shell
function dataMapHTML() {
  return `<div class="card" id="datamap"><div class="grid" style="grid-template-columns:minmax(0,1fr) minmax(260px,330px);gap:12px;align-items:start">
      <div><div id="mv-map"><p class="muted small">Loading map…</p></div>
        <p class="small muted" style="margin:4px 0 0">Scroll to zoom, drag to pan, click a suburb for its figures. Dots show where pools and green space are (grouped at lower zoom); at full zoom, single pools and gardens and imagery chips appear. Superscript numbers refer to the sources below.</p>
        <div id="mv-info" class="small" style="margin-top:8px"></div></div>
      <div id="mv-legend" class="small" style="max-height:680px;overflow:auto"></div></div></div>`;
}
async function drawDataMap() {
  const host = $("#mv-map"); if (!host) return;
  try { if (!BATCH.tas) BATCH.tas = await q(sb.rpc("ta_outlines", { p_tol: 200 })); } catch (e) { BATCH.tas = BATCH.tas || []; }
  const subs = allSubs(), st = studyOf_(), inStudy = (t) => st && (st.ta_codes || []).includes(t.code);
  const base = (BATCH.tas || []).filter((t) => t.geom && t.geom.coordinates).map((t) => ({ d: pathD(t.geom.coordinates), fill: inStudy(t) ? "var(--accent-soft)" : "var(--land)", stroke: inStudy(t) ? "var(--accent)" : "var(--landline)", sw: inStudy(t) ? 1.4 : 0.6, title: t.name + (inStudy(t) ? " (in this study)" : "") }));
  // suburbs: clickable outlines (geographic layout); the glyphs are drawn on top, see glyphs()
  const outl = MAPV.layout === "geo" ? subs.map(({ s, k, g }) => ({ attr: `data-mvsub="${s.linz_id}" data-reg="${esc(k)}"`, click: true, d: pathD(s.geom), fill: "#ffffff", op: 0.35, sw: 0.6, title: `${s.name} (${g.label})` })) : [];
  const stTas = (BATCH.tas || []).filter(inStudy);
  const all = subs.length ? mapBox(subs.map(({ s }) => s.geom)) : stTas.length ? mapBox(stTas.map((t) => t.geom.coordinates)) : mapBox((BATCH.tas || []).map((t) => t.geom.coordinates));
  const nz = (BATCH.tas || []).length ? mapBox(BATCH.tas.map((t) => t.geom.coordinates)) : all;
  host.innerHTML = zoomMap("ovw", [...base, ...outl], nz).replace("</svg>", '<g id="mv-glyph"></g><g id="mv-pres" style="pointer-events:none"></g><g id="mv-lab" style="pointer-events:none"></g></svg>').replace('data-zoom="sel">Selection', 'data-zoom="sel">Data');
  const svg = host.querySelector("svg"), sk = st ? String(st.id) : "";
  if (svg) { if (!(BATCH.view && BATCH.view.id === "ovw") || MAPV.study !== sk) { MAPV.study = sk; setView(svg, all); } else dynLayers(svg, BATCH.view.box); }
  legendHTML();
}
const inView = (b, box, m = 0.15) => b[0] + b[2] > box[0] - box[2] * m && b[0] < box[0] + box[2] * (1 + m) && b[1] + b[3] > box[1] - box[3] * m && b[1] < box[1] + box[3] * (1 + m);
// suburb glyphs: colour / radar / section treemap, in the geographic or tile layout, with the size axis applied
function glyphs(box, px) {
  const subs = allSubs(), sf = sizeFactors(), tiles = MAPV.layout === "tiles", G = tiles ? tileGrid() : null;
  const f = fillOf(MAPV.fill), cl = MAPV.glyph === "colour" ? scaleFor(f) : null;
  const axes = MAPV.axes.map(fillOf).filter((x) => x[3]).slice(0, 6), norms = axes.map(normaliser);
  const maxLot = Math.max(1, ...subs.map(({ s }) => +s.LotSize || 0));
  let h = "";
  for (const { s, k, g } of subs) {
    const fac = sf ? sf.get(s.linz_id) : 1, val = f[3] ? f[3](s) : null;
    const tip = `${s.name} (${g.label})${MAPV.glyph === "colour" && f[3] ? `: ${finite(val) ? fmt(val, f[2]) : "no data"}` : ""}`;
    if (tiles) { const [tx, ty] = G.pos.get(s.linz_id) || centroid(s), half = G.L * 0.46 * Math.sqrt(fac), b = [tx - half, -(ty + half), 2 * half, 2 * half];
      if (!inView(b, box)) continue;
      const hit = `data-mvsub="${s.linz_id}" data-reg="${esc(k)}" style="cursor:pointer"`;
      if (MAPV.glyph === "radar") h += `<g ${hit}><rect x="${b[0]}" y="${b[1]}" width="${b[2]}" height="${b[3]}" fill="var(--panel)" stroke="var(--line)" stroke-width="1" vector-effect="non-scaling-stroke"><title>${esc(tip)}</title></rect>${radarSVG(tx, ty, squareProfile(half), axes.map((a, i) => norms[i](a[3](s))), 1, tip)}</g>`;
      else if (MAPV.glyph === "makeup") h += `<g ${hit}>${treemapSVG(b[0], b[1], b[2], b[3], s, `${s.name}: median section ${fmt(s.LotSize)} m²`) || `<rect x="${b[0]}" y="${b[1]}" width="${b[2]}" height="${b[3]}" fill="var(--land)"><title>${esc(s.name)}: no section data</title></rect>`}</g>`;
      else { const c = colourOf(val, cl); h += `<rect ${hit} x="${b[0]}" y="${b[1]}" width="${b[2]}" height="${b[3]}" fill="${c || "var(--land)"}" stroke="#fff" stroke-width="1.5" vector-effect="non-scaling-stroke"><title>${esc(tip)}</title></rect>`; }
      continue; }
    const b = bboxOf(s); if (!inView(b, box)) continue;
    const [cx, cy] = centroid(s), tf = fac < 1 ? ` transform="translate(${cx},${-cy}) scale(${fac}) translate(${-cx},${cy})"` : "";
    if (MAPV.glyph === "radar") h += radarSVG(cx, cy, profile(s), axes.map((a, i) => norms[i](a[3](s))), fac, tip).replace("<path ", '<path style="pointer-events:none" ');
    else if (MAPV.glyph === "makeup") { const side = (16 + 30 * Math.sqrt((+s.LotSize || 0) / maxLot)) * px * Math.sqrt(fac); h += treemapSVG(cx - side / 2, -cy - side / 2, side, side, s, `${s.name}: median section ${fmt(s.LotSize)} m²`).replace("<rect ", '<rect style="pointer-events:none" '); }
    else { const c = colourOf(val, cl); if (c || fac < 1) h += `<path d="${pathD(s.geom)}"${tf} fill="${c || "var(--land)"}" fill-opacity=".9" stroke="#fff" stroke-width="${fac < 1 ? 1.2 : 0.6}" vector-effect="non-scaling-stroke" style="pointer-events:none"/>`; }
  }
  return h;
}
// where pools and green space are: aggregated dots (grid step snapped to round distances), single items at full zoom
function presenceLayer(svg, box, px) {
  if (!MAPV.pres.size) return "";
  let h = "";
  if (box[2] <= 2500) {
    const it = MAPV.items[box.map((v) => Math.round(v / 250)).join(",")]; if (!it) return "";
    if (MAPV.pres.has("green")) for (const p of it.greens || []) { const r = Math.max(Math.sqrt((+p.veg || 0) / Math.PI), 1.2 * px);
      h += `<circle cx="${p.x}" cy="${-p.y}" r="${r}" fill="${PRES.green[1]}" fill-opacity=".45" stroke="${PRES.green[1]}" stroke-width="${0.6 * px}"><title>Garden ≈ ${fmt(p.veg)} m²</title></circle>`; }
    if (MAPV.pres.has("pools")) for (const p of it.pools || []) { const r = Math.max(Math.sqrt((+p.area || 20) / Math.PI), 3 * px);
      h += `<circle cx="${p.x}" cy="${-p.y}" r="${r}" fill="${PRES.pools[1]}" stroke="#fff" stroke-width="${1.2 * px}"><title>Detected pool ≈ ${fmt(p.area)} m²</title></circle>`; }
    return h;
  }
  const step = Math.max(100, niceStep(30 * px)), regs = studyRegions().filter(([, g]) => g.suburbs.some((s) => Array.isArray(s.geom) && inView(bboxOf(s), box, 0)));
  const cells = [];
  for (const [k] of regs) { const P = MAPV.presence[k + "|" + step];
    if (!P) { clearTimeout(MAPV.presT); MAPV.presT = setTimeout(() => fetchPresence(svg, regs.map((r) => r[0]), step), 150); continue; }
    for (const c of P) if (c.x > box[0] - step && c.x < box[0] + box[2] + step && -c.y > box[1] - step && -c.y < box[1] + box[3] + step) cells.push(c); }
  if (!cells.length) return "";
  const mg = Math.max(1, ...cells.map((c) => +c.green || 0)), mp = Math.max(1, ...cells.map((c) => +c.pools || 0)), R = step * 0.5;
  if (MAPV.pres.has("green")) for (const c of cells) if (+c.green > 0) h += `<circle cx="${c.x}" cy="${-c.y}" r="${Math.max(R * Math.sqrt(c.green / mg), 1.5 * px)}" fill="${PRES.green[1]}" fill-opacity=".5"><title>≈ ${fmt(c.green / 1e4, 2)} ha of garden across ${fmt(c.n)} sections</title></circle>`;
  if (MAPV.pres.has("pools")) for (const c of cells) if (+c.pools > 0) h += `<circle cx="${c.x}" cy="${-c.y}" r="${Math.max(R * 0.8 * Math.sqrt(c.pools / mp), 2.2 * px)}" fill="${PRES.pools[1]}" stroke="#fff" stroke-width="${1 * px}"><title>${fmt(c.pools)} pool${c.pools === 1 ? "" : "s"} (≈ ${fmt(c.pool_m2)} m²) across ${fmt(c.n)} sections</title></circle>`;
  MAPV.presStep = step;
  return h;
}
async function fetchPresence(svg, regs, step) {
  for (const k of regs) { const key = k + "|" + step; if (MAPV.presence[key]) continue;
    try { const r = await q(sb.rpc("map_presence", { p_region: k, p_step: step })); MAPV.presence[key] = (r && r.cells) || []; } catch (e) { MAPV.presence[key] = []; MAPV.note = "Presence unavailable: " + e.message; } }
  if (BATCH.view && BATCH.view.id === "ovw") dynLayers(svg, BATCH.view.box);
}
// layers that depend on the view: redrawn once a zoom or pan settles
function dynLayers(svg, box) {
  const gG = svg.querySelector("#mv-glyph"), gP = svg.querySelector("#mv-pres"), gL = svg.querySelector("#mv-lab"); if (!gG) return;
  const px = box[2] / Math.max(1, svg.getBoundingClientRect().width || 800);   // metres per screen pixel
  gG.innerHTML = glyphs(box, px);
  let chips = "";
  if (box[2] <= 2500) {   // full zoom: single pools and gardens, and imagery chips (property-level: editors / labellers)
    const key = box.map((v) => Math.round(v / 250)).join(","), it = MAPV.items[key];
    if (it) { for (const c of it.chips) { const u = MAPV.urls[c.chip_path]; if (!u) continue; const w = 40;
        chips += `<g><image href="${esc(u)}" x="${c.x - w / 2}" y="${-c.y - w / 2}" width="${w}" height="${w}" preserveAspectRatio="xMidYMid slice" opacity=".95"/><rect x="${c.x - w / 2}" y="${-c.y - w / 2}" width="${w}" height="${w}" fill="none" stroke="${c.task === "pool" ? PRES.pools[1] : PRES.green[1]}" stroke-width="${2 * px}"><title>${c.task === "pool" ? "Pool" : "Garden"} validation chip (placement approximate)${c.tool_verdict ? ": tool says " + esc(c.tool_verdict) : ""}</title></rect></g>`; }
      MAPV.note = (it.pools.length + (it.greens || []).length + it.chips.length) ? `In view: ${fmt(it.pools.length)} pools, ${fmt((it.greens || []).length)} gardens, ${fmt(it.chips.length)} imagery chips.` : can("editor") ? "No pools, gardens or imagery chips in view." : "Single pools and gardens are visible to editors; zoom out for grouped dots.";
    } else { MAPV.note = "Loading pools, gardens and imagery in view…"; clearTimeout(MAPV.fetchT); MAPV.fetchT = setTimeout(() => fetchItems(svg, box, key), 250); }
  } else MAPV.note = MAPV.pres.size ? `Dots grouped per ${fmt(Math.max(100, niceStep(30 * px)))} m cell.` : "";
  gP.innerHTML = chips + presenceLayer(svg, box, px);
  let lab = "";
  if (MAPV.labels && box[2] < 80000) { const G = MAPV.layout === "tiles" ? tileGrid() : null;
    for (const { s } of allSubs()) { const [x, y] = G ? G.pos.get(s.linz_id) || centroid(s) : centroid(s); if (x < box[0] || x > box[0] + box[2] || -y < box[1] || -y > box[1] + box[3]) continue;
      lab += `<text x="${x}" y="${-y + (G ? G.L * 0.46 + 12 * px : 16 * px)}" font-size="${11 * px}" text-anchor="middle" style="fill:var(--ink);paint-order:stroke;stroke:var(--panel);stroke-width:${3 * px}px">${esc(s.name)}</text>`; } }
  gL.innerHTML = lab;
  const n = $("#mv-note"); if (n) n.textContent = MAPV.note;
}
async function fetchItems(svg, box, key) {
  const cx = box[0] + box[2] / 2, cy = -(box[1] + box[3] / 2);
  const hit = allSubs().find(({ s }) => { const b = bboxOf(s); return cx >= b[0] && cx <= b[0] + b[2] && -cy >= b[1] && -cy <= b[1] + b[3]; }) || allSubs()[0];
  const x0 = Math.max(box[0], cx - 1500), x1 = Math.min(box[0] + box[2], cx + 1500), y0 = Math.max(-(box[1] + box[3]), cy - 1500), y1 = Math.min(-box[1], cy + 1500);
  try {
    const r = hit ? await q(sb.rpc("map_items", { p_region: hit.k, p_x0: x0, p_y0: y0, p_x1: x1, p_y1: y1 })) : {};
    const need = ((r && r.chips) || []).map((c) => c.chip_path).filter((p) => !MAPV.urls[p]);
    if (need.length) { const { data } = await sb.storage.from("chips").createSignedUrls(need, 3600); for (const d of data || []) if (d.signedUrl) MAPV.urls[d.path] = d.signedUrl; }
    MAPV.items[key] = { pools: (r && r.pools) || [], greens: (r && r.greens) || [], chips: (r && r.chips) || [] };
  } catch (e) { MAPV.items[key] = { pools: [], greens: [], chips: [] }; MAPV.note = "Imagery detail unavailable: " + e.message; }
  if (BATCH.view && BATCH.view.id === "ovw") dynLayers(svg, BATCH.view.box);
}

// ---------------------------------------------------------------- layer panel
const seg = (attr, cur, opts) => `<span class="row" style="gap:0;flex-wrap:nowrap">${opts.map(([k, l], i) => `<button type="button" class="btn" ${attr}="${k}" aria-pressed="${k === cur}" style="padding:2px 8px;border-radius:${i === 0 ? "6px 0 0 6px" : i === opts.length - 1 ? "0 6px 6px 0" : "0"};${k === cur ? "background:var(--accent);color:#fff;border-color:var(--accent)" : ""}">${l}</button>`).join("")}</span>`;
const hd = (t) => `<div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:.04em;margin:10px 0 3px">${t}</div>`;
function legendHTML() {
  const el = $("#mv-legend"); if (!el) return;
  const subs = allSubs(), years = [...new Set(subs.flatMap(({ s }) => Object.keys(s.census || {})))].sort();
  const groups = ["Census", "Property (LINZ)", "Imagery", "Climate"], f = fillOf(MAPV.fill);
  let h = `${hd("Layout")}${seg("data-mvlayout", MAPV.layout, [["geo", "Geographic"], ["tiles", "Equal-area tiles"]])}
    ${hd("Suburb glyph")}${seg("data-mvglyph", MAPV.glyph, [["colour", "Colour"], ["radar", "Radar"], ["makeup", "Section make-up"]])}
    ${MAPV.glyph !== "makeup" ? `${hd("Stretch")}${seg("data-mvstretch", MAPV.stretch, [["rank", "Rank"], ["value", "Value"]])}${infoBtn("stretch:" + MAPV.stretch)}${infoBox("stretch:" + MAPV.stretch)}` : ""}
    ${years.length ? `<div style="margin-top:6px"><label>Census year <select id="mv-year">${years.map((y) => `<option ${y === (MAPV.year || years[years.length - 1]) ? "selected" : ""}>${y}</option>`).join("")}</select></label></div>` : ""}`;
  if (MAPV.glyph === "colour") {
    h += f[3] ? spectrumHTML(scaleFor(f), f[5] ? DIV : RAMP, f[1] + (FILL_GROUP(f) === "Census" ? ` (census ${MAPV.year || years[years.length - 1] || "latest"})` : ""), f[4]) + (f[5] ? '<div class="muted">red = deficit, blue = surplus</div>' : "") : "";
    h += `<div style="margin-top:6px">${groups.map((gname) => { const items = FILLS.filter((x) => FILL_GROUP(x) === gname); if (!items.length) return "";
      return `<div class="muted" style="font-size:11px;margin:5px 0 1px">${gname}</div>${items.map((x) => { const on = x[0] === MAPV.fill;
        return `<button type="button" data-mvfill="${x[0]}" aria-pressed="${on}" style="display:block;width:100%;text-align:left;border:1px solid ${on ? "var(--accent)" : "transparent"};background:${on ? "var(--accent-soft)" : "transparent"};border-radius:6px;padding:1px 6px;cursor:pointer;font:inherit;color:inherit">${esc(x[1])}${srcRef(x[4])}</button>`; }).join("")}`; }).join("")}</div>`;
  } else if (MAPV.glyph === "radar") {
    const axes = MAPV.axes.map(fillOf).filter((x) => x[3]);
    h += `<p class="muted" style="margin:6px 0 2px">Each wedge is one statistic, reaching from the suburb's centre toward its edge: the further, the higher the value among the suburbs shown (up to 6).</p>
      ${FILLS.filter((x) => x[3]).map((x) => { const i = axes.findIndex((a) => a[0] === x[0]), on = i >= 0;
        return `<label style="display:block"><input type="checkbox" data-mvaxis="${x[0]}" ${on ? "checked" : ""} ${!on && axes.length >= 6 ? "disabled" : ""}> ${on ? `<i style="display:inline-block;width:10px;height:10px;background:${AXIS_COL[i]};vertical-align:-1px"></i> ` : ""}${esc(x[1])}</label>`; }).join("")}
      ${axes.map((x, i) => spectrumHTML(scaleFor(x), [interp(["#ffffff", AXIS_COL[i]], 0.3), AXIS_COL[i]], x[1], x[4])).join("")}`;
  } else {
    h += `<p class="muted" style="margin:6px 0 2px">A square per suburb, sized by its median section and divided into what that section is made of.${srcRef(["linz_parcels", "linz_buildings", "imagery"])}</p>
      <div style="display:flex;flex-wrap:wrap;gap:2px 10px">${MAKEUP.map(([l, c]) => `<span><i style="display:inline-block;width:12px;height:10px;background:${c};vertical-align:-1px"></i> ${l}</span>`).join("")}</div>`;
  }
  h += `${hd(MAPV.layout === "tiles" ? "Tile size" : "Scale suburbs by (cartogram)")}${MAPV.layout === "tiles" ? infoBtn("size:tiles") + infoBox("size:tiles") : ""}
    ${SIZES.map(([k, l, , src]) => `<label style="display:block"><input type="radio" name="mv-size" data-mvsize="${k}" ${k === MAPV.sizeBy ? "checked" : ""}> ${k === "none" ? (MAPV.layout === "tiles" ? "Equal tiles" : "Real area") : "Area ∝ " + l.toLowerCase()}${src ? srcRef(src) : ""}${infoBtn("size:" + k)}</label>${infoBox("size:" + k)}`).join("")}
    ${hd("Where they are")}${Object.entries(PRES).map(([k, [l, c]]) => `<label style="display:block"><input type="checkbox" data-mvpres="${k}" ${MAPV.pres.has(k) ? "checked" : ""}> <span style="color:${c};font-size:15px">●</span> ${l}${srcRef(["imagery", "linz_parcels"])} <span class="muted">${k === "pools" ? "dot ∝ number of pools" : "dot ∝ garden area"}</span></label>`).join("")}
    <label style="display:block;margin-top:4px"><input type="checkbox" id="mv-labels" ${MAPV.labels ? "checked" : ""}> Suburb names${srcRef("linz_suburbs")}</label>
    <div id="mv-note" class="muted" style="margin-top:6px">${esc(MAPV.note)}</div>`;
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
// redraw the glyphs and the panel after a setting changes (keeps the view; outlines only change with the layout)
function restyle(full) {
  legendHTML();
  if (full) return drawDataMap();
  const svg = $("#mv-map svg"); if (svg && BATCH.view && BATCH.view.id === "ovw") dynLayers(svg, BATCH.view.box);
}
function specAt(e) { const el = e.target.closest && e.target.closest("[data-spec]"); if (!el) return null; const sc = specScale(el.dataset.spec); if (!sc) return null;
  const r = el.getBoundingClientRect(); return { el, sc, u: Math.min(1, Math.max(0, (e.clientX - r.left) / (r.width || 1))) }; }
function showSpec(key, text) { for (const n of document.querySelectorAll(`[data-specinfo="${key}"]`)) n.textContent = text; }
const specText = (sc, u) => `${fmt(sc.inv(u), sc.digits)} · span ${fmt(sc.inv(0), sc.digits)}–${fmt(sc.inv(1), sc.digits)}${sc.rank ? " (rank)" : sc.log ? " (log)" : ""}`;
document.addEventListener("mousemove", (e) => { const h = specAt(e); if (h) showSpec(h.sc.key, specText(h.sc, h.u)); });
document.addEventListener("mouseout", (e) => { const el = e.target.closest && e.target.closest("[data-spec]"); if (el) { const sc = specScale(el.dataset.spec); if (sc) showSpec(sc.key, specInfo(sc)); } });
// scroll over a spectrum: narrow / widen its range about the cursor (starts at the full range)
function zoomSpec(key, u, deltaY) {
  const sc0 = specScale(key); if (!sc0) return null;
  const w = Math.min(1, Math.max(0.02, (sc0.b - sc0.a) * Math.exp(deltaY * 0.002))), at = sc0.a + u * (sc0.b - sc0.a);
  const na = Math.min(Math.max(0, at - u * w), 1 - w);
  if (w >= 0.999) delete MAPV.dom[key]; else MAPV.dom[key] = [na, na + w];
  store.set("map-dom", JSON.stringify(MAPV.dom)); return specScale(key);
}
document.addEventListener("wheel", (e) => { const h = specAt(e); if (!h) return; e.preventDefault();
  const sc = zoomSpec(h.sc.key, h.u, e.deltaY); if (sc) showSpec(sc.key, specText(sc, h.u));
  const svg = $("#mv-map svg"); if (svg && BATCH.view && BATCH.view.id === "ovw") dynLayers(svg, BATCH.view.box); }, { passive: false });
document.addEventListener("dblclick", (e) => { const el = e.target.closest && e.target.closest("[data-spec]"); if (!el) return; delete MAPV.dom[el.dataset.spec]; store.set("map-dom", JSON.stringify(MAPV.dom)); restyle(); });
window.onZoomMap = (svg, box) => { if (svg.closest(".zmap").dataset.zmap !== "ovw") return; clearTimeout(MAPV.raf); MAPV.raf = setTimeout(() => dynLayers(svg, BATCH.view ? BATCH.view.box : box), 90); };
document.addEventListener("change", (e) => {
  const t = e.target;
  if (t.id === "mv-year") { MAPV.year = t.value; store.set("map-year", t.value); restyle(); if (MAPV.sel) suburbInfo(MAPV.sel); return; }
  if (t.dataset && t.dataset.mvsize) { MAPV.sizeBy = t.dataset.mvsize; store.set("map-size", MAPV.sizeBy); return restyle(); }
  if (t.id === "mv-labels") { MAPV.labels = t.checked; store.set("map-labels", t.checked ? "1" : "0"); return restyle(); }
  if (t.dataset && t.dataset.mvpres) { t.checked ? MAPV.pres.add(t.dataset.mvpres) : MAPV.pres.delete(t.dataset.mvpres); store.set("map-pres", JSON.stringify([...MAPV.pres])); return restyle(); }
  if (t.dataset && t.dataset.mvaxis) { const k = t.dataset.mvaxis; MAPV.axes = t.checked ? [...MAPV.axes.filter((x) => x !== k), k].slice(0, 6) : MAPV.axes.filter((x) => x !== k); store.set("map-axes", JSON.stringify(MAPV.axes)); return restyle(); }
});
document.addEventListener("click", (e) => {
  const c = (q) => e.target.closest && e.target.closest(q);
  const fb = c("[data-mvfill]"); if (fb) { MAPV.fill = fb.dataset.mvfill; store.set("map-fill", MAPV.fill); return restyle(); }
  const lb = c("[data-mvlayout]"); if (lb) { MAPV.layout = lb.dataset.mvlayout; store.set("map-layout", MAPV.layout); return restyle(true); }
  const ib = c("[data-mvinfo]"); if (ib) { e.preventDefault(); MAPV.info = MAPV.info === ib.dataset.mvinfo ? null : ib.dataset.mvinfo; return legendHTML(); }
  const sbtn = c("[data-mvstretch]"); if (sbtn) { MAPV.stretch = sbtn.dataset.mvstretch; store.set("map-stretch", MAPV.stretch); return restyle(); }
  const gb = c("[data-mvglyph]"); if (gb) { MAPV.glyph = gb.dataset.mvglyph; store.set("map-glyph", MAPV.glyph); return restyle(); }
  const p = c("[data-mvsub]"); if (!p || window._dragMoved) return;
  MAPV.sel = p.dataset.mvsub; setTimeout(() => suburbInfo(MAPV.sel), 0);   // region switch (data-reg) re-renders the page first
});
