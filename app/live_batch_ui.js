// Batch preparation, replacing the old builder's Load and Allocate stages with four stages: 2 Configure (TAs, PRVDRs, scope
// lists, saved or builder configurations), 3 Allocate (list rows that match no LINZ suburb, and provider codes, as in
// suburb_lookup.html's Allocate tab), 4 Validate suburbs (scoped names checked against LINZ, located suburbs on the map),
// 5 Load (queue one job per region, progress, tile lists).
// Uploaded files are read in the browser only; configurations keep the resulting suburb names, never file contents.
"use strict";
// 2 Configure (sub-steps: 2.1 Inputs and TAs, 2.2 Allocate, 2.3 Validate suburbs) and 3 Load replace the old Load and Allocate
(() => { const st = document.createElement("style"); st.textContent = ".amap td,.amap th{white-space:normal;vertical-align:top}.amap td .tag{display:inline-block;margin:1px 2px 1px 0}.amap td input[type=text]{max-width:100%}"; (document.head || document.body).appendChild(st); })();
const BSTAGES = { configure: "Configure", load: "Load" };
{ const r0 = STAGES.find(([id]) => id === "region"); if (r0) r0[1] = "Overview"; }   // stage 1 is an overview of the data, not a region picker
const CFG_STEPS = [["select", "Inputs and TAs"], ["allocate", "Allocate"], ["vsuburbs", "Validate suburbs"]];
STAGES.splice(1, STAGES.filter(([id]) => id === "load" || id === "allocate").length, ...Object.entries(BSTAGES));
let bsub = store.get("batch-sub", "select");
if (["batch", "allocate", "vsuburbs"].includes(stage)) { if (stage !== "batch") bsub = stage; stage = "configure"; }
const isSub = (k) => stage === "configure" && bsub === k;
const BATCH = { rev: 0, tas: null, providers: [], sel: new Set(JSON.parse(store.get("batch-sel", "[]"))), prvdr: JSON.parse(store.get("batch-prvdr-v2", "{}")), cfgPrvdr: {},
  files: {}, keep: store.get("batch-keep", "any"), config: null, configs: [], valid: {}, vTA: null,
  batches: [], jobs: [], regions: [], view: null, savedScope: null, fileNames: {}, linz: {}, aTA: null, aPick: null, builder: null,
  matches: JSON.parse(store.get("batch-matches", "{}")), alloc: JSON.parse(store.get("batch-alloc", "{}")), picks: JSON.parse(store.get("batch-picks", "{}")), tl: JSON.parse(store.get("batch-tl", "{}")) };
const isB = () => Object.prototype.hasOwnProperty.call(BSTAGES, stage);
// match key: also ignores punctuation and treats "Mt"/"Mount" and "St"/"Saint" alike
const mkey = (s) => norm(s).replace(/['’`.()]/g, "").replace(/-/g, " ").replace(/\bmt\b/g, "mount").replace(/\bst\b/g, "saint").replace(/\bpt\b/g, "point").replace(/\s+/g, " ").trim();
const norm = (s) => String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
const saveSel = () => { BATCH.rev = (BATCH.rev || 0) + 1; MEMO.fresh = false; if (typeof autosave === "function") autosave(); store.set("batch-sel", JSON.stringify([...BATCH.sel])); store.set("batch-prvdr-v2", JSON.stringify(BATCH.prvdr));
  store.set("batch-matches", JSON.stringify(BATCH.matches)); store.set("batch-alloc", JSON.stringify(BATCH.alloc)); store.set("batch-picks", JSON.stringify(BATCH.picks)); store.set("batch-tl", JSON.stringify(BATCH.tl)); };
const taOf = (c) => (BATCH.tas || []).find((x) => x.code === c) || {};
// memoised derived data (scope, PRVDRs, allocation rows): recomputed only when the inputs change, so drawing a step or
// clicking the map doesn't re-scan every file row
const IDS = new WeakMap(); let IDN = 0;
const oid = (o) => o && typeof o === "object" ? (IDS.get(o) || (IDS.set(o, ++IDN), IDN)) : 0;
const MEMO = { sig: "", fresh: false, m: new Map() };
function stateSig() {
  const F = BATCH.files;
  return [BATCH.rev || 0, [...BATCH.sel].join(","), BATCH.keep, oid(F.map), oid(F.ref), oid(F.provider), (F.map || []).length, (F.ref || []).length, (F.provider || []).length,
    oid(BATCH.alloc), Object.keys(BATCH.alloc).length, oid(BATCH.matches), Object.keys(BATCH.matches).length, oid(BATCH.picks), JSON.stringify(BATCH.picks).length,
    oid(BATCH.savedScope), Object.keys(BATCH.linz).join(","), (BATCH.tas || []).length, BATCH.providers.length, oid(BATCH.prvdr), Object.keys(BATCH.prvdr).length, oid(BATCH.cfgPrvdr)].join("|");
}
function memo(key, fn) {
  const sg = stateSig(); if (sg !== MEMO.sig) { MEMO.sig = sg; MEMO.m.clear(); }
  if (!MEMO.m.has(key)) MEMO.m.set(key, fn()); return MEMO.m.get(key);
}

// ---------------------------------------------------------------- scope files (rules of suburb_lookup.html)
function readCSV(text) {
  const first = text.split(/\r?\n/, 1)[0] || "";
  const sep = (first.match(/\t/g) || []).length > (first.match(/,/g) || []).length ? "\t" : ",";
  const rows = []; let row = [], f = "", qq = false;
  for (let i = 0; i < text.length; i++) { const c = text[i];
    if (qq) { if (c === '"' && text[i + 1] === '"') { f += '"'; i++; } else if (c === '"') qq = false; else f += c; }
    else if (c === '"') qq = true; else if (c === sep) { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(f); rows.push(row); row = []; f = ""; } else f += c; }
  if (f || row.length) { row.push(f); rows.push(row); }
  const all = rows.filter((r) => r.some((x) => x.trim() !== ""));
  if (!all.length) return [];
  const h = all[0].map((x) => x.trim().toUpperCase().replace(/^﻿/, ""));
  const out = all.slice(1).map((r) => Object.fromEntries(h.map((k, i) => [k, (r[i] || "").trim()])));
  out.headers = all[0].map((x) => x.trim().replace(/^﻿/, "")); out.sep = sep; return out;
}
// PRVDR from a file: current code, legacy code (e.g. WDC_WHG), alias or provider name
function prvdrCode(v) {
  const u = norm(v); if (!u) return null;
  const p = BATCH.providers.find((x) => norm(x.prvdr) === u || norm(x.legacy_prvdr) === u || (x.aliases || []).some((a) => norm(a) === u) || norm(x.name) === u);
  return p ? p.prvdr : null;
}
// a code from your files: your own match (Allocate stage or an imported builder config) wins over the saved providers
const resolveCode = (v) => BATCH.matches[norm(v)] || prvdrCode(v);
// allocations: a list row that matches no LINZ suburb, assigned to one or more LINZ suburbs (keyed as in suburb_lookup.html)
const allocKey = (file, name, terr) => `${file}|${norm(name)}|${norm(terr)}`;
function allocFor(file, name, terr) {
  const A = BATCH.alloc; if (A[allocKey(file, name, terr)]) return A[allocKey(file, name, terr)];
  const all = Object.values(A);
  return all.find((a) => norm(a.name) === norm(name) && (!file || a.file === file) && (!terr || !a.territory || norm(a.territory) === norm(terr)))
    || all.find((a) => norm(a.name) === norm(name) && (!terr || !a.territory || norm(a.territory) === norm(terr)));
}
// TAs a row belongs to: by M_TERRITORY; by PRVDR only when the row has no territory
function rowTAs(territory, prvdr) {
  const t = norm(territory).replace(/ (district|city|territory)$/, "");
  if (t) return (BATCH.tas || []).filter((x) => { const n = norm(x.name).replace(/ (district|city|territory)$/, ""); return n === t || (t === "hutt" && n === "lower hutt"); }).map((x) => x.code);
  const p = resolveCode(prvdr);
  return p ? (BATCH.tas || []).filter((x) => (x.prvdrs || []).includes(p)).map((x) => x.code) : [];
}
// TAs of an nz_suburb_provider.csv row: its M_TERRITORY if given; else the territory of the same suburb (or spelling)
// in nz_suburb_map / nz_suburb_ref; else the TAs whose LINZ suburbs (loaded in 2.2 / 2.3) have that name; else by PRVDR
function provRowTAs(r) {
  if (r.M_TERRITORY) return rowTAs(r.M_TERRITORY, r.PRVDR);
  const names = new Set([r.M_SUBURB, ...String(r["OTHER SPELLINGS"] || r.OTHER_SPELLINGS || "").split(/[;,|/]/)].map(norm).filter(Boolean));
  const out = new Set();
  for (const x of BATCH.files.map || []) if ((names.has(norm(x.M_SUBURB)) || names.has(norm(x.NZ_SUBURB_REF))) && x.M_TERRITORY) rowTAs(x.M_TERRITORY).forEach((c) => out.add(c));
  for (const x of BATCH.files.ref || []) if (names.has(norm(x.M_SUBURB)) && x.M_TERRITORY) rowTAs(x.M_TERRITORY).forEach((c) => out.add(c));
  if (!out.size) for (const [c, L] of Object.entries(BATCH.linz)) if (L.list.some((y) => names.has(norm(y.name)) || names.has(norm(y.name_ascii)))) out.add(c);
  return out.size ? [...out] : rowTAs("", r.PRVDR);
}
// per selected TA: { lists, rows, keep, basis }. Rows for TAs that are not selected are ignored (files never change the selection).
function scopeByTA() {
  const out = {}, sel = BATCH.sel;
  const add = (code, list, name, row) => { if (!sel.has(code)) return; const o = out[code] = out[code] || { lists: {}, rows: [] }; (o.lists[list] = o.lists[list] || new Set()).add(name); if (row) o.rows.push(row); };
  for (const r of BATCH.files.map || []) { const name = r.NZ_SUBURB_REF || r.M_SUBURB; if (!name) continue;
    for (const c of rowTAs(r.M_TERRITORY, r.PROVIDER)) add(c, "map", name, { m_suburb: r.M_SUBURB || name, linz_ref: name, territory: r.M_TERRITORY, prvdr: resolveCode(r.PROVIDER), file: "nz_suburb_map.csv" }); }
  for (const r of BATCH.files.ref || []) { if (!r.M_SUBURB) continue;
    for (const c of rowTAs(r.M_TERRITORY, r.PRVDR || r.PROVIDER)) add(c, "ref", r.M_SUBURB, { m_suburb: r.M_SUBURB, linz_ref: r.M_SUBURB, territory: r.M_TERRITORY, file: "nz_suburb_ref.csv" }); }
  for (const r of BATCH.files.provider || []) { if (!r.M_SUBURB) continue;
    const other = (r["OTHER SPELLINGS"] || r.OTHER_SPELLINGS || "").split(/[;,|/]/).map((x) => x.trim()).filter(Boolean);
    for (const c of provRowTAs(r)) add(c, "provider", r.M_SUBURB, { m_suburb: r.M_SUBURB, linz_ref: r.M_SUBURB, territory: r.M_TERRITORY, prvdr: resolveCode(r.PRVDR), code: r.PRVDR, spellings: other, file: "nz_suburb_provider.csv", src: r }); }
  for (const [c, o] of Object.entries(out)) {
    if (!o.lists.provider) continue;
    // study scope = the provider file; each study suburb's LINZ suburb(s) come from its nz_suburb_map.csv allocations
    const rows = [];
    for (const pr of o.rows.filter((r) => r.file === "nz_suburb_provider.csv")) {
      const names = new Set([pr.m_suburb, ...pr.spellings].map(norm));
      const maps = (BATCH.files.map || []).filter((m) => names.has(norm(m.M_SUBURB)) && (m.NZ_SUBURB_REF || m.M_SUBURB) && (!m.M_TERRITORY || rowTAs(m.M_TERRITORY).includes(c)));
      if (maps.length) for (const m of maps) rows.push({ ...pr, linz_ref: m.NZ_SUBURB_REF || m.M_SUBURB, via: "nz_suburb_map.csv" });
      else rows.push(pr); }
    o.rows = rows; o.keep = [...new Map(rows.map((r) => [norm(r.linz_ref), r.linz_ref])).values()];
    o.studies = new Set(rows.map((r) => norm(r.m_suburb))).size;
    o.basis = "nz_suburb_provider.csv" + (rows.some((r) => r.via) ? " + nz_suburb_map.csv allocations" : "");
  }
  // without a provider file: nz_suburb_map and nz_suburb_ref are keep-lists (either / both), as in the builder
  for (const o of Object.values(out)) {
    if (o.lists.provider) continue;
    const keepLists = ["map", "ref"].filter((k) => o.lists[k]); const use = keepLists;
    const sets = use.map((k) => new Set([...o.lists[k]].map(norm)));
    let keep = use.flatMap((k) => [...o.lists[k]]).filter((n) => BATCH.keep === "any" || sets.every((st) => st.has(norm(n))));
    o.keep = [...new Map(keep.map((n) => [norm(n), n])).values()]; o.basis = use.join(" + ");
  }
  // a loaded configuration's saved names apply where no file covers a selected TA
  if (BATCH.savedScope) for (const [c, names] of Object.entries(BATCH.savedScope)) if (sel.has(c) && !out[c] && names && names.length) out[c] = { lists: {}, rows: [], keep: names.slice(), basis: "saved configuration" };
  return out;
}
function tasInFiles() {
  const s = new Set();
  for (const r of BATCH.files.map || []) rowTAs(r.M_TERRITORY, r.PROVIDER).forEach((c) => s.add(c));
  for (const r of BATCH.files.ref || []) rowTAs(r.M_TERRITORY, r.PRVDR || r.PROVIDER).forEach((c) => s.add(c));
  for (const r of BATCH.files.provider || []) provRowTAs(r).forEach((c) => s.add(c));
  for (const a of Object.values(BATCH.alloc)) for (const t of [a.territory, ...(a.linzSuburbs || []).map((x) => x.territory)]) if (t) rowTAs(t).forEach((c) => s.add(c));
  return [...s].sort();
}
// PRVDR per TA, resolved as the old builder does: chosen by hand > nz_suburb_provider.csv PRVDR > nz_suburb_map.csv PROVIDER
// (most common code among the TA's rows, through your matches) > the saved provider serving the TA. Always editable.
// returns { code: saved PRVDR, src, acronyms: your file's codes for that provider, unresolved: codes matching no provider }
function filePrvdr(c) {
  for (const [k, col, f, tas] of [["provider", "PRVDR", "nz_suburb_provider.csv", provRowTAs], ["map", "PROVIDER", "nz_suburb_map.csv", (r) => rowTAs(r.M_TERRITORY, r.PROVIDER)]]) {
    const n = {}, acr = {}, bad = new Set();
    for (const r of BATCH.files[k] || []) { const v = String(r[col] || "").trim(); if (!v || !tas(r).includes(c)) continue;
      const p = resolveCode(v); if (!p) { bad.add(v); continue; } n[p] = (n[p] || 0) + 1; (acr[p] = acr[p] || new Set()).add(v); }
    const best = Object.entries(n).sort((a, b) => b[1] - a[1])[0];
    if (best || bad.size) return { code: best ? best[0] : null, src: `from ${f}`, acronyms: best ? [...acr[best[0]]] : [], unresolved: [...bad] };
  }
  return null;
}
// precedence: chosen by hand > your lists > a loaded saved configuration > the TA's saved provider
const prvdrFor = (c) => BATCH.prvdr[c] || (filePrvdr(c) || {}).code || BATCH.cfgPrvdr[c] || (taOf(c).prvdrs || [])[0] || "";
function prvdrSource(c) {
  if (BATCH.prvdr[c]) return "chosen by you";
  const f = filePrvdr(c);
  if (f && f.code) return f.src;
  return BATCH.cfgPrvdr[c] ? "saved configuration" : "TA default";
}
const rateFor = (p) => (D.water_rates || []).find((w) => w.PROVIDER === p);

// ---------------------------------------------------------------- timelines per TA / provider: weather period and census years
const CENSUS_YEARS = ["2013", "2018", "2023"], CLIMATE_FROM = "2013-01-01";
const latestDay = () => new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10);   // the archive lags ~2 days
// each TA (and each region already in the database, key "r:<region id>") has its own timeline; "_all" is only a template
// that "apply to all" copies to every selected TA
const tlOf = (c) => c.startsWith("r:") ? (((D.index || []).find((r) => r.id === c.slice(2)) || (D.regions || {})[c.slice(2)] || {}).timeline || {}) : BATCH.tl[c] || {};
const tlDays = (c) => { const t = tlOf(c), a = new Date(t.climate_start || CLIMATE_FROM), b = new Date(t.climate_end && t.climate_end < latestDay() ? t.climate_end : latestDay()); return Math.max(0, (b - a) / 864e5 + 1); };
// dates typed or pasted: 2012-01-01 (also 2012/01/01, 2012.1.1, or NZ-style 1/1/2012); "" = default
function parseDay(v) {
  const x = String(v || "").trim(); if (!x) return "";
  let m = x.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/), y, mo, d;
  if (m) [y, mo, d] = [+m[1], +m[2], +m[3]]; else if ((m = x.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/))) [d, mo, y] = [+m[1], +m[2], +m[3]]; else return null;
  const dt = new Date(Date.UTC(y, mo - 1, d)); if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  const iso = dt.toISOString().slice(0, 10); return iso < "1940-01-01" || iso > latestDay() ? null : iso;
}
// compact inline editor: two pasteable date fields and census-year pills
function tlEditor(c) {
  const t = tlOf(c), yrs = t.census_years || CENSUS_YEARS, lab = c.startsWith("r:") ? "" : c === "_all" ? "all TAs" : taOf(c).name;
  const pill = (y) => `<button type="button" class="btn" data-tlyb="${c}" data-y="${y}" aria-pressed="${yrs.includes(y)}" title="Census ${y}" style="padding:0 6px;font-size:11px;${yrs.includes(y) ? "background:var(--accent);color:#fff;border-color:var(--accent)" : ""}">’${y.slice(2)}</button>`;
  const date = (k, ph) => `<input type="text" inputmode="numeric" autocomplete="off" spellcheck="false" data-tl="${c}" data-tlk="${k}" value="${esc(t[k] || "")}" placeholder="${ph}" size="10" aria-label="Weather ${k === "climate_start" ? "from" : "to"}${lab ? " for " + esc(lab) : ""} (yyyy-mm-dd)" title="yyyy-mm-dd (paste e.g. 2012-01-01)${k === "climate_end" ? "; blank = latest" : ""}" style="width:7.2em;font-variant-numeric:tabular-nums">`;
  return `<span class="row small" style="gap:4px;flex-wrap:nowrap;align-items:center;white-space:nowrap">${date("climate_start", CLIMATE_FROM)}<span class="muted">→</span>${date("climate_end", "latest")}<span style="margin-left:4px">${CENSUS_YEARS.map(pill).join("")}</span></span>`;
}
const timelineCell = (c) => tlEditor(c);
const tlClean = (t) => { const o = {}; if (t.climate_start && t.climate_start !== CLIMATE_FROM) o.climate_start = t.climate_start; if (t.climate_end) o.climate_end = t.climate_end;
  if (t.census_years && t.census_years.length < CENSUS_YEARS.length) o.census_years = t.census_years.map(Number); return o; };
const tlFor = (c) => tlClean(tlOf(c));
// store a timeline: a TA's in this browser (and its configuration); a region's straight to the database
async function setTl(c, o) {
  if (!c.startsWith("r:")) { BATCH.tl[c] = o; saveSel(); return drawBatch(); }
  const id = c.slice(2), g = (D.index || []).find((r) => r.id === id) || (D.regions || {})[id]; if (!g) return;
  const clean = tlClean(o), prev = g.timeline; g.timeline = clean;
  try { await q(sb.from("regions").update({ timeline: clean }).eq("id", id)); if ((D.regions || {})[id]) D.regions[id].timeline = clean; toastMsg(`Timeline saved for ${g.label || g.name}: the next climate/census job uses it`); }
  catch (err) { g.timeline = prev; toastMsg("Not saved: " + err.message); }
  const el = $("#rj-tl"); if (el) el.innerHTML = tlEditor(c);
}
// older configurations had a shared default: give each selected TA without its own a copy
function migrateTl() { const d = BATCH.tl._default; if (!d) return; for (const c of BATCH.sel) if (!BATCH.tl[c]) BATCH.tl[c] = { ...d }; delete BATCH.tl._default; }
migrateTl();

{ const w = (name, f, key) => f;
  const _scope = scopeByTA; scopeByTA = () => memo("scopeByTA", _scope);
  const _rowTAs = rowTAs; rowTAs = (t, p) => memo("rowTAs|" + norm(t) + "|" + norm(p), () => _rowTAs(t, p));
  const _prov = provRowTAs; provRowTAs = (r) => memo("prov|" + oid(r), () => _prov(r));
  const _fp = filePrvdr; filePrvdr = (c) => memo("filePrvdr|" + c, () => _fp(c));
  const _tif = tasInFiles; tasInFiles = () => memo("tasInFiles", _tif); }

// ---------------------------------------------------------------- data
async function loadBatchData() {
  if (!BATCH.tas) BATCH.tas = await q(sb.rpc("ta_outlines", { p_tol: 200 }));
  if (!BATCH.providers.length) BATCH.providers = await q(sb.from("providers").select("prvdr,legacy_prvdr,name,aliases,territories").order("prvdr"));
  if (can("editor")) {
    BATCH.configs = await q(sb.from("batch_configs").select("id,name,ta_codes,keep_mode,prvdr_by_ta,prvdr_manual,scope_by_ta,prvdr_matches,allocations,suburb_picks,timelines,updated_at").order("updated_at", { ascending: false }));
    BATCH.batches = await q(sb.from("batches").select("id,name,ta_codes,keep_mode,status,created_at").order("id", { ascending: false }).limit(10));
    BATCH.regions = await q(sb.from("regions").select("id,name,ta_code,status,scope,batch_id,prvdr"));
    const ids = BATCH.regions.filter((r) => r.batch_id).map((r) => r.id);
    BATCH.jobs = ids.length ? await q(sb.from("jobs").select("id,region_id,status,reason,batch_id,created_at").in("region_id", ids).order("id", { ascending: false })) : [];
  }
}

// ---------------------------------------------------------------- zoomable map (wheel, drag, buttons)
function mapBox(geoms) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const g of geoms) for (const p of g) for (const r of p) for (const [x, y] of r) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const pad = Math.max(x1 - x0, y1 - y0) * 0.03; return [x0 - pad, -(y1 + pad), x1 - x0 + 2 * pad, y1 - y0 + 2 * pad];
}
const PATHS = new WeakMap();
const pathD = (g) => { if (g && typeof g === "object" && PATHS.has(g)) return PATHS.get(g); const d = g.map((p) => p.map((r) => r.map(([x, y], i) => (i ? "L" : "M") + Math.round(x) + "," + Math.round(-y)).join("") + "Z").join("")).join(""); if (g && typeof g === "object") PATHS.set(g, d); return d; };
function zoomMap(id, layers, full) {
  const v = (BATCH.view && BATCH.view.id === id) ? BATCH.view.box : full;
  return `<div class="zmap" data-zmap="${id}" style="position:relative">
    <div class="row" style="position:absolute;right:6px;top:6px;gap:4px;z-index:2"><button class="btn" type="button" data-zoom="in" aria-label="Zoom in">+</button><button class="btn" type="button" data-zoom="out" aria-label="Zoom out">−</button>
    <button class="btn" type="button" data-zoom="sel">Selection</button><button class="btn" type="button" data-zoom="reset">Reset</button></div>
    <svg viewBox="${v.join(" ")}" data-full="${full.join(" ")}" style="width:100%;height:${id === "ovw" ? 560 : 440}px;display:block;touch-action:none;user-select:none;-webkit-user-select:none;cursor:grab;background:var(--bg);border-radius:8px" role="img" aria-label="Map: scroll to zoom, drag to pan">
    ${layers.map((l) => `<path ${l.attr || ""} d="${l.d}" fill="${l.fill}" fill-opacity="${l.op ?? 1}" stroke="${l.stroke || "var(--landline)"}" stroke-width="${l.sw || 0.8}" vector-effect="non-scaling-stroke" ${l.click ? 'style="cursor:pointer"' : ""}><title>${esc(l.title || "")}</title></path>`).join("")}</svg></div>`;
}
// Pan and zoom. Dragging only moves the viewBox (cheap); layers that depend on the zoom are redrawn once the drag ends.
// The drag uses the same metres-per-pixel on both axes as the drawn map (it is letterboxed to keep its shape), the wheel
// zooms by how far you scroll, about the point under the cursor, and a release anywhere (or leaving the window) ends a drag.
let DRAG = null;
const vbOf = (svg) => svg.getAttribute("viewBox").split(" ").map(Number);
function svgPoint(svg, cx, cy) {
  const m = svg.getScreenCTM && svg.getScreenCTM();
  if (m && svg.createSVGPoint) { const p = svg.createSVGPoint(); p.x = cx; p.y = cy; const q = p.matrixTransform(m.inverse()); return [q.x, q.y]; }
  const r = svg.getBoundingClientRect(), b = vbOf(svg), k = Math.max(b[2] / r.width, b[3] / r.height);
  return [b[0] + b[2] / 2 + (cx - r.left - r.width / 2) * k, b[1] + b[3] / 2 + (cy - r.top - r.height / 2) * k];
}
document.addEventListener("wheel", (e) => {
  const svg = e.target.closest && e.target.closest(".zmap svg"); if (!svg) return; e.preventDefault();
  const b = vbOf(svg), [px, py] = svgPoint(svg, e.clientX, e.clientY);
  const d = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
  const k = Math.min(4, Math.max(0.25, Math.exp(d * 0.002)));
  setView(svg, [px - (px - b[0]) * k, py - (py - b[1]) * k, b[2] * k, b[3] * k]);
}, { passive: false });
document.addEventListener("pointerdown", (e) => {
  const svg = e.target.closest && e.target.closest(".zmap svg"); if (!svg || e.button !== 0) return;
  const r = svg.getBoundingClientRect(), b = vbOf(svg);
  DRAG = { svg, x: e.clientX, y: e.clientY, b, k: Math.max(b[2] / r.width, b[3] / r.height), moved: false, id: e.pointerId };
  e.preventDefault();   // no text selection or native image drag while panning
});
document.addEventListener("pointermove", (e) => {
  if (!DRAG) return;
  if (e.buttons === 0) return endDrag();   // released outside the window
  const dx = e.clientX - DRAG.x, dy = e.clientY - DRAG.y;
  if (!DRAG.moved && Math.abs(dx) + Math.abs(dy) > 3) { DRAG.moved = true; DRAG.svg.style.cursor = "grabbing";
    try { DRAG.svg.setPointerCapture(DRAG.id); } catch (_) { /* not supported */ } }   // capture only once it is a drag, so plain clicks keep their targets
  if (!DRAG.moved) return;
  const b = DRAG.b; DRAG.box = [b[0] - dx * DRAG.k, b[1] - dy * DRAG.k, b[2], b[3]];
  if (!DRAG.raf) DRAG.raf = requestAnimationFrame(() => { if (DRAG && DRAG.box) DRAG.svg.setAttribute("viewBox", DRAG.box.join(" ")); if (DRAG) DRAG.raf = 0; });
});
function endDrag() {
  const d = DRAG; DRAG = null; if (!d) return;
  if (d.raf) cancelAnimationFrame(d.raf);
  try { d.svg.releasePointerCapture(d.id); } catch (_) { /* not captured */ }
  d.svg.style.cursor = "";
  if (d.moved) { window._dragMoved = true; setTimeout(() => { window._dragMoved = false; }, 0); if (d.box) setView(d.svg, d.box); }
}
for (const ev of ["pointerup", "pointercancel", "lostpointercapture"]) document.addEventListener(ev, endDrag);
if (window.addEventListener) window.addEventListener("blur", endDrag);
document.addEventListener("dragstart", (e) => { if (e.target.closest && e.target.closest(".zmap")) e.preventDefault(); });
function setView(svg, box) { svg.setAttribute("viewBox", box.join(" ")); BATCH.view = { id: svg.closest(".zmap").dataset.zmap, box }; if (window.onZoomMap) window.onZoomMap(svg, box); }

// ---------------------------------------------------------------- stage shell
const LEADS = {
  configure: "Choose the territorial authorities to prepare and their water provider (PRVDR), add your input files, allocate rows and provider codes that don't match, and check the suburbs against LINZ. Each region runs as its own job within the free-tier budgets, and data already stored by anyone is reused.",
  load: "Queue the validated regions, follow their progress, publish them and download tile lists." };
for (const id of Object.keys(BSTAGES)) V[id] = () => {
  setTimeout(async () => { try { await loadBatchData(); drawBatch(); } catch (e) { const el = $("#batch-body"); if (el) el.innerHTML = `<p class="muted">${esc(e.message)}</p>`; } }, 0);
  return `<h1>0 · ${BSTAGES[id]}</h1><p class="lead">${LEADS[id]}</p><div id="batch-body"><p class="muted">Loading…</p></div>`;
};
function drawBatch() {
  MEMO.fresh = false;
  const el = $("#batch-body"); if (!el || !BATCH.tas || !isB()) return;
  if (stage === "load") { el.innerHTML = loadHTML(); return; }
  const i = CFG_STEPS.findIndex(([k]) => k === bsub);
  el.innerHTML = configBar() + `<div class="row" role="tablist" aria-label="Configure steps" style="margin-bottom:12px">${CFG_STEPS.map(([k, l], j) => `<button class="btn ${k === bsub ? "primary" : ""}" role="tab" aria-selected="${k === bsub}" data-btab="${k}" type="button">2.${j + 1} ${l}</button>`).join("")}</div>`
    + { select: configureHTML, allocate: allocateHTML, vsuburbs: validateHTML }[CFG_STEPS[i < 0 ? 0 : i][0]]();
}

// ---------------------------------------------------------------- 1. configure
function configureHTML() {
  const sc = scopeByTA(), sel = [...BATCH.sel].sort(), newFound = tasInFiles().filter((c) => !BATCH.sel.has(c));
  const layers = BATCH.tas.map((t) => ({ attr: `data-ta="${t.code}"`, d: pathD(t.geom.coordinates), fill: BATCH.sel.has(t.code) ? "var(--accent)" : "var(--land)", op: BATCH.sel.has(t.code) ? 0.7 : 1, click: true,
    title: `${t.name} · ${(t.prvdrs || []).join(", ")}${t.parts > 1 ? " · needs a suburb list" : ""}` }));
  const filt = store.get("bta-filter", "");
  const rows = BATCH.tas.filter((t) => !filt || norm([t.name, (t.prvdrs || []).join(" "), t.rc].join(" ")).includes(norm(filt))).map((t) =>
    `<tr><td><input type="checkbox" data-tsel="${t.code}" ${BATCH.sel.has(t.code) ? "checked" : ""} aria-label="Select ${esc(t.name)}"></td><td class="l">${esc(t.name)}</td><td class="l">${esc((t.prvdrs || []).join(", "))}</td><td class="l small">${esc(t.rc || "")}</td><td>${t.sa2}</td></tr>`).join("");
  const opts = (cur) => BATCH.providers.map((p) => `<option value="${p.prvdr}" ${p.prvdr === cur ? "selected" : ""}>${esc(p.prvdr)} · ${esc(p.name)}</option>`).join("");
  const selRows = sel.map((c) => { const t = taOf(c), s = sc[c], p = prvdrFor(c), w = rateFor(p);
    const rate = w ? `${esc(w.CHARGING_TYPE || "–")} · fixed ${w.FIXED_PA == null ? '<span class="muted">not verified</span>' : "$" + fmt(w.FIXED_PA, 2) + "/yr"} · ${w.VOLUMETRIC_PA == null ? "no volumetric charge" : "$" + fmt(w.VOLUMETRIC_PA, 2) + "/m³"} · checked ${esc(w.DATE_EST || "–")}${w.source ? ` · <a href="${esc(w.source)}" target="_blank" rel="noopener">source</a>` : ""}` : '<span class="muted">no rates on record</span>';
    return `<tr><td class="l"><b>${esc(t.name)}</b><br><span class="small muted">${s ? `${s.studies || s.keep.length} ${s.studies ? "study " : ""}suburbs (${esc(s.basis)})` : t.parts > 1 ? "needs a suburb list" : "whole TA"}</span></td>
      <td class="l">${(() => { const f = filePrvdr(c), acr = !BATCH.prvdr[c] && f && f.code ? f.acronyms.filter((a) => norm(a) !== norm(p)) : [];
        const src = BATCH.prvdr[c] ? "chosen" : f && f.code ? "file" : BATCH.cfgPrvdr[c] ? "saved" : "default";
        return `<span class="row" style="gap:4px;flex-wrap:nowrap;align-items:center"><select data-tprvdr="${c}" aria-label="PRVDR for ${esc(t.name)}" title="${esc((BATCH.providers.find((x) => x.prvdr === p) || {}).name || p)}" style="max-width:8.5em">${opts(p)}</select>
          ${BATCH.prvdr[c] ? `<button class="btn" type="button" data-tprvdr-reset="${c}" style="padding:0 5px" title="Reset to ${esc(prvdrSource(c) === "chosen by you" ? "your files / default" : "")}" aria-label="Reset PRVDR">↺</button>` : ""}</span>
          <span class="small muted" title="${esc(prvdrSource(c))}">${acr.length ? `<b style="color:var(--ink)">${acr.map(esc).join(", ")}</b> · ` : ""}${src}</span>${f && f.unresolved.length ? ` <button class="btn" type="button" data-btab="allocate" title="${esc(f.unresolved.join(", "))}: no saved provider, match them in 2.2" style="padding:0 5px;font-size:11px">${f.unresolved.length} unmatched</button>` : ""}`; })()}</td><td class="l small" style="white-space:normal;min-width:190px">${rate}</td>
      <td class="l">${timelineCell(c)}</td>
      <td><button class="btn" type="button" data-tunsel="${c}" aria-label="Remove ${esc(t.name)}">×</button></td></tr>
`; }).join("");
  return `<div class="grid g2">
    <div class="card">${zoomMap("cfg", layers, mapBox(BATCH.tas.map((t) => t.geom.coordinates)))}<p class="small muted" style="margin:6px 0 0">Scroll to zoom, drag to pan, click a TA to select it.</p></div>
    <div class="card"><h3>Saved configurations</h3>
      ${can("editor") ? `<div class="row"><select id="cfg-pick" aria-label="Saved configuration"><option value="">New configuration</option>${BATCH.configs.map((c) => `<option value="${c.id}" ${BATCH.config && BATCH.config.id === c.id ? "selected" : ""}>${esc(c.name)} (${c.ta_codes.length} TAs)</option>`).join("")}</select>
        <input type="text" id="cfg-name" placeholder="Name" value="${esc(BATCH.config ? BATCH.config.name : "")}" style="width:160px"><button class="btn" id="cfg-save" type="button">Save</button>${BATCH.config ? '<button class="btn" id="cfg-del" type="button">Delete</button>' : ""}</div>
        <p class="small muted">Stores the selected TAs, PRVDRs, keep rule, provider-code matches, allocations and the resulting suburb names, not your files. Only you can see your configurations.</p>` : lock("editor", "Saving configurations")}
      <h3 style="margin-top:12px">Input files (optional)</h3>
      <p class="small muted">Read in your browser and applied to the selected TAs only.</p>
      <p class="small" style="margin:6px 0"><label><b>Add several at once</b> <input type="file" multiple accept=".json,.csv,.tsv,application/json,text/csv" id="bin-files"></label><br><span class="muted">Each file goes to its slot below by name.</span></p>
      <p class="small" style="margin:6px 0"><label><b>nz_suburb_builder_config.json</b> <input type="file" accept=".json,application/json" id="bcfg-import"></label>${BATCH.builder ? ` <span class="tag info">${esc(BATCH.builder.fname)}</span> <button class="btn" type="button" id="bcfg-clear">Clear</button>` : ""}<br>
        <span class="muted">From the reference builder (suburb_lookup.html): keep rule, PRVDR matches and suburb allocations.</span>${builderNote()}</p>
      ${[["provider", "nz_suburb_provider.csv", "M_SUBURB, Other spellings, PRVDR: the study suburbs in scope and their provider (sets each TA's PRVDR)"], ["map", "nz_suburb_map.csv", "M_SUBURB, PROVIDER, NZ_SUBURB_REF, M_TERRITORY: allocations of study suburbs to LINZ suburbs"], ["ref", "nz_suburb_ref.csv", "M_SUBURB, TYPE, M_TERRITORY, …: the LINZ suburb reference"]].map(([k, f, cols]) =>
        `<p class="small" style="margin:6px 0"><label><b>${f}</b> <input type="file" accept=".csv,.tsv,text/csv" data-sfile="${k}"></label>${BATCH.files[k] ? ` <span class="tag info">${esc(BATCH.fileNames[k] || "")} · ${BATCH.files[k].length} rows</span> <button class="btn" type="button" data-sclear="${k}">Clear</button>` : ""}<br><span class="muted">${cols}</span></p>`).join("")}
      <p class="small"><label>Without nz_suburb_provider.csv, nz_suburb_map and nz_suburb_ref define the scope: keep a suburb that is in <select id="batch-keep"><option value="any" ${BATCH.keep === "any" ? "selected" : ""}>either list</option><option value="both" ${BATCH.keep === "both" ? "selected" : ""}>both lists</option></select></label></p>
      ${newFound.length ? `<p class="small">Your files also mention ${newFound.length} TA(s) that aren't selected: ${newFound.map((c) => esc(taOf(c).name)).join(", ")}. <button class="btn" id="sel-found" type="button">Select them</button></p>` : ""}
    </div></div>
  <h2>Selected TAs (${sel.length}): PRVDR and charging rates</h2><p class="small muted">PRVDR comes from your lists (nz_suburb_provider.csv, then nz_suburb_map.csv's PROVIDER) or the TA's saved provider; your own acronym is shown in bold. Change it at any time.</p>
  <div class="card scroll">${sel.length ? `<div class="row small" style="gap:8px;margin-bottom:8px;align-items:center"><span class="muted">Set every TA's timeline to</span>${tlEditor("_all")}<button class="btn" type="button" id="tl-apply-all" style="padding:1px 8px">Apply to all</button></div>
    <table><thead><tr><th class="l">TA and scope</th><th class="l">PRVDR</th><th class="l">Charging (2026/27)</th><th class="l">Timeline <span class="muted" style="font-weight:normal">weather from → to · census</span></th><th></th></tr></thead><tbody>${selRows}</tbody></table>` : '<p class="muted">Select TAs on the map or in the table below.</p>'}
    ${sel.length ? `<div class="row" style="margin-top:8px"><button class="btn primary" type="button" data-btab="allocate">Next: 2.2 Allocate →</button><button class="btn" id="batch-clear" type="button">Clear selection</button></div>` : ""}</div>
  <h2>All regions with charging rates (${BATCH.tas.length} TAs)</h2>
  <div class="row" style="margin-bottom:8px"><label class="small">Filter <input type="text" id="bta-filter" value="${esc(filt)}" placeholder="TA, PRVDR or region"></label>
    <button class="btn" type="button" id="bta-all">Select shown</button><button class="btn" type="button" id="bta-none">Deselect shown</button></div>
  <div class="card scroll" style="max-height:320px;overflow:auto"><table><thead><tr><th></th><th class="l">TA</th><th class="l">PRVDR</th><th class="l">Region</th><th>SA2s</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

// ---------------------------------------------------------------- LINZ suburbs per TA (shared cache)
async function ensureLinz(c, force) {
  if (BATCH.linz[c] && !force) return BATCH.linz[c];
  const { data, error } = await sb.functions.invoke("linz-suburbs", { body: force ? { ta_code: c, refresh: true } : { ta_code: c } });
  if (error) { let m = error.message; try { m = (await error.context.json()).error || m; } catch (_) { /* keep message */ } throw new Error(m); }
  const res = await q(sb.rpc("ta_suburbs", { p_ta: c, p_tol: 20 }));
  if (BATCH.gaz) delete BATCH.gaz[c];
  BATCH.rev = (BATCH.rev || 0) + 1; MEMO.fresh = false;
  return (BATCH.linz[c] = { list: res.suburbs || [], cached: data && data.cached, requests: (data && data.requests) || 0 });
}
const LIDX = new WeakMap();
// LINZ suburbs by name: exact (macron-insensitive) keys, plus match keys (punctuation and Mt/St tolerant)
const linzIndex = (linz) => { if (LIDX.has(linz)) return LIDX.get(linz); const m = new Map(); LIDX.set(linz, m);
  for (const x of linz) for (const n of [x.name, x.name_ascii]) if (n) { m.set(norm(n), x); if (!m.has("~" + mkey(n))) m.set("~" + mkey(n), x); }
  const get = m.get.bind(m); m.get = (k) => get(k) || get("~" + mkey(k)); const has = m.has.bind(m); m.has = (k) => has(k) || has("~" + mkey(k)); return m; };
// a scoped name -> LINZ suburbs: direct match, else your allocation for that row
function locate(name, terr, file, byNorm) {
  const a = allocFor(file, name, terr);
  if (a) { const t = (a.linzSuburbs || []).map((x) => byNorm.get(x.name)).filter(Boolean); if (t.length) return { linz: t, allocated: true }; }
  const hit = byNorm.get(name); return hit ? { linz: [hit], allocated: false } : null;
}
function locateRow(n, row, byNorm) {
  const hit = locate(n, row.territory || "", row.file || "", byNorm); if (hit || row.via) return hit;
  for (const sp of row.spellings || []) { const x = byNorm.get(sp); if (x) return { linz: [x], allocated: false }; }
  return null;
}
// study suburbs you added in 2.2 that aren't in your files (file "manual", territory = the TA)
const manualFor = (c) => Object.values(BATCH.alloc).filter((a) => a.file === "manual" && rowTAs(a.territory).includes(c));

// suburbs a TA would load: your names matched or allocated (or all its LINZ suburbs when no list covers it), then your
// picks from 2.2: excluded suburbs removed, added suburbs included
function tapicks(c) { const P = BATCH.picks[c] || {}; return { add: P.add || [], ex: P.ex || [], skip: P.skip || [], alias: P.alias || {} }; }
// combined study suburbs: alias name -> the study suburb it is another spelling of (per TA)
const aliasOf = (c, n) => { const A = tapicks(c).alias; return A[norm(n)] ? A[norm(n)].to : null; };
function setPicks(c, P) { const np = { add: P.add || [], ex: P.ex || [], skip: P.skip || [], alias: P.alias || {} };
  np.add.length || np.ex.length || np.skip.length || Object.keys(np.alias).length ? BATCH.picks[c] = np : delete BATCH.picks[c]; BATCH.valid = {}; saveSel(); }
function scopeOf(c) { return memo("scopeOf|" + c, () => scopeOf_(c)); }
function scopeOf_(c) {
  const s = scopeByTA()[c], L = BATCH.linz[c]; if (!L) return null;
  const byNorm = linzIndex(L.list), pairs = []; let unmatched = [];
  if (s) { for (const n of s.keep) { const rows = s.rows.filter((r) => norm(r.linz_ref) === norm(n)); let ok = false;
      for (const row of rows.length ? rows : [{}]) { const hit = locateRow(n, row, byNorm);
        if (hit) { ok = true; hit.linz.forEach((x) => pairs.push({ input: n, mname: row.m_suburb || n, row: row.file ? row : null, linz: x, allocated: hit.allocated })); } }
      if (!ok) unmatched.push(n); }
    const spell = new Set(s.rows.flatMap((r) => r.spellings || []).map(norm));
    unmatched = unmatched.filter((n) => !(spell.has(norm(n)) && pairs.length)); }
  for (const a of manualFor(c)) for (const t of a.linzSuburbs || []) { const x = byNorm.get(t.name); if (x) pairs.push({ input: a.name, mname: a.name, manual: true, linz: x, allocated: true }); }
  const byId = new Map();
  for (const m of s ? pairs : [...L.list.map((x) => ({ input: x.name, linz: x, whole: true })), ...pairs]) {
    const e = byId.get(m.linz.id) || { input: m.input, linz: m.linz, allocated: false, studies: [] };
    if (!m.whole) { e.studies.push(m.mname); if (e.studies.length === 1) e.input = m.input; e.allocated = e.allocated || m.allocated; }
    byId.set(m.linz.id, e); }
  const base = [...byId.values()];
  base.forEach((e) => { e.studies = [...new Map(e.studies.map((x) => [norm(x), x])).values()]; });
  const P = tapicks(c), skip = new Set(P.skip.map(norm));
  for (const m of pairs) { const to = aliasOf(c, m.mname); if (to) m.mname = to; }
  if (skip.size) { for (let i = pairs.length - 1; i >= 0; i--) if (skip.has(norm(pairs[i].mname))) pairs.splice(i, 1);
    for (const e of base) e.studies = e.studies.filter((x) => !skip.has(norm(x)));
    for (let i = base.length - 1; i >= 0; i--) if (s && !base[i].studies.length && !base[i].whole) base.splice(i, 1); }
  const ex = new Set(P.ex.map(norm)), inBase = new Set(base.map((m) => norm(m.linz.name)));
  const matched = base.filter((m) => !ex.has(norm(m.linz.name)));
  for (const n of P.add) { const x = byNorm.get(n); if (x && !inBase.has(norm(x.name)) && !ex.has(norm(x.name))) matched.push({ input: x.name, linz: x, added: true, studies: [] }); }
  return { s, L, base, matched, unmatched, allPairs: pairs, isEx: (n) => ex.has(norm(n)), pairs: pairs.filter((m) => !ex.has(norm(m.linz.name))), excluded: base.filter((m) => ex.has(norm(m.linz.name))),
    scoped: !!s || P.add.length > 0 || P.ex.length > 0 || P.skip.length > 0 || manualFor(c).length > 0 };
}
function togglePick(c, name, include) {
  const P = { add: [...tapicks(c).add], ex: [...tapicks(c).ex], skip: [...tapicks(c).skip], alias: tapicks(c).alias }, sc = scopeOf(c), k = norm(name);
  const inBase = sc && sc.base.some((m) => norm(m.linz.name) === k);
  P.add = P.add.filter((x) => norm(x) !== k); P.ex = P.ex.filter((x) => norm(x) !== k);
  if (inBase && !include) P.ex.push(name); if (!inBase && include) P.add.push(name);
  setPicks(c, { ...tapicks(c), ...P });
}
// ‹ previous / next › through the selected TAs, labelled with each TA's provider
function taNav(cur, attr) {
  const sel = [...BATCH.sel].sort(), i = sel.indexOf(cur);
  const onward = attr === "data-vta" ? ["load", "Next: 3 Load ›"] : attr === "data-ata" ? ["vsuburbs", "Next: 2.3 Validate ›"] : null;
  if (sel.length < 2) return onward ? `<button class="btn primary" type="button" ${onward[0] === "load" ? 'data-btab="load"' : 'id="alloc-next" data-todo="' + sel.reduce((t, x) => t + unassigned(x).length, 0) + '"'}>${onward[1]}</button>` : "";
  if (onward && i === sel.length - 1) { const prev = sel[i - 1];
    return `<span class="row" style="gap:6px"><button class="btn" type="button" ${attr}="${prev}" title="${esc(taOf(prev).name)}">‹ Previous</button><span class="small muted">${i + 1} of ${sel.length}</span><button class="btn primary" type="button" ${onward[0] === "load" ? 'data-btab="load"' : `id="alloc-next" data-todo="${sel.reduce((t, x) => t + unassigned(x).length, 0)}"`}>${onward[1]}</button></span>`; }
  const lab = (c) => `${esc(taOf(c).name)} · ${esc(prvdrFor(c))}`, prev = sel[(i - 1 + sel.length) % sel.length], next = sel[(i + 1) % sel.length];
  return `<span class="row" style="gap:6px"><button class="btn" type="button" ${attr}="${prev}" title="${lab(prev)}">‹ Previous</button><span class="small muted">${i + 1} of ${sel.length}</span><button class="btn" type="button" ${attr}="${next}" title="${lab(next)}">Next ›</button></span>`;
}

// ---------------------------------------------------------------- 3. allocate
function codesInFiles() {
  const m = new Map();
  const add = (v, f) => { const k = norm(v); if (!k) return; const e = m.get(k) || { code: String(v).trim(), rows: 0, files: new Set() }; e.rows++; e.files.add(f); m.set(k, e); };
  for (const r of BATCH.files.provider || []) add(r.PRVDR, "nz_suburb_provider.csv");
  for (const r of BATCH.files.map || []) add(r.PROVIDER, "nz_suburb_map.csv");
  for (const r of BATCH.files.ref || []) add(r.PRVDR || r.PROVIDER, "nz_suburb_ref.csv");
  for (const k of Object.keys(BATCH.matches)) if (!m.has(k)) m.set(k, { code: k.toUpperCase(), rows: 0, files: new Set(["saved match"]) });
  return [...m.entries()].map(([k, e]) => ({ key: k, ...e, mine: BATCH.matches[k] || "", saved: prvdrCode(e.code) })).sort((a, b) => (!!(a.mine || a.saved) - !!(b.mine || b.saved)) || a.code.localeCompare(b.code));
}
function inGeom(geom, x, y) { let ins = false;
  for (const poly of geom) for (const r of poly) for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, yi] = r[i], [xj, yj] = r[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) ins = !ins; }
  return ins; }
// look up not-found study names in the NZ Gazetteer (official place names with coordinates) and suggest the LINZ suburb that
// contains each place; only places inside this TA's suburbs count
async function gazetteer(c) {
  const L = BATCH.linz[c]; if (!L) return;
  const names = unassigned(c).flatMap((r) => [r.mname, r.name]).filter((n, i, a) => n && a.findIndex((x) => norm(x) === norm(n)) === i);
  if (!names.length) return toastMsg("Nothing to look up: every study suburb has a LINZ suburb");
  const { data, error } = await sb.functions.invoke("linz-suburbs", { body: { action: "places", ta_code: c, names } });
  if (error) { let m = error.message; try { m = (await error.context.json()).error || m; } catch (_) { /* keep */ } throw new Error(m); }
  const G = (BATCH.gaz = BATCH.gaz || {})[c] = {};
  for (const p of (data && data.places) || []) {
    const hit = L.list.find((x) => x.geom && inGeom(x.geom.coordinates, p.x, p.y)); if (!hit) continue;
    for (const n of names) if (mkey(n) === mkey(p.name)) (G[mkey(n)] = G[mkey(n)] || []).push({ place: p.name, type: p.type, status: p.status, linz: hit.name });
  }
  const found = Object.keys(G).length; toastMsg(`NZ Gazetteer: ${found} of ${names.length} name(s) located inside ${taOf(c).name}`);
}
// suburbs just outside the TA: LINZ suburbs with a not-found name that lie within ~8 km of the TA (in a neighbouring TA)
async function nearbySuburbs(c) {
  const names = unassigned(c).flatMap((r) => [r.mname, r.name]).filter((n, i, a) => n && a.findIndex((x) => norm(x) === norm(n)) === i); if (!names.length) return 0;
  const { data, error } = await sb.functions.invoke("linz-suburbs", { body: { action: "nearby", ta_code: c, names } });
  if (error) { let m = error.message; try { m = (await error.context.json()).error || m; } catch (_) { /* keep */ } throw new Error(m); }
  const N = (BATCH.near = BATCH.near || {})[c] = {};
  for (const x of (data && data.nearby) || []) for (const n of names) if (mkey(n) === mkey(x.name)) (N[mkey(n)] = N[mkey(n)] || []).push(x);
  return Object.keys(N).length;
}
// adopt a nearby suburb into the TA's list (shared cache), then reload the list
async function adoptSuburb(c, id) {
  const { data, error } = await sb.functions.invoke("linz-suburbs", { body: { action: "adopt", ta_code: c, ids: [id] } });
  if (error) { let m = error.message; try { m = (await error.context.json()).error || m; } catch (_) { /* keep */ } throw new Error(m); }
  const res = await q(sb.rpc("ta_suburbs", { p_ta: c, p_tol: 20 }));
  BATCH.linz[c] = { ...BATCH.linz[c], list: [...(res.suburbs || [])] }; BATCH.rev++; MEMO.fresh = false;   // a new list, so the name index is rebuilt
  return data && data.adopted;
}
// rows of a TA's lists that match no LINZ suburb (allocated or not)
function allocRows(c, all) { return memo(`allocRows|${c}|${all ? 1 : 0}`, () => allocRows_(c, all)); }
function allocRows_(c, all) {
  const s = scopeByTA()[c], L = BATCH.linz[c]; if (!L) return [];
  const byNorm = linzIndex(L.list), out = [], seen = new Set();
  if (s) { const keep = new Set(s.keep.map(norm)), rows = s.rows.length ? s.rows : s.keep.map((n) => ({ linz_ref: n, m_suburb: n, territory: "", file: "" }));
    for (const r of rows) {
      if (!keep.has(norm(r.linz_ref))) continue;
      const direct = byNorm.has(r.linz_ref) || (r.spellings || []).some((x) => byNorm.has(x));
      const k = allocKey(r.file, r.linz_ref, r.territory || ""); if (seen.has(k)) continue;
      const alloc = allocFor(r.file, r.linz_ref, r.territory || ""); if (!all && direct && !(alloc && alloc.file === r.file)) continue; seen.add(k);
      const hit = locateRow(r.linz_ref, r, byNorm);
      const tg = hit ? hit.linz.map((x) => x.name) : [];
      out.push({ key: k, file: r.file, name: r.linz_ref, mname: r.m_suburb || r.linz_ref, territory: r.territory || "", alloc, direct, targets: tg, status: !tg.length ? "not found" : hit.allocated ? "mapped" : "matched" }); } }
  for (const a of manualFor(c)) { const k = allocKey("manual", a.name, a.territory);
    const tg = (a.linzSuburbs || []).map((x) => (byNorm.get(x.name) || {}).name).filter(Boolean);
    out.push({ key: k, file: "manual", name: a.name, mname: a.name, territory: a.territory, alloc: a, manual: true, targets: tg, status: tg.length ? "mapped" : "not found" }); }
  const skip = new Set(tapicks(c).skip.map(norm)); for (const r of out) if (skip.has(norm(r.mname))) r.skipped = true;
  const A = tapicks(c).alias, merged = [];
  for (const r of out) { const to = A[norm(r.mname)] && A[norm(r.mname)].to; if (!to) { merged.push(r); continue; }
    const host = out.find((x) => norm(x.mname) === norm(to) && !A[norm(x.mname)]); if (!host) { merged.push(r); continue; }
    host.aliases = [...(host.aliases || []), r.mname]; for (const x of r.targets) if (!host.targets.includes(x)) host.targets.push(x);
    if (host.status === "not found" && host.targets.length) host.status = "mapped"; }
  return merged;
}
function allocateHTML() {
  const sel = [...BATCH.sel].sort(); if (!sel.length) return `<p class="muted">Select TAs in 2.1 Inputs and TAs first.</p>`;
  const codes = codesInFiles(), opts = (cur) => `<option value="">(no match)</option>` + BATCH.providers.map((p) => `<option value="${p.prvdr}" ${p.prvdr === cur ? "selected" : ""}>${esc(p.prvdr)} · ${esc(p.name)}</option>`).join("");
  const codeRows = codes.map((e) => `<tr><td class="l"><code>${esc(e.code)}</code></td><td>${e.rows || "–"}</td><td class="l small">${esc([...e.files].join(", "))}</td>
    <td class="l"><select data-pmatch="${esc(e.key)}" aria-label="Provider for ${esc(e.code)}">${opts(e.mine || e.saved)}</select></td>
    <td class="l small">${e.mine ? `your match <button class="btn" type="button" data-punmatch="${esc(e.key)}" style="padding:1px 6px">reset</button>` : e.saved ? "saved provider" : '<span class="tag warn">unresolved</span>'}</td></tr>`).join("");
  const c = BATCH.aTA && sel.includes(BATCH.aTA) ? BATCH.aTA : sel[0], t = taOf(c), L = BATCH.linz[c], sc = scopeByTA()[c];
  if (sel.some((x) => !BATCH.linz[x] && !(BATCH.linzErr || {})[x])) setTimeout(autoLinz, 0);
  let detail;
  if (!L) detail = (BATCH.linzErr || {})[c] ? `<p class="small"><span class="tag bad">${esc(BATCH.linzErr[c])}</span> <button class="btn" type="button" data-alinz="${c}">Try again</button></p>` : `<p class="small muted">Loading ${esc(t.name)}'s LINZ suburbs (shared cache)…</p>`;
  else {
    const rows = allocRows(c, true), names = L.list.map((x) => x.name), S = scopeOf(c), selected = aSel();
    for (const k of [...selected]) if (!rows.some((r) => r.key === k)) selected.delete(k);
    const selTargets = new Set(rows.filter((r) => selected.has(r.key)).flatMap((r) => r.targets.map(norm)));
    const used = new Map(); for (const r of rows) if (!r.skipped) for (const x of r.targets) used.set(norm(x), (used.get(norm(x)) || 0) + 1);
    const exc = new Set(S.excluded.map((m) => norm(m.linz.name))), added = new Set(S.matched.filter((m) => m.added).map((m) => norm(m.linz.name)));
    const layers = [{ d: pathD(t.geom.coordinates), fill: "var(--land)", stroke: "var(--ink)", sw: 1.4, title: t.name },
      ...L.list.map((x) => { const k = norm(x.name), st = selTargets.has(k) ? "selected" : exc.has(k) ? "excluded" : used.has(k) || added.has(k) || !sc ? "in use" : "free";
        return { attr: `data-asub="${esc(x.name)}"`, click: true, d: pathD(x.geom.coordinates), fill: st === "selected" ? "#e6550d" : st === "in use" ? "var(--accent)" : st === "excluded" ? "var(--bad, #b3261e)" : "var(--land)",
          op: st === "selected" ? 0.85 : st === "in use" ? 0.5 : st === "excluded" ? 0.3 : 0.7, sw: 0.8, title: `${x.name}${x.adopted ? ` [adopted from ${String(x.home_ta || "a neighbouring TA").split(",")[0]}]` : ""}${used.get(k) ? ` (used by ${used.get(k)} study suburb${used.get(k) === 1 ? "" : "s"})` : st === "free" ? " (not assigned)" : ""}` }; })];
    const order = { "not found": 0, mapped: 1, matched: 2 }, filt = norm(store.get("afilter", ""));
    const shown = rows.filter((r) => !filt || norm(r.mname + " " + r.targets.join(" ")).includes(filt)).sort((a, b) => (a.skipped - b.skipped) || (order[a.status] - order[b.status]) || a.mname.localeCompare(b.mname));
    const nf = rows.filter((r) => r.status === "not found" && !r.skipped).length, nm = rows.filter((r) => r.status === "mapped").length, nok = rows.filter((r) => r.status === "matched").length;
    const tag = (st) => `<span class="tag ${st === "not found" ? "warn" : st === "mapped" ? "info" : "ok"}">${st}</span>`;
    const hint = selected.size ? `<b>${selected.size}</b> study suburb${selected.size === 1 ? "" : "s"} selected: click areas on the map to assign or unassign them. <button class="btn" type="button" id="aclear" style="padding:0 6px">Clear selection</button>`
      : "Tick study suburbs (start with the ones not found), then click areas on the map to assign them. With nothing ticked, clicking an area ticks the study suburbs that use it.";
    detail = `<div class="grid" style="grid-template-columns:minmax(0,1.1fr) minmax(320px,1fr);gap:12px;align-items:start">
      <div class="card">${zoomMap("alc-" + c, layers, mapBox([t.geom.coordinates]))}
        <p class="small" style="margin:6px 0 0">${hint}</p>
        <p class="small muted" style="margin:4px 0 0"><span style="color:#e6550d">■</span> selected suburbs' areas · <span style="color:var(--accent)">■</span> assigned · ■ not assigned${S.excluded.length || added.size ? ` · earlier picks: ${S.excluded.length} excluded, ${added.size} added <button class="btn" type="button" id="apicks-clear" style="padding:0 6px">clear</button>` : ""}</p></div>
      <div class="card amap"><div class="row" style="justify-content:space-between;align-items:center"><h3 style="margin:0">Study suburbs (${rows.length})</h3>
        <span class="small">${nf ? `<span class="tag warn">${nf} not found</span> ` : ""}<span class="tag info">${nm} mapped</span> <span class="tag ok">${nok} matched</span></span></div>
        <div class="row" style="gap:6px;margin:6px 0"><input type="text" id="afilter" value="${esc(store.get("afilter", ""))}" placeholder="Filter" style="width:120px" aria-label="Filter study suburbs">
          <button class="btn" type="button" id="asel-shown" style="padding:1px 8px">Select all shown</button>${nf ? `<button class="btn" type="button" id="asel-nf" style="padding:1px 8px">Select not found</button>` : ""}
          <button class="btn" type="button" data-aload="1" style="padding:1px 8px">Load all shown</button><button class="btn" type="button" data-aload="0" style="padding:1px 8px">Exclude all shown</button></div>
        <div class="row small" style="gap:6px;margin:0 0 6px">${nf ? `<button class="btn" type="button" id="agaz" style="padding:1px 8px" title="Search LINZ for not-found names in neighbouring councils (within ~8 km), and look them up in the NZ Gazetteer of official place names">🔎 Find not-found names (nearby councils + Gazetteer)</button>` : ""}
          <button class="btn" type="button" id="arefetch" style="padding:1px 8px" title="Fetch this TA's suburbs from LINZ again (uses one LINZ request)">↻ Re-fetch LINZ suburbs</button>
          <span class="muted">${fmt(L.list.length)} LINZ suburbs${L.cached ? " (shared cache)" : ""}</span></div>
        <div style="max-height:470px;overflow:auto"><table style="width:100%"><thead><tr><th></th><th class="l">Study suburb</th><th class="l">LINZ suburb(s)</th><th class="l">Load</th></tr></thead><tbody>
        ${shown.map((r) => { const sug = r.targets.length ? [] : similar(r.mname, names).concat(similar(r.name, names)).filter((x, i, a) => a.indexOf(x) === i).slice(0, 3), on = selected.has(r.key);
          const nb = r.targets.length ? [] : (((BATCH.near || {})[c] || {})[mkey(r.mname)] || ((BATCH.near || {})[c] || {})[mkey(r.name)] || []);
          const gz = r.targets.length ? [] : (((BATCH.gaz || {})[c] || {})[mkey(r.mname)] || ((BATCH.gaz || {})[c] || {})[mkey(r.name)] || []);
          return `<tr style="${on ? "background:var(--accent-soft)" : ""}${r.skipped ? ";opacity:.55" : ""}"><td><input type="checkbox" data-asel="${esc(r.key)}" ${on ? "checked" : ""} aria-label="Select ${esc(r.mname)}"></td>
            <td class="l"><b>${esc(r.mname)}</b> ${tag(r.status)}${norm(r.mname) !== norm(r.name) ? `<br><span class="small muted">ref ${esc(r.name)}</span>` : ""}${r.manual ? ` <button class="btn" type="button" data-mdel="${esc(r.key)}" style="padding:0 4px">remove</button>` : ""}</td>
            <td class="l small">${r.targets.map((x) => `<span class="tag ${r.status === "matched" ? "ok" : "info"}">${esc(x)} <button class="btn" type="button" data-adel="${esc(r.key)}" data-aname="${esc(x)}" style="padding:0 4px" aria-label="Unassign ${esc(x)}">×</button></span>`).join(" ")}
              ${r.alloc && !r.manual && r.direct ? ` <button class="btn" type="button" data-areset="${esc(r.key)}" style="padding:0 4px">use name match</button>` : ""}
              ${sug.length ? `<span class="muted">did you mean</span> ${sug.map((n) => `<button class="btn" type="button" data-aadd="${esc(r.key)}" data-aname="${esc(n)}" style="padding:1px 6px">${esc(n)}</button>`).join(" ")}` : ""}
              ${nb.length ? `<br><span class="muted">just outside ${esc(t.name)}:</span> ${nb.map((x) => `<button class="btn" type="button" data-aadopt="${esc(r.key)}" data-aid="${x.id}" data-aname="${esc(x.name)}" title="LINZ places ${esc(x.name)} in ${esc(x.ta)}, ${x.km} km from ${esc(t.name)}: adopt it into this TA's suburbs and assign it" style="padding:1px 6px">↗ ${esc(x.name)} <span class="muted">(${esc(String(x.ta).split(",")[0])}, ${x.km} km)</span></button>`).join(" ")}` : ""}
              ${gz.length ? `<br><span class="muted">NZ Gazetteer:</span> ${[...new Map(gz.map((g) => [g.linz, g])).values()].map((g) => `<button class="btn" type="button" data-aadd="${esc(r.key)}" data-aname="${esc(g.linz)}" title="${esc(g.place)} (${esc(g.type || "place")}, ${esc(g.status || "")}) lies in ${esc(g.linz)}" style="padding:1px 6px">📍 ${esc(g.linz)}</button>`).join(" ")}` : ""}
              ${(r.aliases || []).length ? `<br><span class="muted">also spelled:</span> ${r.aliases.map((a) => `<span class="tag">${esc(a)} <button class="btn" type="button" data-uncombine="${esc(a)}" style="padding:0 4px" aria-label="Separate ${esc(a)}">×</button></span>`).join(" ")}` : ""}</td>
            <td><button class="btn" type="button" data-askip="${esc(r.mname)}" data-on="${r.skipped ? "1" : "0"}" style="padding:1px 8px;${r.skipped ? "" : "border-color:var(--ok, #2e7d32);color:var(--ok, #2e7d32)"}" aria-pressed="${!r.skipped}">${r.skipped ? "Excluded" : "Load"}</button></td></tr>`; }).join("")}</tbody></table></div>
        <datalist id="alc-dl">${names.map((n) => `<option value="${esc(n)}">`).join("")}</datalist>
        <div class="row small" style="gap:6px;margin:8px 0 0">Add a study suburb <input type="text" id="mnew-study" placeholder="name" style="width:120px" aria-label="New study suburb"> → <input type="text" list="alc-dl" id="mnew-linz" placeholder="LINZ suburb" style="width:120px" aria-label="LINZ suburb"><button class="btn" type="button" id="mnew">Add</button></div>
        <datalist id="study-dl">${rows.filter((r) => !(r.aliases && false)).map((r) => `<option value="${esc(r.mname)}">`).join("")}</datalist>
        <div class="row small" style="gap:6px;margin:6px 0 0">Combine: <input type="text" list="study-dl" id="comb-from" placeholder="spelling" style="width:120px" aria-label="Study suburb that is another spelling"> is another spelling of <input type="text" list="study-dl" id="comb-to" placeholder="study suburb" style="width:120px" aria-label="Study suburb to keep"><button class="btn" type="button" id="comb-go">Combine</button></div>
        <p class="small muted" style="margin:6px 0 0">A study suburb can use several LINZ suburbs and a LINZ suburb several study suburbs. Untick <i>Load</i> to leave a study suburb out. Saved with the configuration and in exported builder configs.</p></div></div>`;
  }
  return `<div class="card"><h3>Provider codes in your files</h3>
    ${codes.length ? `<table><thead><tr><th class="l">PRVDR / PROVIDER</th><th>Rows</th><th class="l">File</th><th class="l">Saved provider</th><th class="l"></th></tr></thead><tbody>${codeRows}</tbody></table>
      <p class="small muted">Codes resolve through your match, else a saved provider's PRVDR, legacy code, alias or name. Matches feed each TA's PRVDR in 2.1.</p>` : '<p class="small muted">No provider codes: add nz_suburb_provider.csv or nz_suburb_map.csv in 2.1.</p>'}</div>
  <div class="row" style="margin:14px 0 8px;justify-content:space-between"><h2 style="margin:0">${esc(t.name)} <span class="small muted">· ${esc(prvdrFor(c))}</span></h2>${taNav(c, "data-ata")}</div>
  <div class="row" style="margin:0 0 8px">${sel.map((x) => `<button class="btn ${x === c ? "primary" : ""}" type="button" data-ata="${x}">${esc(taOf(x).name)}${BATCH.linz[x] ? (unassigned(x).length ? ` <span class="tag warn">${unassigned(x).length}</span>` : " ✓") : " …"}</button>`).join("")}</div>
  ${detail}
  ${refinedHTML()}
  ${(() => { const todo = sel.reduce((t, x) => t + unassigned(x).length, 0);
    return `<div class="row" style="margin-top:12px;align-items:center;gap:8px"><button class="btn primary" type="button" id="alloc-next" data-todo="${todo}">Next: 2.3 Validate suburbs →</button>${todo ? `<span class="tag warn">${todo} study suburb${todo === 1 ? "" : "s"} not assigned</span> <span class="small muted">They won't be loaded unless you assign or skip them.</span>` : ""}</div>`; })()}`;
}
function setAlloc(r, names) {
  const k = allocKey(r.file, r.name, r.territory), terr = taOf(curTA()).name || "";
  for (const [kk, a] of Object.entries(BATCH.alloc)) if (a === r.alloc) delete BATCH.alloc[kk];
  if (names.length || r.manual) BATCH.alloc[k] = { file: r.file, name: r.name, territory: r.territory, linzSuburbs: names.map((n) => ({ name: n, territory: terr })) };
  BATCH.valid = {}; saveSel();
}
// map a study suburb to a LINZ suburb (either direction: several LINZ per study name, several study names per LINZ suburb)
function mapPair(c, study, linz) {
  const r = allocRows(c, true).find((x) => norm(x.mname) === norm(study) || norm(x.name) === norm(study));
  if (r) { if (!r.targets.some((x) => norm(x) === norm(linz))) setAlloc(r, [...r.targets, linz]); return; }
  const terr = taOf(c).name; BATCH.alloc[allocKey("manual", study, terr)] = { file: "manual", name: study, territory: terr, linzSuburbs: [{ name: linz, territory: terr }] };
  BATCH.valid = {}; saveSel();
}
const curTA = () => BATCH.aTA && BATCH.sel.has(BATCH.aTA) ? BATCH.aTA : [...BATCH.sel].sort()[0];
function curAllocRows() { return allocRows(curTA(), true); }
const rowByKey = (k) => curAllocRows().find((r) => r.key === k);
// study suburbs still without a LINZ suburb (skipped ones don't count), per TA
const unassigned = (c) => BATCH.linz[c] ? allocRows(c, true).filter((r) => !r.targets.length && !r.skipped) : [];
// selection of study rows (per TA) for assigning LINZ areas on the map
const aSel = () => { const c = curTA(); BATCH.aSel = BATCH.aSel || {}; return (BATCH.aSel[c] = BATCH.aSel[c] || new Set()); };
// open 2.2: fetch each selected TA's LINZ suburbs (shared cache) so study names are cross-referenced without validating first
async function autoLinz() {
  if (BATCH.linzLoading) return; BATCH.linzLoading = true;
  try { for (const c of [...BATCH.sel].sort()) if (!BATCH.linz[c]) { try { await ensureLinz(c); } catch (err) { BATCH.linzErr = BATCH.linzErr || {}; BATCH.linzErr[c] = err.message; } if (isSub("allocate")) drawBatch(); } }
  finally { BATCH.linzLoading = false; }
}

// ---------------------------------------------------------------- refined input files, saved as new versions
// The originals are never overwritten: each download gets the next version number and a timestamp, e.g.
// nz_suburb_provider.csv -> nz_suburb_provider_v2_20261124-0930.csv. Rows for TAs not refined here (not selected, or
// LINZ suburbs not loaded) and extra columns are kept as they were.
const stampNow = () => { const d = new Date(), z = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}`; };
function versionName(orig, fallback) {
  const m = String(orig || fallback).match(/^(.*?)(?:_v(\d+)(?:_\d{8}-\d{4})?)?(\.[a-z]+)?$/i);
  return `${m[1]}_v${(+m[2] || 1) + 1}_${stampNow()}${m[3] || ".csv"}`;
}
const acronymFor = (c) => { const f = filePrvdr(c); return !BATCH.prvdr[c] && f && f.acronyms.length ? f.acronyms[0] : prvdrFor(c); };
function refinedFiles() {
  const sel = [...BATCH.sel].sort(), done = sel.filter((c) => BATCH.linz[c]), skip = sel.filter((c) => !BATCH.linz[c]), D2 = Object.fromEntries(done.map((c) => [c, scopeOf(c)]));
  const inDone = (tas) => tas.some((c) => done.includes(c));
  const hdr = (k, def) => (BATCH.files[k] && BATCH.files[k].headers) || def;
  const write = (headers, rows) => [headers, ...rows.map((r) => headers.map((h) => r[h.toUpperCase()] ?? ""))];
  // provider: study suburbs in scope
  const ph = hdr("provider", ["M_SUBURB", "Other spellings", "PRVDR"]), prov = [];
  for (const r of BATCH.files.provider || []) { const tas = provRowTAs(r); if (!inDone(tas)) { prov.push(r); continue; }
    const c = tas.find((x) => done.includes(x)), S = D2[c], mine = S.allPairs.filter((m) => norm(m.mname) === norm(r.M_SUBURB));
    if (mine.length && mine.every((m) => S.isEx(m.linz.name))) continue;   // every LINZ suburb it maps to was excluded
    prov.push(r); }
  for (const c of done) { const S = D2[c], have = new Set(prov.map((r) => norm(r.M_SUBURB)));
    const studies = S.s && S.s.rows.length && !(BATCH.files.provider || []).length ? S.pairs.map((m) => m.mname) : [];
    for (const n of [...manualFor(c).map((a) => a.name), ...studies]) if (!have.has(norm(n))) { have.add(norm(n));
      prov.push({ M_SUBURB: n, "OTHER SPELLINGS": "", PRVDR: acronymFor(c), M_TERRITORY: taOf(c).name }); } }
  // map: the allocations, one row per study -> LINZ pair
  const mh = hdr("map", ["M_SUBURB", "PROVIDER", "NZ_SUBURB_REF", "M_TERRITORY"]), map = (BATCH.files.map || []).filter((r) => !inDone(rowTAs(r.M_TERRITORY, r.PROVIDER)));
  for (const c of done) { const seen = new Set();
    for (const m of D2[c].pairs) { const k = norm(m.mname) + "|" + norm(m.linz.name); if (seen.has(k)) continue; seen.add(k);
      const old = (BATCH.files.map || []).find((x) => norm(x.M_SUBURB) === norm(m.mname) && norm(x.NZ_SUBURB_REF) === norm(m.linz.name)) || {};
      map.push({ ...old, M_SUBURB: m.mname, PROVIDER: old.PROVIDER || (m.row && m.row.code) || acronymFor(c), NZ_SUBURB_REF: m.linz.name, M_TERRITORY: old.M_TERRITORY || taOf(c).name }); } }
  // ref: the LINZ suburbs to load
  const rh = hdr("ref", ["M_SUBURB", "TYPE", "M_TERRITORY", "M_SUBURB_HH_COUNT"]), ref = (BATCH.files.ref || []).filter((r) => !inDone(rowTAs(r.M_TERRITORY, r.PRVDR || r.PROVIDER)));
  for (const c of done) for (const m of D2[c].matched) { const old = (BATCH.files.ref || []).find((x) => norm(x.M_SUBURB) === norm(m.linz.name)) || {};
    ref.push({ ...old, M_SUBURB: m.linz.name, TYPE: old.TYPE || m.linz.type || "", M_TERRITORY: old.M_TERRITORY || taOf(c).name }); }
  const ensure = (h, extra) => extra.reduce((a, x) => a.some((y) => y.toUpperCase() === x) ? a : [...a, x], h);
  const out = {
    provider: { rows: write(ensure(ph, (prov.some((r) => r.M_TERRITORY) && !ph.some((h) => h.toUpperCase() === "M_TERRITORY")) ? ["M_TERRITORY"] : []), prov), n: prov.length },
    map: { rows: write(mh, map), n: map.length }, ref: { rows: write(rh, ref), n: ref.length } };
  return { out, done, skip };
}
function downloadRefined(k) {
  const { out } = refinedFiles(), names = { provider: "nz_suburb_provider.csv", map: "nz_suburb_map.csv", ref: "nz_suburb_ref.csv" };
  const ks = k === "all" ? ["provider", "map", "ref"] : [k], made = {};
  ks.forEach((x, i) => { const n = versionName(BATCH.fileNames[x], names[x]); made[x] = n; setTimeout(() => download(n, csv(out[x].rows, (BATCH.files[x] && BATCH.files[x].sep) || ",")), i * 400); });
  if (k === "all") setTimeout(() => exportBuilder(made), ks.length * 400);
  toastMsg(`Saved ${Object.values(made).join(", ")}${k === "all" ? " and a builder config pointing to them" : ""}`);
}
function refinedHTML() {
  const { out, done, skip } = refinedFiles();
  return `<div class="card" style="margin-top:12px"><h3>Refined input files</h3>
    <p class="small muted">Your refinements (mappings, exclusions, added study suburbs) for ${done.length ? done.map((c) => esc(taOf(c).name)).join(", ") : "no TA yet"}, merged into your files and saved as <b>new versions</b>: the originals are never overwritten. Other TAs' rows and extra columns are kept.${skip.length ? ` Load LINZ suburbs for ${skip.map((c) => esc(taOf(c).name)).join(", ")} to include them.` : ""}</p>
    <div class="row" style="gap:6px">${[["provider", "nz_suburb_provider", "study scope"], ["map", "nz_suburb_map", "allocations"], ["ref", "nz_suburb_ref", "LINZ reference"]].map(([k, f, w]) =>
      `<button class="btn" type="button" data-refined="${k}" ${done.length ? "" : "disabled"}>${f} (${w}, ${out[k].n} rows)</button>`).join("")}
      <button class="btn primary" type="button" data-refined="all" ${done.length ? "" : "disabled"}>All three + builder config</button></div></div>`;
}

// ---------------------------------------------------------------- builder config (suburb_lookup.html, version 1)
function builderNote() {
  const b = BATCH.builder; if (!b) return "";
  const roles = { suburb_map: "map", suburb_ref: "ref", suburb_provider: "provider" };
  const want = (b.inputs || []).filter((i) => roles[i.role]);
  return `<br><span class="tag info">${esc(b.fname)}</span> ${Object.keys(b.prvdrMatches || {}).length} PRVDR matches, ${(b.suburbAllocations || []).length} allocations.
    ${want.length ? `Lists it expects: ${want.map((i) => `${esc(i.file.split(/[\\/]/).pop())} ${BATCH.files[roles[i.role]] ? '<span class="tag ok">loaded</span>' : '<span class="tag warn">add it above</span>'}`).join(", ")}` : ""}`;
}
function importBuilder(c, fname) {
  if (!c || typeof c !== "object" || !Array.isArray(c.inputs)) throw new Error(`${fname} is not a NZ Suburb Reference Builder config (no inputs list)`);
  const st = c.settings || {}; if (st.keepMode === "any" || st.keepMode === "both") { BATCH.keep = st.keepMode; store.set("batch-keep", st.keepMode); }
  let bad = 0;
  if (c.prvdrMatches && typeof c.prvdrMatches === "object") for (const [k, v] of Object.entries(c.prvdrMatches)) { const p = prvdrCode(v); p ? BATCH.matches[norm(k)] = p : bad++; }
  let n = 0;
  for (const a of c.suburbAllocations || []) {
    if (!a || !a.file || !a.name) continue;
    const targets = Array.isArray(a.linzSuburbs) ? a.linzSuburbs.filter((t) => t && t.name).map((t) => ({ name: t.name, territory: t.territory || "" })) : a.linzSuburb ? [{ name: a.linzSuburb, territory: a.linzTerritory || "" }] : [];
    if (targets.length) { BATCH.alloc[allocKey(a.file, a.name, a.territory || "")] = { file: a.file, name: a.name, territory: a.territory || "", linzSuburbs: targets }; n++; }
  }
  if (c.suburbPicks && typeof c.suburbPicks === "object") for (const [tn, P] of Object.entries(c.suburbPicks)) for (const code of rowTAs(tn)) BATCH.picks[code] = { add: [...(P.add || [])], ex: [...(P.ex || [])] };
  const extra = importStudy(c.study);
  BATCH.builder = { ...c, fname }; BATCH.valid = {}; saveSel();
  return `Loaded ${fname}: ${Object.keys(c.prvdrMatches || {}).length - bad} PRVDR matches${bad ? ` (${bad} matched no saved provider)` : ""}, ${n} allocations, keep rule "${BATCH.keep}"${extra}`;
}
// everything this app adds to a builder config: selection, PRVDRs, timelines (dates and census years), scope, picks and the
// study -> LINZ mappings per TA. The reference builder ignores this section; importing it here restores the study.
function studyExport() {
  const sel = [...BATCH.sel].sort(), sc = scopeByTA();
  const tl = (t) => ({ weatherFrom: t.climate_start || CLIMATE_FROM, weatherTo: t.climate_end || "latest", censusYears: (t.census_years || CENSUS_YEARS).map(Number) });
  // your list files travel with the exported config (in this file only, never stored in the database)
  const files = Object.fromEntries(["provider", "map", "ref"].filter((k) => (BATCH.files[k] || []).length).map((k) => { const rows = BATCH.files[k], hs = rows.headers || Object.keys(rows[0] || {});
    return [k, { name: BATCH.fileNames[k] || `nz_suburb_${k}.csv`, sep: rows.sep || ",", headers: hs, rows: rows.map((r) => hs.map((h) => r[h.toUpperCase()] ?? "")) }]; }));
  return { app: "NZ Suburb Water Profiles", version: 1, exported: new Date().toISOString(), name: BATCH.config ? BATCH.config.name : null, configId: BATCH.config ? BATCH.config.id : null, keepMode: BATCH.keep, files,
    timelineTemplate: tl(tlOf("_all")),
    territorialAuthorities: sel.map((c) => { const f = filePrvdr(c), S = BATCH.linz[c] ? scopeOf(c) : null;
      return { code: c, name: taOf(c).name, prvdr: prvdrFor(c), prvdrName: (BATCH.providers.find((p) => p.prvdr === prvdrFor(c)) || {}).name || null,
        prvdrChosen: !!BATCH.prvdr[c], prvdrSource: prvdrSource(c), fileAcronyms: f ? f.acronyms : [], unmatchedCodes: f ? f.unresolved : [],
        timeline: tl(tlOf(c)), scopeBasis: sc[c] ? sc[c].basis : "whole TA", suburbsInScope: sc[c] ? sc[c].keep : [],
        picks: BATCH.picks[c] || { add: [], ex: [] },
        mappings: S ? [...new Map(S.allPairs.map((m) => [`${m.mname}|${m.linz.name}`, { study: m.mname, linz: m.linz.name, how: m.manual ? "added" : m.allocated ? "allocated" : "name match", excluded: S.isEx(m.linz.name) }])).values()] : null,
        linzSuburbsToLoad: S ? S.matched.map((m) => m.linz.name) : null }; }) };
}
function importStudy(st) {
  if (!st || !Array.isArray(st.territorialAuthorities)) return "";
  // list files carried in the config
  let nf = 0;
  for (const [k, f] of Object.entries(st.files || {})) { if (!["provider", "map", "ref"].includes(k) || !f || !Array.isArray(f.headers) || !Array.isArray(f.rows)) continue;
    const H = f.headers.map((h) => String(h).trim().toUpperCase()), rows = f.rows.map((r) => Object.fromEntries(H.map((h, i) => [h, String(r[i] ?? "").trim()])));
    rows.headers = f.headers; rows.sep = f.sep || ","; BATCH.files[k] = rows; BATCH.fileNames[k] = f.name || `nz_suburb_${k}.csv`; nf++; }
  if (nf) { BATCH.savedScope = null; BATCH.rev++; }
  // the saved configuration (study) this config belongs to, if it is yours
  const match = (STUDY.list || []).find((x) => st.configId != null && String(x.id) === String(st.configId)) || (st.name ? (STUDY.list || []).find((x) => x.name === st.name) : null);
  if (match) { BATCH.config = { id: match.id, name: match.name }; STUDY.id = String(match.id); store.set("study", STUDY.id); setTimeout(renderHeader, 0); }
  const tlIn = (t) => { if (!t) return {}; const o = {}; if (t.weatherFrom && t.weatherFrom !== CLIMATE_FROM) o.climate_start = t.weatherFrom; if (t.weatherTo && t.weatherTo !== "latest") o.climate_end = t.weatherTo;
    if (Array.isArray(t.censusYears) && t.censusYears.length) o.census_years = CENSUS_YEARS.filter((y) => t.censusYears.map(String).includes(y)); return o; };
  BATCH.sel = new Set(st.territorialAuthorities.map((t) => t.code).filter((c) => taOf(c).code));
  for (const t of st.territorialAuthorities) { if (!taOf(t.code).code) continue;
    if (t.prvdr) { BATCH.cfgPrvdr[t.code] = t.prvdr; if (t.prvdrChosen) BATCH.prvdr[t.code] = t.prvdr; }
    BATCH.tl[t.code] = tlIn(t.timeline);
    if (t.picks && (t.picks.add || t.picks.ex)) BATCH.picks[t.code] = { add: [...(t.picks.add || [])], ex: [...(t.picks.ex || [])] };
    if (Array.isArray(t.suburbsInScope) && t.suburbsInScope.length) BATCH.savedScope = { ...(BATCH.savedScope || {}), [t.code]: t.suburbsInScope }; }
  if (st.timelineTemplate) BATCH.tl._all = tlIn(st.timelineTemplate);
  if (st.keepMode === "any" || st.keepMode === "both") { BATCH.keep = st.keepMode; store.set("batch-keep", st.keepMode); }
  return `; ${BATCH.sel.size} TA(s) with PRVDRs, timelines and picks${nf ? `; ${nf} list file(s)` : ""}${match ? `; study "${match.name}" selected` : st.name ? ` (study "${st.name}" not among your saved configurations)` : ""}`;
}
function exportBuilder(made) {
  const b = BATCH.builder || {}, roles = { map: "suburb_map", ref: "suburb_ref", provider: "suburb_provider" };
  const inputs = (b.inputs || []).filter((i) => !Object.values(roles).includes(i.role) || !((made && made[Object.keys(roles).find((k) => roles[k] === i.role)]) || BATCH.fileNames[Object.keys(roles).find((k) => roles[k] === i.role)]));
  for (const [k, r] of Object.entries(roles)) if ((made && made[k]) || BATCH.fileNames[k]) inputs.push({ role: r, file: (made && made[k]) || BATCH.fileNames[k] });
  const nameOf = (code) => (BATCH.providers.find((p) => p.prvdr === code) || {}).name || code;
  const out = { ...b, tool: "NZ Suburb Reference Builder", version: 1, saved: new Date().toISOString().slice(0, 10), inputs,
    settings: { ...(b.settings || {}), keepMode: BATCH.keep },
    prvdrMatches: Object.fromEntries(Object.entries(BATCH.matches).map(([k, v]) => [k.toUpperCase(), nameOf(v)])),
    suburbAllocations: Object.values(BATCH.alloc).map((a) => ({ file: a.file, name: a.name, territory: a.territory || "", linzSuburbs: a.linzSuburbs })),
    suburbPicks: Object.fromEntries(Object.entries(BATCH.picks).map(([c, P]) => [taOf(c).name || c, P])),
    study: studyExport() };
  delete out.fname;
  download(made ? versionName(b.fname, "nz_suburb_builder_config.json").replace(/\.csv$/, ".json") : "nz_suburb_builder_config.json", JSON.stringify(out, null, 2) + "\n");
}

// ---------------------------------------------------------------- 4. validate suburbs
function lev(a, b) { if (a === b) return 0; const m = a.length, n = b.length; if (!m || !n) return m || n; let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) { const cur = [i]; for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; } return prev[n]; }
function similar(a, list) { const k = mkey(a); if (!k) return [];
  return list.map((x) => { const m = mkey(x), d = lev(k, m), r = 1 - d / Math.max(k.length, m.length), c = m.includes(k) || k.includes(m) ? 0.25 : 0, w = k.split(" ").some((t) => t.length > 3 && m.split(" ").includes(t)) ? 0.15 : 0;
    return [x, r + c + w]; }).filter(([, sc]) => sc >= 0.55).sort((p, q) => q[1] - p[1]).slice(0, 3).map(([x]) => x); }
function similar_old(a, list) { const n = norm(a); return list.filter((x) => { const m = norm(x); return m.startsWith(n.slice(0, 4)) || n.startsWith(m.slice(0, 4)) || m.includes(n) || n.includes(m); }).slice(0, 3); }
async function validateAll() {
  const sel = [...BATCH.sel].sort().filter((c) => !(stage === "load" && BATCH.valid[c] && BATCH.valid[c].status === "done"));
  for (const c of sel) {
    BATCH.valid[c] = { status: "checking" }; drawBatch();
    try {
      const L = await ensureLinz(c), S = scopeOf(c);
      BATCH.valid[c] = { status: "done", linz: L.list, matched: S.matched, pairs: S.pairs, unmatched: S.unmatched, excluded: S.excluded.length, scoped: S.scoped, cached: L.cached, requests: L.requests || 0 };
    } catch (err) { BATCH.valid[c] = { status: "error", message: err.message }; }
    drawBatch();
  }
  if (!BATCH.vTA) BATCH.vTA = sel[0]; drawBatch();
}
function validateHTML() {
  const sel = [...BATCH.sel].sort(); if (!sel.length) return `<p class="muted">Select TAs in 2.1 Inputs and TAs first.</p>`;
  const v = BATCH.valid, done = sel.every((c) => v[c] && v[c].status === "done");
  const rows = sel.map((c) => { const t = taOf(c), r = v[c];
    const st = !r ? '<span class="muted">not checked</span>' : r.status === "checking" ? '<span class="tag warn">checking…</span>' : r.status === "error" ? `<span class="tag bad">${esc(r.message)}</span>`
      : r.scoped ? `<span class="tag ${r.unmatched.length ? "warn" : "ok"}">${r.matched.length} to load${r.unmatched.length ? `, ${r.unmatched.length} not found` : ""}${r.excluded ? `, ${r.excluded} excluded` : ""}</span>` : `<span class="tag ok">whole TA: ${r.linz.length} suburbs</span>`;
    return `<tr data-vta="${c}" style="cursor:pointer${BATCH.vTA === c ? ";background:var(--accent-soft)" : ""}"><td class="l">${esc(t.name)}</td><td class="l">${st}</td><td class="small muted">${r && r.status === "done" ? (r.cached ? "from shared cache" : `${r.requests} LINZ request`) : ""}</td></tr>`; }).join("");
  const c = BATCH.vTA && sel.includes(BATCH.vTA) ? BATCH.vTA : sel[0], r = v[c], t = taOf(c);
  let detail = `<p class="muted">Press <b>Validate suburbs</b>.</p>`;
  if (r && r.status === "done") {
    const ids = new Set(r.matched.map((m) => m.linz.id)), scoped = r.scoped;
    const layers = [{ d: pathD(t.geom.coordinates), fill: "var(--land)", stroke: "var(--ink)", sw: 1.4, title: t.name },
      ...r.linz.map((x) => ({ d: pathD(x.geom.coordinates), fill: !scoped || ids.has(x.id) ? "var(--accent)" : "var(--land)", op: !scoped || ids.has(x.id) ? 0.65 : 0.6, sw: 0.8, title: `${x.name}${scoped && !ids.has(x.id) ? " (not in scope)" : ""}` }))];
    detail = `<div class="grid g2"><div class="card">${zoomMap("val-" + c, layers, mapBox([t.geom.coordinates]))}<p class="small muted" style="margin:6px 0 0">Blue = suburbs that will be loaded${scoped ? "; grey = LINZ suburbs not in your lists" : ""}.</p></div>
      <div class="card scroll"><h3>${esc(t.name)}</h3>
      ${scoped ? `<p class="small"><b>${r.matched.length}</b> suburbs to load${r.excluded ? `, ${r.excluded} excluded in 2.2` : ""}.</p>
        ${r.unmatched.length ? `<p class="small"><span class="tag warn">Not found in LINZ</span> ${r.unmatched.map((n) => { const sug = similar(n, r.linz.map((x) => x.name)); return `<br>· ${esc(n)}${sug.length ? ` <span class="muted">→ did you mean ${sug.map(esc).join(", ")}?</span>` : ""}`; }).join("")}</p>
        <p class="small muted">Allocate them in <button class="btn" type="button" data-btab="allocate" style="padding:1px 6px">2.2 Allocate</button>, or fix the names in your list. Names not found aren't loaded.</p>` : ""}
        <table><thead><tr><th class="l">Your name</th><th class="l">LINZ suburb</th><th class="l">Type</th></tr></thead><tbody>${r.matched.map((m) => `<tr><td class="l">${esc(m.input)}</td><td class="l">${esc(m.linz.name)}${m.allocated ? ' <span class="tag info">allocated</span>' : m.added ? ' <span class="tag info">added</span>' : ""}</td><td class="l small">${esc(m.linz.type || "")}</td></tr>`).join("")}</tbody></table>`
      : `<p class="small">No suburb list for this TA: all ${r.linz.length} LINZ suburbs and localities will be loaded${t.parts > 1 ? ', <span class="tag bad">too large: add a suburb list</span>' : ""}.</p>`}</div></div>`;
  }
  return `<div class="card"><div class="row" style="justify-content:space-between"><h3 style="margin:0">Suburbs in scope, checked against LINZ</h3>
    ${can("editor") ? '<button class="btn primary" id="validate-go" type="button">Validate suburbs</button>' : lock("editor", "Validation")}</div>
    <p class="small muted">Each TA's LINZ suburbs are fetched once and cached for everyone, so validating again, or later, makes no request. Allocated rows count as matched. Click a row to see it on the map.</p>
    <table><tbody>${rows}</tbody></table>
    ${done ? '<div class="row" style="margin-top:8px"><button class="btn primary" type="button" data-btab="load">Next: 3 Load →</button></div>' : ""}</div>
  <div class="row" style="margin-top:16px;justify-content:space-between"><h2 style="margin:0">${esc(t.name || "")} <span class="small muted">· ${esc(prvdrFor(c))}</span></h2>${taNav(c, "data-vta")}</div>${detail}${refinedHTML()}`;
}

// ---------------------------------------------------------------- 5. load
function loadHTML() {
  if (can("editor")) setTimeout(() => { if (!PROG.at || Date.now() - PROG.at > 5000) refreshProgress(); else scheduleProgress(); }, 0);
  const sel = [...BATCH.sel].sort(), v = BATCH.valid, ix = Object.fromEntries((D.index_regions || []).map((r) => [r.TA_CODE, r]));
  const notReady = sel.filter((c) => !(v[c] && v[c].status === "done"));
  const blocked = sel.filter((c) => v[c] && v[c].status === "done" && ((v[c].scoped && !v[c].matched.length) || (!v[c].scoped && taOf(c).parts > 1)));
  const ready = sel.filter((c) => !notReady.includes(c) && !blocked.includes(c));
  const why = (c) => { const r = v[c]; if (!r) return "not validated yet"; if (r.status === "checking") return "validating…"; if (r.status === "error") return "validation failed: " + r.message;
    if (r.scoped && !r.matched.length) return "no suburbs to load (none matched or all excluded)"; if (!r.scoped && taOf(c).parts > 1) return "too large without a suburb list"; return ""; };
  const budget = (((D.limits || {}).defaults || {}).openmeteo || {}).budget_day || 6000;
  const fullDays = (new Date(latestDay()) - new Date(CLIMATE_FROM)) / 864e5 + 1;   // the index estimates assume weather from 2013
  const tot = sel.reduce((t, c) => t + (+((ix[c] || {}).EST_OPENMETEO_CALLS_PER_PART) || 0) * (v[c] && v[c].scoped ? 0.5 : 1) * (tlDays(c) / fullDays), 0);
  return `<div class="card"><h3>Ready to load</h3>
    <table><thead><tr><th class="l">TA</th><th class="l">PRVDR</th><th>Suburbs to load</th><th class="l">Status</th></tr></thead><tbody>${sel.map((c) => { const r = v[c];
      return `<tr><td class="l">${esc(taOf(c).name)}</td><td class="l">${esc(prvdrFor(c))}</td><td>${r && r.status === "done" ? (r.scoped ? r.matched.length : r.linz.length) : "–"}</td>
        <td class="l" style="white-space:normal">${ready.includes(c) ? '<span class="tag ok">ready</span>' : `<span class="tag ${notReady.includes(c) ? "warn" : "bad"}">${esc(why(c))}</span>`}</td></tr>`; }).join("")}</tbody></table>
    <p class="small muted">Estimated Open-Meteo use ≈ ${fmt(tot)} weighted calls (budget ${fmt(budget)}/day) → about ${Math.max(1, Math.ceil(tot / budget))} day(s), plus imagery time. Only validated LINZ suburbs are loaded.</p>
    ${can("editor") ? `<div class="row" style="gap:8px;align-items:center"><button class="btn primary" id="batch-queue" type="button" ${ready.length ? "" : "disabled"}>Queue batch (${ready.length} region${ready.length === 1 ? "" : "s"})</button>
      ${notReady.length ? `<button class="btn" type="button" id="load-validate">Validate the rest (${notReady.length})</button>` : ""}
      ${!ready.length ? `<span class="small muted">${sel.length ? "Nothing is ready yet: validate the TAs (2.3) first." : "Select TAs in 2.1 first."}</span>` : ready.length < sel.length ? `<span class="small muted">${sel.length - ready.length} TA(s) aren't ready and won't be queued.</span>` : ""}</div>
    <div id="batch-progress">${progressLive()}</div>` : lock("editor", "Queuing batches")}</div>
  ${can("editor") ? progressHTML() + regionJobsHTML() : ""}
  <div style="margin-top:20px">${detailedOverviewHTML()}</div>`;
}
// moved from 1 Region: refresh jobs for a region already in the database, job progress, and download rates / usage
function regionJobsHTML() {
  setTimeout(() => { if (typeof refreshJobs === "function") refreshJobs().catch(() => {}); }, 0);
  const regs = (D.index || []).map((r) => [r.id, { label: r.name }]);
  return `<h2>Refresh a region in the database</h2><div class="grid g2"><div class="card">
    ${regs.length ? `<p class="small"><label>Region <select id="rj-region">${regs.map(([k, g]) => `<option value="${esc(k)}" ${k === region ? "selected" : ""}>${esc(g.label)}</option>`).join("")}</select></label></p>
    <div class="row small">${[["imagery", "Imagery: pools and gardens (search again)", false], ["climate", "Climate top-up", true], ["census", "Census", true], ["publish", "Recompute metrics", true]].map(([v, l, on]) => `<label><input type="checkbox" data-step value="${v}" ${on ? "checked" : ""}> ${l}</label>`).join("")}</div>
    <p class="small" style="margin:8px 0 4px"><b>Timeline</b> <span class="muted">for this region (saved to the database)</span></p><div id="rj-tl">${tlEditor("r:" + region)}</div>
    <div class="row" style="margin-top:6px"><button class="btn primary" id="queue-live" type="button">Queue job</button><button class="btn" type="button" id="rj-refresh">Refresh</button></div>
    <p class="small muted">One region per job, run by the worker (GitHub Actions) within each service's free-tier budget. Data already stored, by anyone, is reused.</p>
    <div id="jobs" style="margin-top:8px"></div>` : '<p class="small muted">No regions with data yet.</p>'}</div>
    <div class="card"><h3>Download rates and today's usage</h3><div id="dl-panel"><p class="small muted">Loading…</p></div></div></div>`;
}
document.addEventListener("change", (e) => { if (e.target.id === "rj-region") { region = e.target.value; store.set("region", region); refreshJobs(); const el = $("#rj-tl"); if (el) el.innerHTML = tlEditor("r:" + region); } });
document.addEventListener("click", (e) => { if (e.target.id === "rj-refresh") refreshJobs(); });
// ---------------------------------------------------------------- live progress of your batches (under Queue batch)
// Refreshed every ~15 s while jobs are active and the page is visible; only the panel is redrawn.
const PROG = { jobs: [], runs: [], batches: [], at: null, timer: null, busy: false };
const ACTIVE = new Set(["queued", "scheduled", "running", "paused_quota"]);
async function refreshProgress() {
  if (!can("editor") || PROG.busy) return; PROG.busy = true;
  try {
    PROG.batches = await q(sb.from("batches").select("id,name,ta_codes,status,created_at").order("id", { ascending: false }).limit(5));
    const ids = PROG.batches.map((b) => b.id);
    PROG.jobs = ids.length ? await q(sb.from("jobs").select("id,region_id,status,reason,batch_id,params,not_before,created_at,finished_at").in("batch_id", ids).order("id")) : [];
    const jids = PROG.jobs.map((j) => j.id);
    PROG.runs = jids.length ? await q(sb.from("job_runs").select("job_id,step,status,log,started_at,progress,detail,updated_at").in("job_id", jids).order("id")) : [];
    PROG.at = new Date();
  } catch (e) { PROG.err = e.message; } finally { PROG.busy = false; }
  const el = $("#batch-progress"); if (el) el.innerHTML = progressLive();
  scheduleProgress();
}
function scheduleProgress() {
  clearTimeout(PROG.timer);
  if (stage !== "load" || !PROG.jobs.some((j) => ACTIVE.has(j.status))) return;
  const fast = PROG.jobs.some((j) => j.status === "running");   // poll faster while a step is running
  PROG.timer = setTimeout(() => { if (stage === "load" && (typeof document.visibilityState === "undefined" || document.visibilityState === "visible")) refreshProgress(); else scheduleProgress(); }, fast ? 8000 : 15000);
}
// ask for a worker run now (GitHub's schedule is best-effort); harmless if one is running or was just requested
async function kickWorker(quiet) {
  try { const { data, error } = await sb.functions.invoke("kick-worker", { body: {} }); if (error) throw error;
    PROG.kick = data || {}; if (!quiet || (data && data.started)) toastMsg((data && data.message) || "Worker requested"); }
  catch (e) { PROG.kick = { error: e.message }; if (!quiet) toastMsg("Couldn't start the worker: " + e.message); }
  const el = $("#batch-progress"); if (el) el.innerHTML = progressLive();
}
const nextWorkerRun = () => { const d = new Date(), m = d.getUTCMinutes(), add = 15 - (m % 15); return new Date(d.getTime() + add * 60000 - d.getUTCSeconds() * 1000); };
// live detail of a job: the running step's progress bar, latest line, heartbeat and recent lines
const ago = (t) => { const s = Math.max(0, Math.round((Date.now() - new Date(t).getTime()) / 1000)); return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`; };
function runDetail(j, lr) {
  if (!lr) return esc(j.reason || (j.status === "queued" ? "waiting for the worker" : ""));
  const lines = String(lr.detail || "").split("\n").filter(Boolean), last = lines[lines.length - 1] || String(lr.log || "").split("\n").pop();
  const live = lr.status === "running", pct = lr.progress != null ? Math.round(100 * lr.progress) : null;
  const stale = live && lr.updated_at && Date.now() - new Date(lr.updated_at).getTime() > 10 * 60000;
  return `${live ? `<b>${esc(lr.step.replace("_", " "))}</b>${pct != null ? ` ${pct}%` : ""}${pct != null ? `<div class="bar-out" style="height:5px;margin:2px 0;max-width:220px"><div class="bar-in" style="width:${pct}%"></div></div>` : " "}` : ""}
    ${esc(j.reason && !live ? j.reason : String(last || "").replace(/^\d\d:\d\d:\d\d /, "").slice(0, 160))}
    ${live && lr.updated_at ? `<span class="${stale ? "tag warn" : ""}" style="font-size:11px"> · ${stale ? "no update for " : "updated "}${ago(lr.updated_at)}${stale ? " (may be waiting on a rate limit)" : ""}</span>` : ""}
    ${lines.length > 1 ? `<details style="margin-top:2px"><summary style="cursor:pointer;font-size:11px">details (${lines.length} lines)</summary><pre style="white-space:pre-wrap;font-size:11px;margin:2px 0;max-height:160px;overflow:auto">${esc(lines.join("\n"))}</pre></details>` : ""}`;
}
function progressLive() {
  if (!PROG.at) return `<p class="small muted" style="margin:8px 0 0">Loading batch progress…</p>`;
  const shown = PROG.batches.filter((b, i) => i === 0 || PROG.jobs.some((j) => j.batch_id === b.id && ACTIVE.has(j.status)));
  if (!shown.length) return `<p class="small muted" style="margin:8px 0 0">No batches yet. Queued batches show their progress here.</p>`;
  const icon = { done: "✓", running: "⏳", failed: "✗", paused_quota: "⏸", skipped: "–" }, col = { done: "var(--ok, #2e7d32)", running: "#b26a00", failed: "var(--bad, #b3261e)", paused_quota: "#7a5195" };
  const tag = (s) => `<span class="tag ${s === "done" ? "ok" : s === "failed" ? "bad" : s === "running" ? "warn" : "info"}">${esc(s === "paused_quota" ? "paused (daily limit)" : s)}</span>`;
  const anyActive = PROG.jobs.some((j) => ACTIVE.has(j.status));
  return `<div style="margin-top:10px;border-top:1px solid var(--line);padding-top:8px"><div class="row small" style="justify-content:space-between"><b>Batch progress</b>
      <span class="muted">${anyActive ? `updates every 15 s · the worker runs every 15 minutes (next ≈ ${nextWorkerRun().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}) · ` : ""}updated ${PROG.at.toLocaleTimeString()} <button class="btn" type="button" id="prog-refresh" style="padding:0 6px">↻</button></span></div>
    ${anyActive ? `<p class="small muted" style="margin:2px 0 0">Batches run on the server (GitHub Actions worker), not in this page: refreshing or closing it doesn't interrupt them.
      <button class="btn" type="button" id="kick-worker" style="padding:0 8px">▶ Run worker now</button> ${PROG.kick ? esc(PROG.kick.message || PROG.kick.error || "") : ""}</p>` : ""}
    ${PROG.err ? `<p class="small"><span class="tag bad">${esc(PROG.err)}</span></p>` : ""}
    ${shown.map((b) => { const jobs = PROG.jobs.filter((j) => j.batch_id === b.id);
      const per = jobs.map((j) => { const steps = (j.params && j.params.steps) || [], runs = PROG.runs.filter((r) => r.job_id === j.id), last = Object.fromEntries(runs.map((r) => [r.step, r]));
        const done = steps.filter((st) => last[st] && (last[st].status === "done" || last[st].status === "skipped")).length; return { j, steps, last, runs, done }; });
      const tot = per.reduce((t, p) => t + Math.max(1, p.steps.length), 0), dn = per.reduce((t, p) => t + (p.j.status === "done" ? Math.max(1, p.steps.length) : p.done), 0), pct = tot ? Math.round(100 * dn / tot) : 0;
      const failed = jobs.filter((j) => j.status === "failed");
      return `<div style="margin:8px 0"><div class="row small" style="justify-content:space-between"><span><b>${esc(b.name || "Batch " + b.id)}</b> <span class="muted">${esc(new Date(b.created_at).toLocaleString())}</span></span><span>${pct}% · ${jobs.filter((j) => j.status === "done").length}/${jobs.length} regions done${failed.length ? ` · <button class="btn" type="button" data-retry-batch="${b.id}" style="padding:0 8px" title="Queue the failed regions again (finished steps are skipped) and start the worker">↻ Retry failed (${failed.length})</button>` : ""}</span></div>
        <div class="bar-out" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Batch progress" style="height:8px;margin:4px 0"><div class="bar-in" style="width:${pct}%"></div></div>
        <table class="small" style="width:100%"><tbody>${per.map(({ j, steps, last, runs }) => { const reg = (BATCH.regions.find((r) => r.id === j.region_id) || {}).name || j.region_id, lr = runs[runs.length - 1];
          const lastAct = lr ? (lr.updated_at || lr.started_at) : j.created_at, stalled = j.status === "running" && lastAct && Date.now() - new Date(lastAct).getTime() > 20 * 60000;
          return `<tr><td class="l" style="width:28%">${esc(reg)}</td><td class="l">${tag(j.status)}${j.status === "failed" || stalled ? ` <button class="btn" type="button" data-restart-job="${j.id}" style="padding:0 6px" title="${stalled ? "No activity for over 20 minutes: queue it again" : "Queue it again"} (finished steps are skipped) and start the worker">↻ Restart</button>` : ""}</td>
            <td class="l">${steps.map((st) => { const r = last[st], stt = r ? r.status : "pending"; return `<span title="${esc(st)}: ${esc(stt)}${r && r.log ? " · " + esc(String(r.log).slice(0, 160)) : ""}" style="display:inline-block;margin:0 3px 0 0;color:${col[stt] || "var(--muted, #888)"}">${icon[stt] || "○"} ${esc(st.replace("_", " "))}</span>`; }).join("")}</td>
            <td class="l muted" style="white-space:normal;max-width:340px">${j.status === "paused_quota" && j.not_before ? `resumes after ${esc(new Date(j.not_before).toLocaleString())}. ` : ""}${runDetail(j, lr)}</td></tr>`; }).join("")}</tbody></table></div>`; }).join("")}</div>`;
}
function progressHTML() {
  if (!BATCH.batches.length) return `<h2>Your batches</h2><p class="muted small">No batches yet.</p>`;
  const tag = (s) => `<span class="tag ${s === "done" ? "ok" : s === "failed" ? "bad" : s === "running" ? "warn" : "info"}">${esc(s)}</span>`;
  return `<h2>Your batches</h2>${BATCH.batches.map((b) => { const regs = BATCH.regions.filter((r) => r.batch_id === b.id);
    return `<div class="card" style="margin-bottom:10px"><div class="row" style="justify-content:space-between"><b>${esc(b.name || "Batch " + b.id)}</b><span class="small muted">${esc(new Date(b.created_at).toLocaleString())}</span></div>
    <table><tbody>${regs.map((r) => { const j = BATCH.jobs.find((x) => x.region_id === r.id); return `<tr><td class="l">${esc(r.name)} <span class="muted small">${esc(r.prvdr || "")}</span></td>
      <td>${j ? tag(j.status) : "–"}</td><td class="l small muted" style="white-space:normal">${esc(j && j.reason || "")}</td>
      <td>${r.status === "published" ? '<span class="tag ok">published</span>' : j && j.status === "done" ? `<button class="btn" data-publish="${r.id}" type="button">Publish</button>` : `<span class="tag info">${esc(r.status)}</span>`}</td></tr>`; }).join("")}</tbody></table>
    <div class="row" style="margin-top:8px"><button class="btn" data-tiles="${b.id}" type="button">Download tile list (CSV)</button><button class="btn" type="button" id="batch-refresh">Refresh</button></div></div>`; }).join("")}`;
}
async function queueBatch() {
  const sc = scopeByTA(), v = BATCH.valid;
  // only TAs that are validated and have something to load
  const sel = [...BATCH.sel].sort().filter((c) => v[c] && v[c].status === "done" && !((v[c].scoped && !v[c].matched.length) || (!v[c].scoped && taOf(c).parts > 1)));
  if (!sel.length) return toastMsg("Nothing is ready to queue: validate the TAs first");
  const [b] = await q(sb.from("batches").insert({ name: `${BATCH.config ? BATCH.config.name + " · " : ""}${sel.length} region(s), ${new Date().toLocaleDateString("en-NZ")}`, ta_codes: sel, keep_mode: BATCH.keep }).select("id"));
  for (const c of sel) {
    const t = taOf(c), r = v[c], s = sc[c], p = prvdrFor(c);
    const existing = BATCH.regions.find((x) => x.ta_code === c); const id = existing ? existing.id : "ta-" + c;
    const scope = r.scoped ? [...new Set(r.matched.map((m) => m.linz.name))] : null;
    await q(sb.from("regions").upsert({ id, name: t.name + (scope ? ` (${scope.length} suburbs)` : ""), territorial_authorities: [t.name], ta_code: c, scope, prvdr: p, timeline: tlFor(c), status: existing ? existing.status : "draft", batch_id: b.id }));
    const pairs = (r.pairs || []).filter((m) => m.row || m.manual);
    if (pairs.length || (s && s.rows.length)) {
      const old = await q(sb.from("m_suburbs").select("id").eq("region_id", id).not("source_file", "is", null));
      if (old.length) await q(sb.from("m_suburbs").delete().in("id", old.map((o) => o.id)));
      const rows = [...new Map(pairs.map((m) => { const x = m.row || {};
        return [`${norm(m.mname)}|${norm(m.linz.name)}`, { region_id: id, m_suburb: m.mname, m_territory: x.territory || t.name, prvdr: x.prvdr || p, other_spellings: x.spellings || null, linz_ref: m.linz.name, source_file: m.manual ? "allocation" : x.file }]; })).values()];
      if (rows.length) await q(sb.from("m_suburbs").insert(rows));
    }
    await q(sb.from("jobs").insert({ type: "prepare", region_id: id, batch_id: b.id, status: "queued", params: { steps: ["linz", "imagery_index", "imagery", "census", "publish_new", "climate"], timeline: tlFor(c) } }));
  }
  toastMsg(`Queued ${sel.length} region job(s): progress shows below; the worker runs them one at a time`); PROG.at = null; setTimeout(refreshProgress, 0); kickWorker(true);
  await loadBatchData(); drawBatch();
}
// a loaded configuration saves itself shortly after any change (so PRVDRs, mappings, timelines are never lost)
let AUTOSAVE = null;
function autosave() { if (!BATCH.config || !can("editor") || BATCH.saving) return; clearTimeout(AUTOSAVE); BATCH.dirty = true; cfgBarStatus();
  AUTOSAVE = setTimeout(async () => { BATCH.saving = true; try { await q(sb.from("batch_configs").update(configRec(BATCH.config.name)).eq("id", BATCH.config.id)); BATCH.dirty = false; BATCH.savedAt = new Date(); }
    catch (err) { toastMsg("Not saved: " + err.message); } finally { BATCH.saving = false; cfgBarStatus(); } }, 1200); }
function cfgBarStatus() { const el = $("#cfg-bar-status"); if (el) el.textContent = !BATCH.config ? "not saved yet: give it a name and Save" : BATCH.saving ? "saving…" : BATCH.dirty ? "unsaved changes…" : BATCH.savedAt ? `saved ${BATCH.savedAt.toLocaleTimeString()}` : "saved"; }
function configBar() {
  return can("editor") ? `<div class="row small" style="gap:6px;align-items:center;margin:-4px 0 12px;padding:6px 8px;border:1px solid var(--line);border-radius:8px;flex-wrap:wrap">
    <b>Configuration</b><input type="text" id="cfg-bar-name" value="${esc(BATCH.config ? BATCH.config.name : "")}" placeholder="name" style="width:170px" aria-label="Configuration name">
    <button class="btn" type="button" id="cfg-bar-save" style="padding:1px 8px">${BATCH.config ? "Save" : "Save as new"}</button>
    <button class="btn" type="button" id="bcfg-export" style="padding:1px 8px">Export builder config</button>
    <span class="muted" id="cfg-bar-status">${!BATCH.config ? "not saved yet: give it a name and Save" : BATCH.dirty ? "unsaved changes…" : "saved, and saves automatically"}</span></div>` : "";
}
function configRec(name) {
  const sc = scopeByTA(), sel = [...BATCH.sel].sort();
  return { name, ta_codes: sel, keep_mode: BATCH.keep, prvdr_by_ta: Object.fromEntries(sel.map((c) => [c, prvdrFor(c)])),
    scope_by_ta: Object.fromEntries(Object.entries(sc).map(([c, s]) => [c, s.keep])), updated_at: new Date().toISOString(),
    prvdr_manual: Object.keys(BATCH.prvdr).filter((c) => BATCH.sel.has(c)),
    suburb_picks: Object.fromEntries(Object.entries(BATCH.picks).filter(([c]) => BATCH.sel.has(c))),
    timelines: Object.fromEntries(Object.entries(BATCH.tl).filter(([c]) => c === "_all" || BATCH.sel.has(c))),
    prvdr_matches: Object.fromEntries(Object.entries(BATCH.matches).map(([k, v]) => [k.toUpperCase(), v])), allocations: Object.values(BATCH.alloc) };
}
async function saveConfig(nameIn) {
  const name = (nameIn || ($("#cfg-name") || {}).value || "").trim(); if (!name) return toastMsg("Give the configuration a name");
  const rec = configRec(name);
  if (BATCH.config && BATCH.config.name === name) { await q(sb.from("batch_configs").update(rec).eq("id", BATCH.config.id)); }
  else { const [r] = await q(sb.from("batch_configs").insert(rec).select("id")); BATCH.config = { id: r.id, name }; }
  BATCH.dirty = false; BATCH.savedAt = new Date(); toastMsg(`Saved configuration "${name}"`); await loadBatchData(); STUDY.id = String(BATCH.config.id); store.set("study", STUDY.id); loadStudies(); drawBatch();
}
function loadConfig(id) {
  const c = BATCH.configs.find((x) => String(x.id) === String(id));
  if (typeof STUDY !== "undefined") { STUDY.id = c ? String(c.id) : ""; store.set("study", STUDY.id); setTimeout(renderHeader, 0); }
  if (!c) { BATCH.config = null; BATCH.savedScope = null; BATCH.cfgPrvdr = {}; return drawBatch(); }
  BATCH.config = { id: c.id, name: c.name }; BATCH.sel = new Set(c.ta_codes); BATCH.keep = c.keep_mode;
  BATCH.cfgPrvdr = { ...c.prvdr_by_ta }; BATCH.prvdr = Object.fromEntries((c.prvdr_manual || []).filter((k) => c.prvdr_by_ta[k]).map((k) => [k, c.prvdr_by_ta[k]]));
  BATCH.matches = Object.fromEntries(Object.entries(c.prvdr_matches || {}).map(([k, v]) => [norm(k), v]));
  BATCH.alloc = Object.fromEntries((c.allocations || []).map((a) => [allocKey(a.file, a.name, a.territory || ""), a]));
  BATCH.picks = { ...(c.suburb_picks || {}) }; BATCH.tl = { ...(c.timelines || {}) }; migrateTl();
  BATCH.savedScope = c.scope_by_ta || {}; BATCH.files = {}; BATCH.fileNames = {}; BATCH.valid = {}; saveSel(); toastMsg(`Loaded "${c.name}"`); drawBatch();
}
async function tileCSV(batchId) {
  const regs = BATCH.regions.filter((r) => r.batch_id === batchId).map((r) => r.id);
  const rows = regs.length ? await q(sb.from("imagery_tiles").select("region_id,capture_id,tile_id,cog_url,stac_url,processed_at").in("region_id", regs).order("region_id")) : [];
  if (!rows.length) return toastMsg("No tiles indexed yet: the imagery step lists them when it runs");
  download(`tiles_batch_${batchId}.csv`, csv([["REGION", "CAPTURE_ID", "TILE_ID", "COG_URL", "STAC_URL", "PROCESSED_AT"], ...rows.map((r) => [r.region_id, r.capture_id, r.tile_id, r.cog_url, r.stac_url, r.processed_at || ""])]));
}

// ---------------------------------------------------------------- events
document.addEventListener("click", async (e) => {
  const t = e.target, cl = (s) => t.closest && t.closest(s);
  const tab = cl("[data-btab]"); if (tab && isB()) { const k = tab.dataset.btab; BATCH.view = null;
    if (CFG_STEPS.some(([x]) => x === k)) { bsub = k; store.set("batch-sub", k); if (stage === "configure") return drawBatch(); stage = "configure"; } else stage = k;
    store.set("stage", stage); render(); return scrollTo(0, 0); }
  const as = cl("[data-asub]"); if (as && isSub("allocate") && !window._dragMoved) { const n = as.dataset.asub, k = norm(n), rows = curAllocRows(), selected = aSel();
    if (selected.size) {   // toggle this area for every selected study suburb
      const chosen = rows.filter((r) => selected.has(r.key)), allHave = chosen.every((r) => r.targets.some((x) => norm(x) === k));
      for (const r of chosen) { const cur = r.targets.filter((x) => norm(x) !== k); setAlloc(r, allHave ? cur : [...cur, n]); }
    } else { for (const r of rows) if (r.targets.some((x) => norm(x) === k)) selected.add(r.key);   // tick the study suburbs that use it
      if (!selected.size) toastMsg(`${n}: no study suburb uses it. Tick study suburbs first to assign it.`); }
    return drawBatch(); }
  const ta = cl("[data-ta]"); if (ta && isSub("select") && !window._dragMoved) { const c = ta.dataset.ta; BATCH.sel.has(c) ? BATCH.sel.delete(c) : BATCH.sel.add(c); saveSel(); BATCH.valid = {}; return drawBatch(); }
  const z = cl("[data-zoom]");
  if (z) { const svg = z.closest(".zmap").querySelector("svg"), b = svg.getAttribute("viewBox").split(" ").map(Number), act = z.dataset.zoom;
    if (act === "reset") return setView(svg, svg.dataset.full.split(" ").map(Number));
    if (act === "sel") { const id = z.closest(".zmap").dataset.zmap;
      const g = id === "ovw" ? allSubs().map(({ s }) => s.geom) : id === "cfg" ? [...BATCH.sel].map((c) => taOf(c).geom && taOf(c).geom.coordinates).filter(Boolean)
        : id.startsWith("alc-") ? ((scopeOf(id.slice(4)) || {}).matched || []).map((m) => m.linz.geom.coordinates)
        : ((BATCH.valid[id.slice(4)] || {}).matched || []).map((m) => m.linz.geom.coordinates);
      return g.length ? setView(svg, mapBox(g)) : setView(svg, svg.dataset.full.split(" ").map(Number)); }
    const k = act === "in" ? 0.7 : 1 / 0.7, w = b[2] * k, h = b[3] * k; return setView(svg, [b[0] + (b[2] - w) / 2, b[1] + (b[3] - h) / 2, w, h]); }
  const vr = cl("[data-vta]"); if (vr) { BATCH.vTA = vr.dataset.vta; BATCH.view = null; return drawBatch(); }
  if (t.dataset && t.dataset.ata) { BATCH.aTA = t.dataset.ata; BATCH.aPick = null; BATCH.view = null; return drawBatch(); }
  if (t.dataset && t.dataset.alinz) { t.disabled = true; try { await ensureLinz(t.dataset.alinz); } catch (err) { toastMsg("LINZ suburbs: " + err.message); } return drawBatch(); }
  if (t.id === "alinz-all") { t.disabled = true; for (const c of [...BATCH.sel].sort()) { try { await ensureLinz(c); } catch (err) { toastMsg(`${taOf(c).name}: ${err.message}`); } drawBatch(); } return; }
  if (t.dataset && t.dataset.areset) { const r = rowByKey(t.dataset.areset); if (r) { for (const [k, a] of Object.entries(BATCH.alloc)) if (a === r.alloc) delete BATCH.alloc[k]; BATCH.valid = {}; saveSel(); } return drawBatch(); }
  if (t.dataset && t.dataset.mdel) { delete BATCH.alloc[t.dataset.mdel]; BATCH.valid = {}; saveSel(); return drawBatch(); }
  if (t.id === "mnew") { const c = curTA(), st = (($("#mnew-study") || {}).value || "").trim(), ln = (($("#mnew-linz") || {}).value || "").trim();
    const x = ((BATCH.linz[c] || {}).list || []).find((y) => norm(y.name) === norm(ln));
    if (!st) return toastMsg("Type a study suburb name"); if (!x) return toastMsg(`"${ln}" is not a LINZ suburb in ${taOf(c).name}`);
    mapPair(c, st, x.name); return drawBatch(); }
  if (t.dataset && (t.dataset.aadd || t.dataset.adel)) { const r = rowByKey(t.dataset.aadd || t.dataset.adel); if (!r) return;
    if (t.dataset.adel) { setAlloc(r, r.targets.filter((x) => x !== t.dataset.aname)); return drawBatch(); }
    const hit = ((BATCH.linz[curTA()] || {}).list || []).find((x) => norm(x.name) === norm(t.dataset.aname)); if (!hit) return toastMsg(`"${t.dataset.aname}" is not a LINZ suburb in this TA`);
    if (!r.targets.includes(hit.name)) setAlloc(r, [...r.targets, hit.name]); return drawBatch(); }
  if (t.id === "aclear") { aSel().clear(); return drawBatch(); }
  const skb = cl("[data-askip]"); if (skb) { const c = curTA(), P = tapicks(c), k = norm(skb.dataset.askip), skip = P.skip.filter((x) => norm(x) !== k);
    if (skb.dataset.on !== "1") skip.push(skb.dataset.askip); setPicks(c, { ...P, skip }); return drawBatch(); }
  // bulk actions on the rows shown (after the filter)
  const shownRows = () => { const f = norm(store.get("afilter", "")); return curAllocRows().filter((r) => !f || norm(r.mname + " " + r.targets.join(" ")).includes(f)); };
  if (t.id === "asel-shown") { const S = aSel(); for (const r of shownRows()) S.add(r.key); return drawBatch(); }
  const lb = cl("[data-aload]"); if (lb) { const c = curTA(), P = tapicks(c), names = new Set(shownRows().map((r) => norm(r.mname)));
    const skip = P.skip.filter((x) => !names.has(norm(x))); if (lb.dataset.aload === "0") skip.push(...shownRows().map((r) => r.mname)); setPicks(c, { ...P, skip }); return drawBatch(); }
  if (t.id === "agaz") { t.disabled = true; t.textContent = "Searching…"; const c = curTA(); let near = 0;
    try { near = await nearbySuburbs(c); } catch (err) { toastMsg("Nearby search: " + err.message); }
    try { await gazetteer(c); } catch (err) { toastMsg("Gazetteer: " + err.message); }
    if (near) toastMsg(`${near} not-found name(s) match LINZ suburbs just outside ${taOf(c).name}: adopt them with ↗`); return drawBatch(); }
  const ad = cl("[data-aadopt]"); if (ad) { const c = curTA(), r = rowByKey(ad.dataset.aadopt); if (!r) return; ad.disabled = true;
    try { await adoptSuburb(c, +ad.dataset.aid); const r2 = rowByKey(ad.dataset.aadopt) || r; setAlloc(r2, [...r2.targets.filter((x) => norm(x) !== norm(ad.dataset.aname)), ad.dataset.aname]);
      if (BATCH.near && BATCH.near[c]) delete BATCH.near[c][mkey(r.mname)]; toastMsg(`${ad.dataset.aname} adopted into ${taOf(c).name} and assigned to ${r.mname}`); }
    catch (err) { toastMsg("Not adopted: " + err.message); } return drawBatch(); }
  if (t.id === "arefetch") { if (!confirm("Fetch this TA's suburbs from LINZ again? This uses one LINZ request and updates the shared cache.")) return;
    t.disabled = true; t.textContent = "Fetching…"; try { await ensureLinz(curTA(), true); toastMsg("LINZ suburbs updated"); } catch (err) { toastMsg("LINZ: " + err.message); } return drawBatch(); }
  if (t.id === "comb-go") { const c = curTA(), from = (($("#comb-from") || {}).value || "").trim(), to = (($("#comb-to") || {}).value || "").trim(), rows = curAllocRows();
    const A = rows.find((r) => norm(r.mname) === norm(to)), B = rows.find((r) => norm(r.mname) === norm(from)) || { mname: from };
    if (!from || !to || norm(from) === norm(to)) return toastMsg("Choose two different study suburbs"); if (!A) return toastMsg(`"${to}" is not a study suburb here`);
    const P = tapicks(c), alias = { ...P.alias, [norm(B.mname)]: { from: B.mname, to: A.mname } }; setPicks(c, { ...P, alias }); toastMsg(`${B.mname} is now treated as another spelling of ${A.mname}`); return drawBatch(); }
  const unc = cl("[data-uncombine]"); if (unc) { const c = curTA(), P = tapicks(c), alias = { ...P.alias }; delete alias[norm(unc.dataset.uncombine)]; setPicks(c, { ...P, alias }); return drawBatch(); }
  if (t.id === "asel-nf") { const S = aSel(); for (const r of curAllocRows()) if (!r.targets.length && !r.skipped) S.add(r.key); return drawBatch(); }
  if (t.id === "apicks-clear") { const c = curTA(), P = tapicks(c); P.skip.length ? BATCH.picks[c] = { add: [], ex: [], skip: P.skip } : delete BATCH.picks[c]; BATCH.valid = {}; saveSel(); return drawBatch(); }
  if (t.id === "alloc-next") { const n = +t.dataset.todo || 0;
    if (n && !confirm(`${n} study suburb${n === 1 ? " is" : "s are"} not assigned to a LINZ suburb and won't be loaded. Continue to validation anyway?`)) return;
    bsub = "vsuburbs"; store.set("batch-sub", bsub); BATCH.view = null; drawBatch(); return scrollTo(0, 0); }
  if (t.dataset && t.dataset.punmatch) { delete BATCH.matches[t.dataset.punmatch]; BATCH.valid = {}; saveSel(); return drawBatch(); }
  if (t.id === "bcfg-export") return exportBuilder();
  const tlb = t.closest && t.closest("[data-tlyb]");
  if (tlb) { const c = tlb.dataset.tlyb, o = { ...tlOf(c) }, cur = new Set(o.census_years || CENSUS_YEARS); cur.has(tlb.dataset.y) ? cur.delete(tlb.dataset.y) : cur.add(tlb.dataset.y);
    if (!cur.size) return toastMsg("Keep at least one census year");
    o.census_years = CENSUS_YEARS.filter((y) => cur.has(y)); return setTl(c, o); }
  if (t.id === "tl-apply-all") { const src = tlOf("_all"); for (const c of BATCH.sel) BATCH.tl[c] = { ...src }; saveSel(); toastMsg(`Timeline applied to ${BATCH.sel.size} TA(s); edit any row to change it`); return drawBatch(); }
  if (t.dataset && t.dataset.refined) return downloadRefined(t.dataset.refined);
  if (t.id === "bcfg-clear") { BATCH.builder = null; return drawBatch(); }
  if (t.dataset && t.dataset.tprvdrReset) { delete BATCH.prvdr[t.dataset.tprvdrReset]; saveSel(); return drawBatch(); }
  if (t.dataset && t.dataset.tunsel) { BATCH.sel.delete(t.dataset.tunsel); saveSel(); return drawBatch(); }
  if (t.dataset && t.dataset.sclear) { delete BATCH.files[t.dataset.sclear]; delete BATCH.fileNames[t.dataset.sclear]; BATCH.valid = {}; return drawBatch(); }
  if (t.id === "sel-found") { for (const c of tasInFiles()) BATCH.sel.add(c); saveSel(); BATCH.valid = {}; return drawBatch(); }
  if (t.id === "batch-clear") { BATCH.sel.clear(); BATCH.valid = {}; saveSel(); return drawBatch(); }
  if (t.id === "bta-all" || t.id === "bta-none") { const f = norm(store.get("bta-filter", "")); for (const x of BATCH.tas) if (!f || norm([x.name, (x.prvdrs || []).join(" "), x.rc].join(" ")).includes(f)) t.id === "bta-all" ? BATCH.sel.add(x.code) : BATCH.sel.delete(x.code); saveSel(); BATCH.valid = {}; return drawBatch(); }
  if (t.id === "validate-go" && can("editor")) { t.disabled = true; try { await validateAll(); } finally { t.disabled = false; } return; }
  if (t.id === "load-validate" && can("editor")) { t.disabled = true; t.textContent = "Validating…"; try { await validateAll(); } finally { drawBatch(); } return; }
  if (t.id === "batch-queue" && can("editor")) { t.disabled = true; try { await queueBatch(); } catch (err) { toastMsg("Not queued: " + err.message); t.disabled = false; } return; }
  if (t.id === "cfg-bar-save" && can("editor")) { const n = (($("#cfg-bar-name") || {}).value || "").trim(); try { await saveConfig(n); } catch (err) { toastMsg("Not saved: " + err.message); } return; }
  if (t.id === "cfg-save" && can("editor")) { try { await saveConfig(); } catch (err) { toastMsg("Not saved: " + err.message); } return; }
  if (t.id === "cfg-del" && BATCH.config && confirm(`Delete configuration "${BATCH.config.name}"?`)) { try { await q(sb.from("batch_configs").delete().eq("id", BATCH.config.id)); if (String(STUDY.id) === String(BATCH.config.id)) { STUDY.id = ""; store.set("study", ""); } BATCH.config = null; await loadBatchData(); loadStudies(); drawBatch(); } catch (err) { toastMsg(err.message); } return; }
  const rj = t.closest && t.closest("[data-restart-job]");
  if (rj && can("editor")) { rj.disabled = true;
    try { await q(sb.from("jobs").update({ status: "queued", reason: "restarted", not_before: null }).eq("id", +rj.dataset.restartJob)); toastMsg("Job queued again: the worker picks it up on its next run"); }
    catch (err) { toastMsg("Not restarted: " + err.message); }
    PROG.at = null; await refreshProgress(); kickWorker(true); return; }
  const rb = t.closest && t.closest("[data-retry-batch]");
  if (rb && can("editor")) { rb.disabled = true; const ids = PROG.jobs.filter((j) => j.batch_id === +rb.dataset.retryBatch && j.status === "failed").map((j) => j.id);
    try { if (ids.length) await q(sb.from("jobs").update({ status: "queued", reason: null, not_before: null }).in("id", ids)); toastMsg(`${ids.length} region job(s) queued again`); }
    catch (err) { toastMsg("Not retried: " + err.message); }
    PROG.at = null; await refreshProgress(); kickWorker(true); return; }
  if (t.id === "kick-worker") { t.disabled = true; await kickWorker(false); return; }
  if (t.id === "prog-refresh") { PROG.at = null; return refreshProgress(); }
  if (t.id === "batch-refresh") { await loadBatchData(); return drawBatch(); }
  if (t.dataset && t.dataset.tiles) return tileCSV(+t.dataset.tiles).catch((err) => toastMsg(err.message));
  if (t.dataset && t.dataset.publish && can("editor")) { try { await q(sb.from("regions").update({ status: "published" }).eq("id", t.dataset.publish)); toastMsg("Published: reload to add it to the region list"); await loadBatchData(); drawBatch(); } catch (err) { toastMsg(err.message); } }
});
document.addEventListener("change", async (e) => {
  const t = e.target;
  if (t.dataset && t.dataset.tsel) { t.checked ? BATCH.sel.add(t.dataset.tsel) : BATCH.sel.delete(t.dataset.tsel); saveSel(); BATCH.valid = {}; return drawBatch(); }
  if (t.dataset && t.dataset.tprvdr) { const c = t.dataset.tprvdr, f0 = filePrvdr(c);
    if (f0) { const codes = [...(f0.acronyms || []), ...(f0.unresolved || [])];
      for (const code of codes) { const tas = new Set(); for (const r of BATCH.files.provider || []) if (norm(r.PRVDR) === norm(code)) provRowTAs(r).forEach((x) => tas.add(x));
        for (const r of BATCH.files.map || []) if (norm(r.PROVIDER) === norm(code)) rowTAs(r.M_TERRITORY, r.PROVIDER).forEach((x) => tas.add(x));
        // only your own acronyms / unmatched codes (not saved PRVDR codes such as "TDC"), and only if no other TA uses them
        if ([...tas].every((x) => x === c) && norm(code) !== norm(t.value) && prvdrCode(code) !== String(code).trim().toUpperCase()) BATCH.matches[norm(code)] = t.value; } }
    const auto = (filePrvdr(c) || {}).code || BATCH.cfgPrvdr[c] || (taOf(c).prvdrs || [])[0];
    t.value === auto ? delete BATCH.prvdr[c] : BATCH.prvdr[c] = t.value; saveSel(); return drawBatch(); }
  if (t.id === "batch-keep") { BATCH.rev++; MEMO.fresh = false; BATCH.keep = t.value; store.set("batch-keep", t.value); BATCH.valid = {}; return drawBatch(); }
  if (t.id === "cfg-pick") return loadConfig(t.value);
  if (t.dataset && t.dataset.asel) { const S = aSel(); t.checked ? S.add(t.dataset.asel) : S.delete(t.dataset.asel); return drawBatch(); }

  if (t.dataset && t.dataset.tl) { const c = t.dataset.tl, o = { ...tlOf(c) }, v = parseDay(t.value);
    if (v === null) { toastMsg(`"${t.value}" isn't a date between 1940-01-01 and ${latestDay()}: use yyyy-mm-dd, e.g. 2012-01-01`); t.value = tlOf(c)[t.dataset.tlk] || ""; return; }
    v ? o[t.dataset.tlk] = v : delete o[t.dataset.tlk];
    if (o.climate_start && o.climate_end && o.climate_start > o.climate_end) { toastMsg("The weather period ends before it starts"); t.value = tlOf(c)[t.dataset.tlk] || ""; return; }
    return setTl(c, o); }
  if (t.dataset && t.dataset.pinc !== undefined) { togglePick(curTA(), t.dataset.pinc, t.checked); return drawBatch(); }
  if (t.dataset && t.dataset.pmatch !== undefined) { t.value ? BATCH.matches[t.dataset.pmatch] = t.value : delete BATCH.matches[t.dataset.pmatch]; BATCH.valid = {}; saveSel(); return drawBatch(); }
  if (t.id === "bin-files" && t.files && t.files.length) {
    const msgs = [];
    for (const f of [...t.files]) { const n = f.name.toLowerCase();
      if (n.endsWith(".json")) { try { msgs.push(importBuilder(JSON.parse(await f.text()), f.name)); } catch (err) { msgs.push(err instanceof SyntaxError ? `${f.name} is not valid JSON` : err.message); } continue; }
      const k = /provider/.test(n) ? "provider" : /map/.test(n) ? "map" : /ref/.test(n) ? "ref" : null;
      if (!k) { msgs.push(`${f.name}: not recognised (name it nz_suburb_map, nz_suburb_ref or nz_suburb_provider)`); continue; }
      BATCH.files[k] = readCSV(await f.text()); BATCH.fileNames[k] = f.name; msgs.push(`${f.name}: ${BATCH.files[k].length} rows`); }
    BATCH.savedScope = null; BATCH.valid = {}; toastMsg(msgs.join(" · ")); return drawBatch(); }
  if (t.id === "bcfg-import" && t.files && t.files[0]) { const f = t.files[0];
    try { toastMsg(importBuilder(JSON.parse(await f.text()), f.name)); } catch (err) { toastMsg(err instanceof SyntaxError ? `${f.name} is not valid JSON` : err.message); } return drawBatch(); }
  if (t.dataset && t.dataset.sfile && t.files && t.files[0]) {
    BATCH.files[t.dataset.sfile] = readCSV(await t.files[0].text()); BATCH.fileNames[t.dataset.sfile] = t.files[0].name; BATCH.savedScope = null; BATCH.valid = {}; BATCH.rev++; MEMO.fresh = false;
    toastMsg(`${BATCH.files[t.dataset.sfile].length} rows read; applied to ${Object.keys(scopeByTA()).length} selected TA(s)`); return drawBatch();
  }
});
document.addEventListener("input", (e) => { if (e.target.id === "afilter") { store.set("afilter", e.target.value); clearTimeout(window._af); window._af = setTimeout(() => { drawBatch(); const f = $("#afilter"); if (f) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); } }, 250); return; }
  if (e.target.id === "bta-filter") { store.set("bta-filter", e.target.value); clearTimeout(window._bf); window._bf = setTimeout(() => { drawBatch(); const f = $("#bta-filter"); if (f) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); } }, 250); } });

// stage headings take their number from the stage bar (stages were inserted and replaced)
STAGES.forEach(([id], i) => { const f = V[id]; if (f) V[id] = (...a) => f(...a).replace(/<h1>\d+ · /, `<h1>${i + 1} · `); });

// ---------------------------------------------------------------- header: the study (saved configuration) instead of a bare region picker
// The region picker is shown only on stages that work on one region, limited to the chosen study's TAs.
const STUDY = { id: store.get("study", ""), list: null };
const REGION_STAGES = new Set(["imagery", "validate", "context", "explore", "export"]);
async function loadStudies() {
  try { STUDY.list = can("editor") ? await q(sb.from("batch_configs").select("id,name,ta_codes").order("name")) : []; } catch (e) { STUDY.list = []; }
  renderHeader();
}
const studyOf = () => (STUDY.list || []).find((c) => String(c.id) === String(STUDY.id));
const _rhStudy = renderHeader;
renderHeader = function () {
  _rhStudy();
  const sel = $("#region"), lab = sel && sel.closest && sel.closest("label"); if (!lab) return;
  let w = $("#study-wrap");
  if (!w && lab.parentNode && lab.parentNode.insertBefore) { w = document.createElement("label"); w.id = "study-wrap"; w.className = "small"; lab.parentNode.insertBefore(w, lab); }
  if (STUDY.list === null) { STUDY.list = []; loadStudies(); }
  const cur = studyOf();
  if (w) { w.hidden = lab.hidden;
    w.innerHTML = `<span class="muted">Study</span> <select id="study" aria-label="Study (saved configuration)"><option value="">All regions</option>${(STUDY.list || []).map((c) => `<option value="${c.id}" ${cur && cur.id === c.id ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select>`; }
  if (cur && D && D.regions) {
    const keys = (D.index || []).filter((r) => (cur.ta_codes || []).includes(r.ta_code)).map((r) => r.id);
    if (keys.length) { if (!keys.includes(region)) { region = keys[0]; store.set("region", region); }
      sel.innerHTML = keys.map((k) => `<option value="${k}" ${k === region ? "selected" : ""}>${esc(indexOf(k).name || k)}${D.regions[k] ? "" : " (not loaded)"}</option>`).join(""); }
  }
  lab.style.display = REGION_STAGES.has(stage) ? "" : "none";
};
document.addEventListener("change", async (e) => {
  if (e.target.id !== "study") return;
  STUDY.id = e.target.value; store.set("study", STUDY.id);
  if (STUDY.id) { try { await loadBatchData(); loadConfig(STUDY.id); } catch (err) { toastMsg(err.message); } }
  render();
});
