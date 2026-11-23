// Batch preparation, replacing the old builder's Load and Allocate stages with four stages: 2 Configure (TAs, PRVDRs, scope
// lists, saved or builder configurations), 3 Allocate (list rows that match no LINZ suburb, and provider codes, as in
// suburb_lookup.html's Allocate tab), 4 Validate suburbs (scoped names checked against LINZ, located suburbs on the map),
// 5 Load (queue one job per region, progress, tile lists).
// Uploaded files are read in the browser only; configurations keep the resulting suburb names, never file contents.
"use strict";
// 2 Configure (sub-steps: 2.1 Inputs and TAs, 2.2 Allocate, 2.3 Validate suburbs) and 3 Load replace the old Load and Allocate
(() => { const st = document.createElement("style"); st.textContent = ".amap td,.amap th{white-space:normal;vertical-align:top}.amap td .tag{display:inline-block;margin:1px 2px 1px 0}.amap td input[type=text]{max-width:100%}"; (document.head || document.body).appendChild(st); })();
const BSTAGES = { configure: "Configure", load: "Load" };
const CFG_STEPS = [["select", "Inputs and TAs"], ["allocate", "Allocate"], ["vsuburbs", "Validate suburbs"]];
STAGES.splice(1, STAGES.filter(([id]) => id === "load" || id === "allocate").length, ...Object.entries(BSTAGES));
let bsub = store.get("batch-sub", "select");
if (["batch", "allocate", "vsuburbs"].includes(stage)) { if (stage !== "batch") bsub = stage; stage = "configure"; }
const isSub = (k) => stage === "configure" && bsub === k;
const BATCH = { tas: null, providers: [], sel: new Set(JSON.parse(store.get("batch-sel", "[]"))), prvdr: JSON.parse(store.get("batch-prvdr-v2", "{}")), cfgPrvdr: {},
  files: {}, keep: store.get("batch-keep", "any"), config: null, configs: [], valid: {}, vTA: null,
  batches: [], jobs: [], regions: [], view: null, savedScope: null, fileNames: {}, linz: {}, aTA: null, aPick: null, builder: null,
  matches: JSON.parse(store.get("batch-matches", "{}")), alloc: JSON.parse(store.get("batch-alloc", "{}")), picks: JSON.parse(store.get("batch-picks", "{}")) };
const isB = () => Object.prototype.hasOwnProperty.call(BSTAGES, stage);
const norm = (s) => String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
const saveSel = () => { store.set("batch-sel", JSON.stringify([...BATCH.sel])); store.set("batch-prvdr-v2", JSON.stringify(BATCH.prvdr));
  store.set("batch-matches", JSON.stringify(BATCH.matches)); store.set("batch-alloc", JSON.stringify(BATCH.alloc)); store.set("batch-picks", JSON.stringify(BATCH.picks)); };
const taOf = (c) => (BATCH.tas || []).find((x) => x.code === c) || {};

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
  return all.slice(1).map((r) => Object.fromEntries(h.map((k, i) => [k, (r[i] || "").trim()])));
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
    for (const c of provRowTAs(r)) { add(c, "provider", r.M_SUBURB, { m_suburb: r.M_SUBURB, linz_ref: r.M_SUBURB, territory: r.M_TERRITORY, prvdr: resolveCode(r.PRVDR), spellings: other, file: "nz_suburb_provider.csv" });
      for (const o of other) add(c, "provider", o); } }
  // keep rule: nz_suburb_map and nz_suburb_ref are the keep-lists (either / both); the provider file assigns PRVDRs and
  // other spellings, and scopes a TA only when neither keep-list covers it
  for (const o of Object.values(out)) {
    const keepLists = ["map", "ref"].filter((k) => o.lists[k]); const use = keepLists.length ? keepLists : ["provider"];
    const sets = use.map((k) => new Set([...o.lists[k]].map(norm)));
    let keep = use.flatMap((k) => [...o.lists[k]]).filter((n) => BATCH.keep === "any" || sets.every((st) => st.has(norm(n))));
    if (o.lists.provider && keepLists.length) for (const r of o.rows.filter((r) => r.file === "nz_suburb_provider.csv"))
      if (keep.some((k) => norm(k) === norm(r.m_suburb) || (r.spellings || []).some((x) => norm(x) === norm(k)))) keep.push(r.m_suburb, ...(r.spellings || []));
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

// ---------------------------------------------------------------- data
async function loadBatchData() {
  if (!BATCH.tas) BATCH.tas = await q(sb.rpc("ta_outlines", { p_tol: 200 }));
  if (!BATCH.providers.length) BATCH.providers = await q(sb.from("providers").select("prvdr,legacy_prvdr,name,aliases,territories").order("prvdr"));
  if (can("editor")) {
    BATCH.configs = await q(sb.from("batch_configs").select("id,name,ta_codes,keep_mode,prvdr_by_ta,prvdr_manual,scope_by_ta,prvdr_matches,allocations,suburb_picks,updated_at").order("updated_at", { ascending: false }));
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
const pathD = (g) => g.map((p) => p.map((r) => r.map(([x, y], i) => (i ? "L" : "M") + Math.round(x) + "," + Math.round(-y)).join("") + "Z").join("")).join("");
function zoomMap(id, layers, full) {
  const v = (BATCH.view && BATCH.view.id === id) ? BATCH.view.box : full;
  return `<div class="zmap" data-zmap="${id}" style="position:relative">
    <div class="row" style="position:absolute;right:6px;top:6px;gap:4px;z-index:2"><button class="btn" type="button" data-zoom="in" aria-label="Zoom in">+</button><button class="btn" type="button" data-zoom="out" aria-label="Zoom out">−</button>
    <button class="btn" type="button" data-zoom="sel">Selection</button><button class="btn" type="button" data-zoom="reset">Reset</button></div>
    <svg viewBox="${v.join(" ")}" data-full="${full.join(" ")}" style="width:100%;height:440px;display:block;touch-action:none;background:var(--bg);border-radius:8px" role="img" aria-label="Map: scroll to zoom, drag to pan">
    ${layers.map((l) => `<path ${l.attr || ""} d="${l.d}" fill="${l.fill}" fill-opacity="${l.op ?? 1}" stroke="${l.stroke || "var(--landline)"}" stroke-width="${l.sw || 0.8}" vector-effect="non-scaling-stroke" ${l.click ? 'style="cursor:pointer"' : ""}><title>${esc(l.title || "")}</title></path>`).join("")}</svg></div>`;
}
let DRAG = null;
document.addEventListener("wheel", (e) => {
  const svg = e.target.closest && e.target.closest(".zmap svg"); if (!svg) return; e.preventDefault();
  const b = svg.getAttribute("viewBox").split(" ").map(Number), r = svg.getBoundingClientRect();
  const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height, k = e.deltaY < 0 ? 0.8 : 1.25;
  const w = b[2] * k, h = b[3] * k; setView(svg, [b[0] + (b[2] - w) * fx, b[1] + (b[3] - h) * fy, w, h]);
}, { passive: false });
document.addEventListener("pointerdown", (e) => { const svg = e.target.closest && e.target.closest(".zmap svg"); if (svg) DRAG = { svg, x: e.clientX, y: e.clientY, b: svg.getAttribute("viewBox").split(" ").map(Number), moved: false }; });
document.addEventListener("pointermove", (e) => { if (!DRAG) return; const dx = e.clientX - DRAG.x, dy = e.clientY - DRAG.y; if (Math.abs(dx) + Math.abs(dy) > 4) DRAG.moved = true;
  if (DRAG.moved) { const r = DRAG.svg.getBoundingClientRect(), b = DRAG.b; setView(DRAG.svg, [b[0] - dx * b[2] / r.width, b[1] - dy * b[3] / r.height, b[2], b[3]]); } });
document.addEventListener("pointerup", () => { if (DRAG) { window._dragMoved = DRAG.moved; setTimeout(() => { window._dragMoved = false; }, 0); } DRAG = null; });
function setView(svg, box) { svg.setAttribute("viewBox", box.join(" ")); BATCH.view = { id: svg.closest(".zmap").dataset.zmap, box }; }

// ---------------------------------------------------------------- stage shell
const LEADS = {
  configure: "Choose the territorial authorities to prepare and their water provider (PRVDR), add your input files, allocate rows and provider codes that don't match, and check the suburbs against LINZ. Each region runs as its own job within the free-tier budgets, and data already stored by anyone is reused.",
  load: "Queue the validated regions, follow their progress, publish them and download tile lists." };
for (const id of Object.keys(BSTAGES)) V[id] = () => {
  setTimeout(async () => { try { await loadBatchData(); drawBatch(); } catch (e) { const el = $("#batch-body"); if (el) el.innerHTML = `<p class="muted">${esc(e.message)}</p>`; } }, 0);
  return `<h1>0 · ${BSTAGES[id]}</h1><p class="lead">${LEADS[id]}</p><div id="batch-body"><p class="muted">Loading…</p></div>`;
};
function drawBatch() {
  const el = $("#batch-body"); if (!el || !BATCH.tas || !isB()) return;
  if (stage === "load") { el.innerHTML = loadHTML(); return; }
  const i = CFG_STEPS.findIndex(([k]) => k === bsub);
  el.innerHTML = `<div class="row" role="tablist" aria-label="Configure steps" style="margin-bottom:12px">${CFG_STEPS.map(([k, l], j) => `<button class="btn ${k === bsub ? "primary" : ""}" role="tab" aria-selected="${k === bsub}" data-btab="${k}" type="button">2.${j + 1} ${l}</button>`).join("")}</div>`
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
    return `<tr><td class="l"><b>${esc(t.name)}</b><br><span class="small muted">${s ? `${s.keep.length} suburbs (${esc(s.basis)})` : t.parts > 1 ? "needs a suburb list" : "whole TA"}</span></td>
      <td class="l">${(() => { const f = filePrvdr(c), acr = !BATCH.prvdr[c] && f && f.code ? f.acronyms.filter((a) => norm(a) !== norm(p)) : [];
        return `${acr.length ? `<b>${acr.map(esc).join(", ")}</b> <span class="small muted">(your PRVDR) →</span><br>` : ""}<select data-tprvdr="${c}" aria-label="PRVDR for ${esc(t.name)}">${opts(p)}</select><br><span class="small muted">${prvdrSource(c)}${BATCH.prvdr[c] ? ` · <button class="btn" type="button" data-tprvdr-reset="${c}" style="padding:1px 6px">reset</button>` : ""}</span>${f && f.unresolved.length ? `<br><span class="tag warn">${f.unresolved.map(esc).join(", ")}: no saved provider</span> <button class="btn" type="button" data-btab="allocate" style="padding:1px 6px">match in 2.2</button>` : ""}`; })()}</td><td class="l small" style="white-space:normal;min-width:260px">${rate}</td>
      <td><button class="btn" type="button" data-tunsel="${c}" aria-label="Remove ${esc(t.name)}">×</button></td></tr>`; }).join("");
  return `<div class="grid g2">
    <div class="card">${zoomMap("cfg", layers, mapBox(BATCH.tas.map((t) => t.geom.coordinates)))}<p class="small muted" style="margin:6px 0 0">Scroll to zoom, drag to pan, click a TA to select it.</p></div>
    <div class="card"><h3>Saved configurations</h3>
      ${can("editor") ? `<div class="row"><select id="cfg-pick" aria-label="Saved configuration"><option value="">New configuration</option>${BATCH.configs.map((c) => `<option value="${c.id}" ${BATCH.config && BATCH.config.id === c.id ? "selected" : ""}>${esc(c.name)} (${c.ta_codes.length} TAs)</option>`).join("")}</select>
        <input type="text" id="cfg-name" placeholder="Name" value="${esc(BATCH.config ? BATCH.config.name : "")}" style="width:160px"><button class="btn" id="cfg-save" type="button">Save</button>${BATCH.config ? '<button class="btn" id="cfg-del" type="button">Delete</button>' : ""}</div>
        <p class="small muted">Stores the selected TAs, PRVDRs, keep rule, provider-code matches, allocations and the resulting suburb names, not your files. Only you can see your configurations.</p>` : lock("editor", "Saving configurations")}
      <h3 style="margin-top:12px">Input files (optional)</h3>
      <p class="small muted">Read in your browser and applied to the selected TAs only.</p>
      <p class="small" style="margin:6px 0"><label><b>Add several at once</b> <input type="file" multiple accept=".json,.csv,.tsv,application/json,text/csv" id="bin-files"></label><br><span class="muted">Each file goes to its slot below by name.</span></p>
      <p class="small" style="margin:6px 0"><label><b>nz_suburb_builder_config.json</b> <input type="file" accept=".json,application/json" id="bcfg-import"></label>${BATCH.builder ? ` <span class="tag info">${esc(BATCH.builder.fname)}</span> <button class="btn" type="button" id="bcfg-clear">Clear</button>` : ""} <button class="btn" type="button" id="bcfg-export">Export</button><br>
        <span class="muted">From the reference builder (suburb_lookup.html): keep rule, PRVDR matches and suburb allocations.</span>${builderNote()}</p>
      ${[["map", "nz_suburb_map.csv", "M_SUBURB, PROVIDER, NZ_SUBURB_REF, M_TERRITORY"], ["ref", "nz_suburb_ref.csv", "M_SUBURB, …, M_TERRITORY"], ["provider", "nz_suburb_provider.csv", "M_SUBURB, Other spellings, PRVDR (sets each TA's PRVDR, ahead of nz_suburb_map's PROVIDER)"]].map(([k, f, cols]) =>
        `<p class="small" style="margin:6px 0"><label><b>${f}</b> <input type="file" accept=".csv,.tsv,text/csv" data-sfile="${k}"></label>${BATCH.files[k] ? ` <span class="tag info">${esc(BATCH.fileNames[k] || "")} · ${BATCH.files[k].length} rows</span> <button class="btn" type="button" data-sclear="${k}">Clear</button>` : ""}<br><span class="muted">${cols}</span></p>`).join("")}
      <p class="small"><label>With both keep-lists, keep a suburb that is in <select id="batch-keep"><option value="any" ${BATCH.keep === "any" ? "selected" : ""}>either list</option><option value="both" ${BATCH.keep === "both" ? "selected" : ""}>both lists</option></select></label></p>
      ${newFound.length ? `<p class="small">Your files also mention ${newFound.length} TA(s) that aren't selected: ${newFound.map((c) => esc(taOf(c).name)).join(", ")}. <button class="btn" id="sel-found" type="button">Select them</button></p>` : ""}
    </div></div>
  <h2>Selected TAs (${sel.length}): PRVDR and charging rates</h2><p class="small muted">Each PRVDR is filled from your lists (nz_suburb_provider.csv, then nz_suburb_map.csv's PROVIDER) or the TA's saved provider. Change it here at any time.</p>
  <div class="card scroll">${sel.length ? `<table><thead><tr><th class="l">TA and scope</th><th class="l">PRVDR</th><th class="l">Charging (2026/27)</th><th></th></tr></thead><tbody>${selRows}</tbody></table>` : '<p class="muted">Select TAs on the map or in the table below.</p>'}
    ${sel.length ? `<div class="row" style="margin-top:8px"><button class="btn primary" type="button" data-btab="allocate">Next: 2.2 Allocate →</button><button class="btn" id="batch-clear" type="button">Clear selection</button></div>` : ""}</div>
  <h2>All regions with charging rates (${BATCH.tas.length} TAs)</h2>
  <div class="row" style="margin-bottom:8px"><label class="small">Filter <input type="text" id="bta-filter" value="${esc(filt)}" placeholder="TA, PRVDR or region"></label>
    <button class="btn" type="button" id="bta-all">Select shown</button><button class="btn" type="button" id="bta-none">Deselect shown</button></div>
  <div class="card scroll" style="max-height:320px;overflow:auto"><table><thead><tr><th></th><th class="l">TA</th><th class="l">PRVDR</th><th class="l">Region</th><th>SA2s</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

// ---------------------------------------------------------------- LINZ suburbs per TA (shared cache)
async function ensureLinz(c, force) {
  if (BATCH.linz[c] && !force) return BATCH.linz[c];
  const { data, error } = await sb.functions.invoke("linz-suburbs", { body: { ta_code: c } });
  if (error) { let m = error.message; try { m = (await error.context.json()).error || m; } catch (_) { /* keep message */ } throw new Error(m); }
  const res = await q(sb.rpc("ta_suburbs", { p_ta: c, p_tol: 20 }));
  return (BATCH.linz[c] = { list: res.suburbs || [], cached: data && data.cached, requests: (data && data.requests) || 0 });
}
const linzIndex = (linz) => { const m = new Map(); for (const x of linz) { m.set(norm(x.name), x); if (x.name_ascii) m.set(norm(x.name_ascii), x); } return m; };
// a scoped name -> LINZ suburbs: direct match, else your allocation for that row
function locate(name, terr, file, byNorm) {
  const a = allocFor(file, name, terr);
  if (a) { const t = (a.linzSuburbs || []).map((x) => byNorm.get(norm(x.name))).filter(Boolean); if (t.length) return { linz: t, allocated: true }; }
  const hit = byNorm.get(norm(name)); return hit ? { linz: [hit], allocated: false } : null;
}
// study suburbs you added in 2.2 that aren't in your files (file "manual", territory = the TA)
const manualFor = (c) => Object.values(BATCH.alloc).filter((a) => a.file === "manual" && rowTAs(a.territory).includes(c));

// suburbs a TA would load: your names matched or allocated (or all its LINZ suburbs when no list covers it), then your
// picks from 2.2: excluded suburbs removed, added suburbs included
function tapicks(c) { return BATCH.picks[c] || { add: [], ex: [] }; }
function scopeOf(c) {
  const s = scopeByTA()[c], L = BATCH.linz[c]; if (!L) return null;
  const byNorm = linzIndex(L.list), pairs = []; let unmatched = [];
  if (s) { for (const n of s.keep) { const rows = s.rows.filter((r) => norm(r.linz_ref) === norm(n)); let ok = false;
      for (const row of rows.length ? rows : [{}]) { const hit = locate(n, row.territory || "", row.file || "", byNorm);
        if (hit) { ok = true; hit.linz.forEach((x) => pairs.push({ input: n, mname: row.m_suburb || n, row: row.file ? row : null, linz: x, allocated: hit.allocated })); } }
      if (!ok) unmatched.push(n); }
    const spell = new Set(s.rows.flatMap((r) => r.spellings || []).map(norm));
    unmatched = unmatched.filter((n) => !(spell.has(norm(n)) && pairs.length)); }
  for (const a of manualFor(c)) for (const t of a.linzSuburbs || []) { const x = byNorm.get(norm(t.name)); if (x) pairs.push({ input: a.name, mname: a.name, manual: true, linz: x, allocated: true }); }
  const byId = new Map();
  for (const m of s ? pairs : [...L.list.map((x) => ({ input: x.name, linz: x, whole: true })), ...pairs]) {
    const e = byId.get(m.linz.id) || { input: m.input, linz: m.linz, allocated: false, studies: [] };
    if (!m.whole) { e.studies.push(m.mname); if (e.studies.length === 1) e.input = m.input; e.allocated = e.allocated || m.allocated; }
    byId.set(m.linz.id, e); }
  const base = [...byId.values()];
  base.forEach((e) => { e.studies = [...new Map(e.studies.map((x) => [norm(x), x])).values()]; });
  const P = tapicks(c), ex = new Set(P.ex.map(norm)), inBase = new Set(base.map((m) => norm(m.linz.name)));
  const matched = base.filter((m) => !ex.has(norm(m.linz.name)));
  for (const n of P.add) { const x = byNorm.get(norm(n)); if (x && !inBase.has(norm(x.name)) && !ex.has(norm(x.name))) matched.push({ input: x.name, linz: x, added: true, studies: [] }); }
  return { s, L, base, matched, unmatched, pairs: pairs.filter((m) => !ex.has(norm(m.linz.name))), excluded: base.filter((m) => ex.has(norm(m.linz.name))),
    scoped: !!s || P.add.length > 0 || P.ex.length > 0 || manualFor(c).length > 0 };
}
function togglePick(c, name, include) {
  const P = { add: [...tapicks(c).add], ex: [...tapicks(c).ex] }, sc = scopeOf(c), k = norm(name);
  const inBase = sc && sc.base.some((m) => norm(m.linz.name) === k);
  P.add = P.add.filter((x) => norm(x) !== k); P.ex = P.ex.filter((x) => norm(x) !== k);
  if (inBase && !include) P.ex.push(name); if (!inBase && include) P.add.push(name);
  P.add.length || P.ex.length ? BATCH.picks[c] = P : delete BATCH.picks[c]; BATCH.valid = {}; saveSel();
}
// ‹ previous / next › through the selected TAs, labelled with each TA's provider
function taNav(cur, attr) {
  const sel = [...BATCH.sel].sort(), i = sel.indexOf(cur); if (sel.length < 2) return "";
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
// rows of a TA's lists that match no LINZ suburb (allocated or not)
function allocRows(c, all) {
  const s = scopeByTA()[c], L = BATCH.linz[c]; if (!L) return [];
  const byNorm = linzIndex(L.list), out = [], seen = new Set();
  if (s) { const keep = new Set(s.keep.map(norm)), rows = s.rows.length ? s.rows : s.keep.map((n) => ({ linz_ref: n, m_suburb: n, territory: "", file: "" }));
    for (const r of rows) {
      if (!keep.has(norm(r.linz_ref))) continue;
      const direct = byNorm.has(norm(r.linz_ref)) || (r.spellings || []).some((x) => byNorm.has(norm(x)));
      const k = allocKey(r.file, r.linz_ref, r.territory || ""); if (seen.has(k)) continue;
      const alloc = allocFor(r.file, r.linz_ref, r.territory || ""); if (!all && direct && !(alloc && alloc.file === r.file)) continue; seen.add(k);
      const hit = locate(r.linz_ref, r.territory || "", r.file, byNorm);
      out.push({ key: k, file: r.file, name: r.linz_ref, mname: r.m_suburb || r.linz_ref, territory: r.territory || "", alloc, direct, targets: hit ? hit.linz.map((x) => x.name) : [] }); } }
  for (const a of manualFor(c)) { const k = allocKey("manual", a.name, a.territory);
    out.push({ key: k, file: "manual", name: a.name, mname: a.name, territory: a.territory, alloc: a, manual: true, targets: (a.linzSuburbs || []).map((x) => (byNorm.get(norm(x.name)) || {}).name).filter(Boolean) }); }
  return out;
}
function allocateHTML() {
  const sel = [...BATCH.sel].sort(); if (!sel.length) return `<p class="muted">Select TAs in 2.1 Inputs and TAs first.</p>`;
  const codes = codesInFiles(), opts = (cur) => `<option value="">(no match)</option>` + BATCH.providers.map((p) => `<option value="${p.prvdr}" ${p.prvdr === cur ? "selected" : ""}>${esc(p.prvdr)} · ${esc(p.name)}</option>`).join("");
  const codeRows = codes.map((e) => `<tr><td class="l"><code>${esc(e.code)}</code></td><td>${e.rows || "–"}</td><td class="l small">${esc([...e.files].join(", "))}</td>
    <td class="l"><select data-pmatch="${esc(e.key)}" aria-label="Provider for ${esc(e.code)}">${opts(e.mine || e.saved)}</select></td>
    <td class="l small">${e.mine ? `your match <button class="btn" type="button" data-punmatch="${esc(e.key)}" style="padding:1px 6px">reset</button>` : e.saved ? "saved provider" : '<span class="tag warn">unresolved</span>'}</td></tr>`).join("");
  const c = BATCH.aTA && sel.includes(BATCH.aTA) ? BATCH.aTA : sel[0], t = taOf(c), L = BATCH.linz[c], sc = scopeByTA()[c];
  let detail;
  if (!L) detail = `<p class="small">Load ${esc(t.name)}'s LINZ suburbs to allocate rows and choose suburbs. <button class="btn primary" type="button" data-alinz="${c}">Load LINZ suburbs</button></p>`;
  else {
    const all = store.get("map-all", "0") === "1", rows = allocRows(c, all), names = L.list.map((x) => x.name), tgt = new Set(), S = scopeOf(c);
    for (const m of S.pairs) if (m.allocated) tgt.add(norm(m.linz.name));
    const studies = [...new Map(allocRows(c, true).map((r) => [norm(r.mname), r.mname])).values()].sort();
    const pick = BATCH.aPick && rows.find((r) => r.key === BATCH.aPick);
    const inc = new Set(S.matched.map((m) => norm(m.linz.name))), exc = new Set(S.excluded.map((m) => norm(m.linz.name)));
    const layers = [{ d: pathD(t.geom.coordinates), fill: "var(--land)", stroke: "var(--ink)", sw: 1.4, title: t.name },
      ...L.list.map((x) => { const k = norm(x.name), st = tgt.has(k) && inc.has(k) ? "allocated" : inc.has(k) ? "included" : exc.has(k) ? "excluded" : "not in scope";
        return { attr: `data-asub="${esc(x.name)}"`, click: true, d: pathD(x.geom.coordinates), fill: st === "allocated" || st === "included" ? "var(--accent)" : st === "excluded" ? "var(--bad, #b3261e)" : "var(--land)",
          op: st === "allocated" ? 0.8 : st === "included" ? 0.45 : st === "excluded" ? 0.3 : 0.6, sw: 0.8, title: `${x.name} (${st})` }; })];
    const list = [...S.base.map((m) => ({ name: m.linz.name, studies: m.studies, allocated: m.allocated, on: !exc.has(norm(m.linz.name)) })), ...S.matched.filter((m) => m.added).map((m) => ({ name: m.linz.name, studies: [], added: true, on: true }))]
      .sort((x, y) => x.name.localeCompare(y.name));
    const filt = norm(store.get("apick-filter", ""));
    const rowsHTML = rows.length ? `<div style="max-height:420px;overflow:auto"><table style="width:100%"><thead><tr><th class="l" style="width:24%">Study suburb</th><th class="l">LINZ suburb(s)</th><th class="l" style="width:330px">Add</th></tr></thead><tbody>${rows.map((r, i) => {
        const sug = r.targets.length ? [] : similar(r.name, names);
        return `<tr${BATCH.aPick === r.key ? ' style="background:var(--accent-soft)"' : ""}><td class="l"><b>${esc(r.mname)}</b>${norm(r.mname) !== norm(r.name) ? ` <span class="small muted">(ref ${esc(r.name)})</span>` : ""}<br><span class="small muted">${esc(r.manual ? "added here" : r.file || "saved configuration")}${r.territory ? " · " + esc(r.territory) : ""}</span>${r.manual ? ` <button class="btn" type="button" data-mdel="${esc(r.key)}" style="padding:0 4px" aria-label="Remove ${esc(r.name)}">remove</button>` : ""}</td>
          <td class="l small">${r.targets.map((x) => `<span class="tag ${r.alloc && !r.manual || r.manual ? "ok" : "info"}">${esc(x)} <button class="btn" type="button" data-adel="${i}" data-aname="${esc(x)}" style="padding:0 4px" aria-label="Remove ${esc(x)}">×</button></span>`).join(" ") || '<span class="tag warn">not mapped</span>'}${r.alloc && !r.manual && r.direct ? ` <button class="btn" type="button" data-areset="${i}" style="padding:0 4px">use name match</button>` : ""}
            ${sug.length ? `<br><span class="muted">did you mean</span> ${sug.map((n) => `<button class="btn" type="button" data-aadd="${i}" data-aname="${esc(n)}" style="padding:1px 6px">${esc(n)}</button>`).join(" ")}` : ""}</td>
          <td class="l"><input type="text" list="alc-dl" data-ain="${i}" placeholder="LINZ suburb" style="width:140px" aria-label="LINZ suburb for ${esc(r.name)}"> <button class="btn" type="button" data-aadd="${i}">Add</button> <button class="btn" type="button" data-apick="${i}">Pick on map</button></td></tr>`; }).join("")}</tbody></table>
      </div><p class="small muted">A study suburb can map to several LINZ suburbs, and several study suburbs to one LINZ suburb. Rows left unmapped aren't loaded. Mappings are saved with the configuration and in an exported builder config.</p>` : `<p class="small">${all ? "No study suburbs yet: add one below." : sc ? "Every row matches a LINZ suburb. Show all to change a mapping." : "No suburb list covers this TA: add study suburbs below."}</p>`;
    detail = `<datalist id="alc-dl">${names.map((n) => `<option value="${esc(n)}">`).join("")}</datalist>
      <div class="grid g2"><div class="card">${zoomMap("alc-" + c, layers, mapBox([t.geom.coordinates]))}
      <p class="small ${pick ? "" : "muted"}" style="margin:6px 0 0">${pick ? `Click suburbs to allocate <b>${esc(pick.name)}</b>. <button class="btn" type="button" id="apick-done">Done</button>`
        : "Blue = will be loaded (darker = allocated), red = excluded, grey = not in scope. Click a suburb to include or exclude it, or press <b>Pick on map</b> on a row to allocate it."}</p></div>
      <div class="card"><h3>Suburbs to load (${S.matched.length}${S.excluded.length ? `, ${S.excluded.length} excluded` : ""})</h3>
      <div class="row" style="gap:6px;margin-bottom:6px"><button class="btn" type="button" data-pall="on">Include all</button><button class="btn" type="button" data-pall="off">Exclude all</button>
        <input type="text" id="apick-filter" value="${esc(store.get("apick-filter", ""))}" placeholder="Filter" style="width:110px" aria-label="Filter suburbs">
        <input type="text" list="alc-dl" id="padd-in" placeholder="Add a LINZ suburb" style="width:150px" aria-label="Add a LINZ suburb"><button class="btn" type="button" id="padd">Add</button></div>
      <div style="max-height:430px;overflow:auto"><table><thead><tr><th></th><th class="l">LINZ suburb</th><th class="l">Study suburb(s)</th></tr></thead><tbody>${list.filter((x) => !filt || norm(x.name).includes(filt)).map((x) => `<tr><td><input type="checkbox" data-pinc="${esc(x.name)}" ${x.on ? "checked" : ""} aria-label="Load ${esc(x.name)}"></td>
        <td class="l">${esc(x.name)}${x.added ? ' <span class="tag info">added</span>' : x.allocated ? ' <span class="tag info">mapped</span>' : ""}${!x.on ? ' <span class="tag bad">excluded</span>' : ""}</td><td class="l small muted">${(x.studies || []).filter((y) => norm(y) !== norm(x.name) || x.studies.length > 1).map(esc).join(", ")}</td></tr>`).join("")}</tbody></table></div>
      <p class="small muted">Excluded suburbs are dropped from 2.3 and Load; added ones are loaded too. Saved with the configuration.</p></div></div>
      <div class="card amap" style="margin-top:12px"><div class="row" style="justify-content:space-between"><h3 style="margin:0">Study suburb → LINZ mappings (${rows.length}${all ? "" : " unmatched"})</h3>
        <label class="small"><input type="checkbox" id="map-all" ${all ? "checked" : ""}> show all</label></div>${rowsHTML}
      <datalist id="study-dl">${studies.map((n) => `<option value="${esc(n)}">`).join("")}</datalist>
      <div class="row" style="gap:6px;margin:6px 0"><input type="text" list="study-dl" id="mnew-study" placeholder="Study suburb (new or existing)" style="width:170px" aria-label="Study suburb">
        → <input type="text" list="alc-dl" id="mnew-linz" placeholder="LINZ suburb" style="width:140px" aria-label="LINZ suburb"><button class="btn" type="button" id="mnew">Map</button></div>
</div>`;
  }
  return `<div class="card"><h3>Provider codes in your files</h3>
    ${codes.length ? `<table><thead><tr><th class="l">PRVDR / PROVIDER</th><th>Rows</th><th class="l">File</th><th class="l">Saved provider</th><th class="l"></th></tr></thead><tbody>${codeRows}</tbody></table>
      <p class="small muted">Codes resolve through your match, else a saved provider's PRVDR, legacy code, alias or name. Matches feed each TA's PRVDR in 2.1.</p>` : '<p class="small muted">No provider codes: add nz_suburb_provider.csv or nz_suburb_map.csv in 2.1.</p>'}</div>
  <div class="row" style="margin:14px 0 8px;justify-content:space-between"><h2 style="margin:0">${esc(t.name)} <span class="small muted">· ${esc(prvdrFor(c))}</span></h2>${taNav(c, "data-ata")}</div>
  <div class="row" style="margin:0 0 8px">${sel.map((x) => `<button class="btn ${x === c ? "primary" : ""}" type="button" data-ata="${x}">${esc(taOf(x).name)}${BATCH.linz[x] ? ` (${allocRows(x).filter((r) => !r.targets.length).length})` : ""}</button>`).join("")}
    <button class="btn" type="button" id="alinz-all">Load LINZ suburbs for all</button></div>
  ${detail}
  <div class="row" style="margin-top:12px"><button class="btn primary" type="button" data-btab="vsuburbs">Next: 2.3 Validate suburbs →</button></div>`;
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
function curAllocRows() { return allocRows(curTA(), store.get("map-all", "0") === "1"); }

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
  BATCH.builder = { ...c, fname }; BATCH.valid = {}; saveSel();
  return `Loaded ${fname}: ${Object.keys(c.prvdrMatches || {}).length - bad} PRVDR matches${bad ? ` (${bad} matched no saved provider)` : ""}, ${n} allocations, keep rule "${BATCH.keep}"`;
}
function exportBuilder() {
  const b = BATCH.builder || {}, roles = { map: "suburb_map", ref: "suburb_ref", provider: "suburb_provider" };
  const inputs = (b.inputs || []).filter((i) => !Object.values(roles).includes(i.role) || !BATCH.fileNames[Object.keys(roles).find((k) => roles[k] === i.role)]);
  for (const [k, r] of Object.entries(roles)) if (BATCH.fileNames[k]) inputs.push({ role: r, file: BATCH.fileNames[k] });
  const nameOf = (code) => (BATCH.providers.find((p) => p.prvdr === code) || {}).name || code;
  const out = { ...b, tool: "NZ Suburb Reference Builder", version: 1, saved: new Date().toISOString().slice(0, 10), inputs,
    settings: { ...(b.settings || {}), keepMode: BATCH.keep },
    prvdrMatches: Object.fromEntries(Object.entries(BATCH.matches).map(([k, v]) => [k.toUpperCase(), nameOf(v)])),
    suburbAllocations: Object.values(BATCH.alloc).map((a) => ({ file: a.file, name: a.name, territory: a.territory || "", linzSuburbs: a.linzSuburbs })),
    suburbPicks: Object.fromEntries(Object.entries(BATCH.picks).map(([c, P]) => [taOf(c).name || c, P])) };
  delete out.fname;
  download("nz_suburb_builder_config.json", JSON.stringify(out, null, 2) + "\n");
}

// ---------------------------------------------------------------- 4. validate suburbs
function similar(a, list) { const n = norm(a); return list.filter((x) => { const m = norm(x); return m.startsWith(n.slice(0, 4)) || n.startsWith(m.slice(0, 4)) || m.includes(n) || n.includes(m); }).slice(0, 3); }
async function validateAll() {
  const sel = [...BATCH.sel].sort();
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
  <div class="row" style="margin-top:16px;justify-content:space-between"><h2 style="margin:0">${esc(t.name || "")} <span class="small muted">· ${esc(prvdrFor(c))}</span></h2>${taNav(c, "data-vta")}</div>${detail}`;
}

// ---------------------------------------------------------------- 5. load
function loadHTML() {
  const sel = [...BATCH.sel].sort(), v = BATCH.valid, ix = Object.fromEntries((D.index_regions || []).map((r) => [r.TA_CODE, r]));
  const notReady = sel.filter((c) => !(v[c] && v[c].status === "done"));
  const blocked = sel.filter((c) => v[c] && v[c].status === "done" && ((v[c].scoped && !v[c].matched.length) || (!v[c].scoped && taOf(c).parts > 1)));
  const budget = (((D.limits || {}).defaults || {}).openmeteo || {}).budget_day || 6000;
  const tot = sel.reduce((t, c) => t + (+((ix[c] || {}).EST_OPENMETEO_CALLS_PER_PART) || 0) * (v[c] && v[c].scoped ? 0.5 : 1), 0);
  return `<div class="card"><h3>Ready to load</h3>
    <table><thead><tr><th class="l">TA</th><th class="l">PRVDR</th><th>Suburbs to load</th><th class="l">Status</th></tr></thead><tbody>${sel.map((c) => { const r = v[c];
      return `<tr><td class="l">${esc(taOf(c).name)}</td><td class="l">${esc(prvdrFor(c))}</td><td>${r && r.status === "done" ? (r.scoped ? r.matched.length : r.linz.length) : "–"}</td>
        <td class="l">${notReady.includes(c) ? '<span class="tag warn">validate first</span>' : blocked.includes(c) ? '<span class="tag bad">nothing to load / too large</span>' : '<span class="tag ok">ready</span>'}</td></tr>`; }).join("")}</tbody></table>
    <p class="small muted">Estimated Open-Meteo use ≈ ${fmt(tot)} weighted calls (budget ${fmt(budget)}/day) → about ${Math.max(1, Math.ceil(tot / budget))} day(s), plus imagery time. Only validated LINZ suburbs are loaded.</p>
    ${can("editor") ? `<button class="btn primary" id="batch-queue" type="button" ${sel.length && !notReady.length && !blocked.length ? "" : "disabled"}>Queue batch (${sel.length} region${sel.length === 1 ? "" : "s"})</button>` : lock("editor", "Queuing batches")}</div>
  ${can("editor") ? progressHTML() : ""}`;
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
  const sc = scopeByTA(), sel = [...BATCH.sel].sort(), v = BATCH.valid;
  const [b] = await q(sb.from("batches").insert({ name: `${BATCH.config ? BATCH.config.name + " · " : ""}${sel.length} region(s), ${new Date().toLocaleDateString("en-NZ")}`, ta_codes: sel, keep_mode: BATCH.keep }).select("id"));
  for (const c of sel) {
    const t = taOf(c), r = v[c], s = sc[c], p = prvdrFor(c);
    const existing = BATCH.regions.find((x) => x.ta_code === c); const id = existing ? existing.id : "ta-" + c;
    const scope = r.scoped ? [...new Set(r.matched.map((m) => m.linz.name))] : null;
    await q(sb.from("regions").upsert({ id, name: t.name + (scope ? ` (${scope.length} suburbs)` : ""), territorial_authorities: [t.name], ta_code: c, scope, prvdr: p, status: existing ? existing.status : "draft", batch_id: b.id }));
    const pairs = (r.pairs || []).filter((m) => m.row || m.manual);
    if (pairs.length || (s && s.rows.length)) {
      const old = await q(sb.from("m_suburbs").select("id").eq("region_id", id).not("source_file", "is", null));
      if (old.length) await q(sb.from("m_suburbs").delete().in("id", old.map((o) => o.id)));
      const rows = [...new Map(pairs.map((m) => { const x = m.row || {};
        return [`${norm(m.mname)}|${norm(m.linz.name)}`, { region_id: id, m_suburb: m.mname, m_territory: x.territory || t.name, prvdr: x.prvdr || p, other_spellings: x.spellings || null, linz_ref: m.linz.name, source_file: m.manual ? "allocation" : x.file }]; })).values()];
      if (rows.length) await q(sb.from("m_suburbs").insert(rows));
    }
    await q(sb.from("jobs").insert({ type: "prepare", region_id: id, batch_id: b.id, status: "queued", params: { steps: ["linz", "imagery_index", "imagery", "census", "publish_new", "climate"] } }));
  }
  toastMsg(`Queued ${sel.length} region job(s): the worker runs them one at a time`);
  await loadBatchData(); drawBatch();
}
async function saveConfig() {
  const name = ($("#cfg-name").value || "").trim(); if (!name) return toastMsg("Give the configuration a name");
  const sc = scopeByTA(), sel = [...BATCH.sel].sort();
  const rec = { name, ta_codes: sel, keep_mode: BATCH.keep, prvdr_by_ta: Object.fromEntries(sel.map((c) => [c, prvdrFor(c)])),
    scope_by_ta: Object.fromEntries(Object.entries(sc).map(([c, s]) => [c, s.keep])), updated_at: new Date().toISOString(),
    prvdr_manual: Object.keys(BATCH.prvdr).filter((c) => BATCH.sel.has(c)),
    suburb_picks: Object.fromEntries(Object.entries(BATCH.picks).filter(([c]) => BATCH.sel.has(c))),
    prvdr_matches: Object.fromEntries(Object.entries(BATCH.matches).map(([k, v]) => [k.toUpperCase(), v])), allocations: Object.values(BATCH.alloc) };
  if (BATCH.config && BATCH.config.name === name) { await q(sb.from("batch_configs").update(rec).eq("id", BATCH.config.id)); }
  else { const [r] = await q(sb.from("batch_configs").insert(rec).select("id")); BATCH.config = { id: r.id, name }; }
  toastMsg(`Saved configuration "${name}"`); await loadBatchData(); drawBatch();
}
function loadConfig(id) {
  const c = BATCH.configs.find((x) => String(x.id) === String(id));
  if (!c) { BATCH.config = null; BATCH.savedScope = null; BATCH.cfgPrvdr = {}; return drawBatch(); }
  BATCH.config = { id: c.id, name: c.name }; BATCH.sel = new Set(c.ta_codes); BATCH.keep = c.keep_mode;
  BATCH.cfgPrvdr = { ...c.prvdr_by_ta }; BATCH.prvdr = Object.fromEntries((c.prvdr_manual || []).filter((k) => c.prvdr_by_ta[k]).map((k) => [k, c.prvdr_by_ta[k]]));
  BATCH.matches = Object.fromEntries(Object.entries(c.prvdr_matches || {}).map(([k, v]) => [norm(k), v]));
  BATCH.alloc = Object.fromEntries((c.allocations || []).map((a) => [allocKey(a.file, a.name, a.territory || ""), a]));
  BATCH.picks = { ...(c.suburb_picks || {}) };
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
  const as0 = cl("[data-asub]"); if (as0 && isSub("allocate") && !BATCH.aPick && !window._dragMoved) { const c = curTA(), S = scopeOf(c); if (!S) return;
    const k = norm(as0.dataset.asub); togglePick(c, as0.dataset.asub, !S.matched.some((m) => norm(m.linz.name) === k)); return drawBatch(); }
  const as = cl("[data-asub]"); if (as && isSub("allocate") && BATCH.aPick && !window._dragMoved) { const r = curAllocRows().find((x) => x.key === BATCH.aPick); if (r) { const cur = r.targets, n = as.dataset.asub;
    setAlloc(r, cur.some((x) => norm(x) === norm(n)) ? cur.filter((x) => norm(x) !== norm(n)) : [...cur, n]); BATCH.aPick = r.key; } return drawBatch(); }
  const ta = cl("[data-ta]"); if (ta && isSub("select") && !window._dragMoved) { const c = ta.dataset.ta; BATCH.sel.has(c) ? BATCH.sel.delete(c) : BATCH.sel.add(c); saveSel(); BATCH.valid = {}; return drawBatch(); }
  const z = cl("[data-zoom]");
  if (z) { const svg = z.closest(".zmap").querySelector("svg"), b = svg.getAttribute("viewBox").split(" ").map(Number), act = z.dataset.zoom;
    if (act === "reset") return setView(svg, svg.dataset.full.split(" ").map(Number));
    if (act === "sel") { const id = z.closest(".zmap").dataset.zmap;
      const g = id === "cfg" ? [...BATCH.sel].map((c) => taOf(c).geom && taOf(c).geom.coordinates).filter(Boolean)
        : id.startsWith("alc-") ? ((scopeOf(id.slice(4)) || {}).matched || []).map((m) => m.linz.geom.coordinates)
        : ((BATCH.valid[id.slice(4)] || {}).matched || []).map((m) => m.linz.geom.coordinates);
      return g.length ? setView(svg, mapBox(g)) : setView(svg, svg.dataset.full.split(" ").map(Number)); }
    const k = act === "in" ? 0.7 : 1 / 0.7, w = b[2] * k, h = b[3] * k; return setView(svg, [b[0] + (b[2] - w) / 2, b[1] + (b[3] - h) / 2, w, h]); }
  const vr = cl("[data-vta]"); if (vr) { BATCH.vTA = vr.dataset.vta; BATCH.view = null; return drawBatch(); }
  if (t.dataset && t.dataset.ata) { BATCH.aTA = t.dataset.ata; BATCH.aPick = null; BATCH.view = null; return drawBatch(); }
  if (t.dataset && t.dataset.alinz) { t.disabled = true; try { await ensureLinz(t.dataset.alinz); } catch (err) { toastMsg("LINZ suburbs: " + err.message); } return drawBatch(); }
  if (t.id === "alinz-all") { t.disabled = true; for (const c of [...BATCH.sel].sort()) { try { await ensureLinz(c); } catch (err) { toastMsg(`${taOf(c).name}: ${err.message}`); } drawBatch(); } return; }
  if (t.dataset && t.dataset.areset) { const r = curAllocRows()[+t.dataset.areset]; if (r) { for (const [k, a] of Object.entries(BATCH.alloc)) if (a === r.alloc) delete BATCH.alloc[k]; BATCH.valid = {}; saveSel(); } return drawBatch(); }
  if (t.dataset && t.dataset.mdel) { delete BATCH.alloc[t.dataset.mdel]; BATCH.valid = {}; saveSel(); return drawBatch(); }
  if (t.id === "mnew") { const c = curTA(), st = (($("#mnew-study") || {}).value || "").trim(), ln = (($("#mnew-linz") || {}).value || "").trim();
    const x = ((BATCH.linz[c] || {}).list || []).find((y) => norm(y.name) === norm(ln));
    if (!st) return toastMsg("Type a study suburb name"); if (!x) return toastMsg(`"${ln}" is not a LINZ suburb in ${taOf(c).name}`);
    mapPair(c, st, x.name); return drawBatch(); }
  if (t.dataset && (t.dataset.aadd || t.dataset.adel || t.dataset.apick)) { const rows = curAllocRows(), r = rows[+(t.dataset.aadd || t.dataset.adel || t.dataset.apick)]; if (!r) return;
    if (t.dataset.apick) { BATCH.aPick = BATCH.aPick === r.key ? null : r.key; return drawBatch(); }
    const cur = r.targets;
    if (t.dataset.adel) { setAlloc(r, cur.filter((x) => x !== t.dataset.aname)); return drawBatch(); }
    const inp = $(`[data-ain="${t.dataset.aadd}"]`), n = t.dataset.aname || (inp && inp.value.trim()), L = (BATCH.linz[BATCH.aTA && BATCH.sel.has(BATCH.aTA) ? BATCH.aTA : [...BATCH.sel].sort()[0]] || {}).list || [];
    const hit = L.find((x) => norm(x.name) === norm(n)); if (!hit) return toastMsg(`"${n || ""}" is not a LINZ suburb in this TA`);
    if (!cur.includes(hit.name)) setAlloc(r, [...cur, hit.name]); return drawBatch(); }
  if (t.id === "apick-done") { BATCH.aPick = null; return drawBatch(); }
  if (t.dataset && t.dataset.pall) { const c = curTA(), S = scopeOf(c); if (!S) return; const f = norm(store.get("apick-filter", ""));
    for (const m of S.base) if (!f || norm(m.linz.name).includes(f)) togglePick(c, m.linz.name, t.dataset.pall === "on");
    if (t.dataset.pall === "off") for (const m of S.matched.filter((m) => m.added)) if (!f || norm(m.linz.name).includes(f)) togglePick(c, m.linz.name, false);
    return drawBatch(); }
  if (t.id === "padd") { const c = curTA(), n = ($("#padd-in") || {}).value || "", x = ((BATCH.linz[c] || {}).list || []).find((y) => norm(y.name) === norm(n.trim()));
    if (!x) return toastMsg(`"${n}" is not a LINZ suburb in ${taOf(c).name}`); togglePick(c, x.name, true); return drawBatch(); }
  if (t.dataset && t.dataset.punmatch) { delete BATCH.matches[t.dataset.punmatch]; BATCH.valid = {}; saveSel(); return drawBatch(); }
  if (t.id === "bcfg-export") return exportBuilder();
  if (t.id === "bcfg-clear") { BATCH.builder = null; return drawBatch(); }
  if (t.dataset && t.dataset.tprvdrReset) { delete BATCH.prvdr[t.dataset.tprvdrReset]; saveSel(); return drawBatch(); }
  if (t.dataset && t.dataset.tunsel) { BATCH.sel.delete(t.dataset.tunsel); saveSel(); return drawBatch(); }
  if (t.dataset && t.dataset.sclear) { delete BATCH.files[t.dataset.sclear]; delete BATCH.fileNames[t.dataset.sclear]; BATCH.valid = {}; return drawBatch(); }
  if (t.id === "sel-found") { for (const c of tasInFiles()) BATCH.sel.add(c); saveSel(); BATCH.valid = {}; return drawBatch(); }
  if (t.id === "batch-clear") { BATCH.sel.clear(); BATCH.valid = {}; saveSel(); return drawBatch(); }
  if (t.id === "bta-all" || t.id === "bta-none") { const f = norm(store.get("bta-filter", "")); for (const x of BATCH.tas) if (!f || norm([x.name, (x.prvdrs || []).join(" "), x.rc].join(" ")).includes(f)) t.id === "bta-all" ? BATCH.sel.add(x.code) : BATCH.sel.delete(x.code); saveSel(); BATCH.valid = {}; return drawBatch(); }
  if (t.id === "validate-go" && can("editor")) { t.disabled = true; try { await validateAll(); } finally { t.disabled = false; } return; }
  if (t.id === "batch-queue" && can("editor")) { t.disabled = true; try { await queueBatch(); } catch (err) { toastMsg("Not queued: " + err.message); t.disabled = false; } return; }
  if (t.id === "cfg-save" && can("editor")) { try { await saveConfig(); } catch (err) { toastMsg("Not saved: " + err.message); } return; }
  if (t.id === "cfg-del" && BATCH.config && confirm(`Delete configuration "${BATCH.config.name}"?`)) { try { await q(sb.from("batch_configs").delete().eq("id", BATCH.config.id)); BATCH.config = null; await loadBatchData(); drawBatch(); } catch (err) { toastMsg(err.message); } return; }
  if (t.id === "batch-refresh") { await loadBatchData(); return drawBatch(); }
  if (t.dataset && t.dataset.tiles) return tileCSV(+t.dataset.tiles).catch((err) => toastMsg(err.message));
  if (t.dataset && t.dataset.publish && can("editor")) { try { await q(sb.from("regions").update({ status: "published" }).eq("id", t.dataset.publish)); toastMsg("Published: reload to add it to the region list"); await loadBatchData(); drawBatch(); } catch (err) { toastMsg(err.message); } }
});
document.addEventListener("change", async (e) => {
  const t = e.target;
  if (t.dataset && t.dataset.tsel) { t.checked ? BATCH.sel.add(t.dataset.tsel) : BATCH.sel.delete(t.dataset.tsel); saveSel(); BATCH.valid = {}; return drawBatch(); }
  if (t.dataset && t.dataset.tprvdr) { const c = t.dataset.tprvdr, auto = (filePrvdr(c) || {}).code || BATCH.cfgPrvdr[c] || (taOf(c).prvdrs || [])[0];
    t.value === auto ? delete BATCH.prvdr[c] : BATCH.prvdr[c] = t.value; saveSel(); return drawBatch(); }
  if (t.id === "batch-keep") { BATCH.keep = t.value; store.set("batch-keep", t.value); BATCH.valid = {}; return drawBatch(); }
  if (t.id === "cfg-pick") return loadConfig(t.value);
  if (t.id === "map-all") { store.set("map-all", t.checked ? "1" : "0"); BATCH.aPick = null; return drawBatch(); }
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
    BATCH.files[t.dataset.sfile] = readCSV(await t.files[0].text()); BATCH.fileNames[t.dataset.sfile] = t.files[0].name; BATCH.savedScope = null; BATCH.valid = {};
    toastMsg(`${BATCH.files[t.dataset.sfile].length} rows read; applied to ${Object.keys(scopeByTA()).length} selected TA(s)`); return drawBatch();
  }
});
document.addEventListener("input", (e) => { if (e.target.id === "apick-filter") { store.set("apick-filter", e.target.value); clearTimeout(window._af); window._af = setTimeout(() => { drawBatch(); const f = $("#apick-filter"); if (f) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); } }, 250); return; }
  if (e.target.id === "bta-filter") { store.set("bta-filter", e.target.value); clearTimeout(window._bf); window._bf = setTimeout(() => { drawBatch(); const f = $("#bta-filter"); if (f) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); } }, 250); } });

// stage headings take their number from the stage bar (stages were inserted and replaced)
STAGES.forEach(([id], i) => { const f = V[id]; if (f) V[id] = (...a) => f(...a).replace(/<h1>\d+ · /, `<h1>${i + 1} · `); });
