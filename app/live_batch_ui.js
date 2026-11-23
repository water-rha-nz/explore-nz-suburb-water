// Batch preparation in three steps: Configure (TAs, PRVDRs, scope lists, saved configurations), Validate (scoped suburb
// names checked against LINZ, located suburbs on the map), Load (queue one job per region, progress, tile lists).
// Uploaded files are read in the browser only; configurations keep the resulting suburb names, never file contents.
"use strict";
STAGES.splice(1, 0, ["batch", "Batch"]);
const BATCH = { tas: null, providers: [], sel: new Set(JSON.parse(store.get("batch-sel", "[]"))), prvdr: JSON.parse(store.get("batch-prvdr", "{}")),
  files: {}, keep: store.get("batch-keep", "any"), tab: store.get("batch-tab", "configure"), config: null, configs: [], valid: {}, vTA: null,
  batches: [], jobs: [], regions: [], view: null, savedScope: null };
const norm = (s) => String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
const saveSel = () => { store.set("batch-sel", JSON.stringify([...BATCH.sel])); store.set("batch-prvdr", JSON.stringify(BATCH.prvdr)); };
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
  const u = String(v || "").trim().toUpperCase(); if (!u) return null;
  const p = BATCH.providers.find((x) => x.prvdr === u || (x.legacy_prvdr || "").toUpperCase() === u || (x.aliases || []).some((a) => a.toUpperCase() === u) || x.name.toUpperCase() === u);
  return p ? p.prvdr : null;
}
// TAs a row belongs to: by M_TERRITORY; by PRVDR only when the row has no territory
function rowTAs(territory, prvdr) {
  const t = norm(territory).replace(/ (district|city|territory)$/, "");
  if (t) return (BATCH.tas || []).filter((x) => { const n = norm(x.name).replace(/ (district|city|territory)$/, ""); return n === t || (t === "hutt" && n === "lower hutt"); }).map((x) => x.code);
  const p = prvdrCode(prvdr);
  return p ? (BATCH.tas || []).filter((x) => (x.prvdrs || []).includes(p)).map((x) => x.code) : [];
}
// per selected TA: { lists, rows, keep, basis }. Rows for TAs that are not selected are ignored (files never change the selection).
function scopeByTA() {
  const out = {}, sel = BATCH.sel;
  const add = (code, list, name, row) => { if (!sel.has(code)) return; const o = out[code] = out[code] || { lists: {}, rows: [] }; (o.lists[list] = o.lists[list] || new Set()).add(name); if (row) o.rows.push(row); };
  for (const r of BATCH.files.map || []) { const name = r.NZ_SUBURB_REF || r.M_SUBURB; if (!name) continue;
    for (const c of rowTAs(r.M_TERRITORY, r.PROVIDER)) add(c, "map", name, { m_suburb: r.M_SUBURB || name, linz_ref: name, territory: r.M_TERRITORY, prvdr: prvdrCode(r.PROVIDER), file: "nz_suburb_map.csv" }); }
  for (const r of BATCH.files.ref || []) { if (!r.M_SUBURB) continue;
    for (const c of rowTAs(r.M_TERRITORY, r.PRVDR || r.PROVIDER)) add(c, "ref", r.M_SUBURB, { m_suburb: r.M_SUBURB, linz_ref: r.M_SUBURB, territory: r.M_TERRITORY, file: "nz_suburb_ref.csv" }); }
  for (const r of BATCH.files.provider || []) { if (!r.M_SUBURB) continue;
    const other = (r["OTHER SPELLINGS"] || r.OTHER_SPELLINGS || "").split(/[;,|/]/).map((x) => x.trim()).filter(Boolean);
    for (const c of rowTAs(r.M_TERRITORY, r.PRVDR)) { add(c, "provider", r.M_SUBURB, { m_suburb: r.M_SUBURB, linz_ref: r.M_SUBURB, territory: r.M_TERRITORY, prvdr: prvdrCode(r.PRVDR), spellings: other, file: "nz_suburb_provider.csv" });
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
  for (const r of BATCH.files.provider || []) rowTAs(r.M_TERRITORY, r.PRVDR).forEach((c) => s.add(c));
  return [...s].sort();
}
// PRVDR per TA: chosen by hand > allocated by nz_suburb_provider.csv (most common code among the TA's rows) > the TA's provider
function filePrvdr(c) {
  const n = {};
  for (const r of BATCH.files.provider || []) { const p = prvdrCode(r.PRVDR); if (p && rowTAs(r.M_TERRITORY, r.PRVDR).includes(c)) n[p] = (n[p] || 0) + 1; }
  const best = Object.entries(n).sort((a, b) => b[1] - a[1])[0]; return best ? best[0] : null;
}
const prvdrFor = (c) => BATCH.prvdr[c] || filePrvdr(c) || (taOf(c).prvdrs || [])[0] || "";
const prvdrSource = (c) => BATCH.prvdr[c] ? "chosen" : filePrvdr(c) ? "from nz_suburb_provider.csv" : "TA default";
const rateFor = (p) => (D.water_rates || []).find((w) => w.PROVIDER === p);

// ---------------------------------------------------------------- data
async function loadBatchData() {
  if (!BATCH.tas) BATCH.tas = await q(sb.rpc("ta_outlines", { p_tol: 200 }));
  if (!BATCH.providers.length) BATCH.providers = await q(sb.from("providers").select("prvdr,legacy_prvdr,name,aliases,territories").order("prvdr"));
  if (can("editor")) {
    BATCH.configs = await q(sb.from("batch_configs").select("id,name,ta_codes,keep_mode,prvdr_by_ta,scope_by_ta,updated_at").order("updated_at", { ascending: false }));
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
  const v = (BATCH.view && BATCH.view.id === id) ? BATCH.view.box : full, sw = v[2] / 600;
  return `<div class="zmap" data-zmap="${id}" style="position:relative">
    <div class="row" style="position:absolute;right:6px;top:6px;gap:4px;z-index:2"><button class="btn" type="button" data-zoom="in" aria-label="Zoom in">+</button><button class="btn" type="button" data-zoom="out" aria-label="Zoom out">−</button>
    <button class="btn" type="button" data-zoom="sel">Selection</button><button class="btn" type="button" data-zoom="reset">Reset</button></div>
    <svg viewBox="${v.join(" ")}" data-full="${full.join(" ")}" style="width:100%;height:440px;display:block;touch-action:none;background:var(--bg);border-radius:8px" role="img" aria-label="Map: scroll to zoom, drag to pan">
    ${layers.map((l) => `<path ${l.attr || ""} d="${l.d}" fill="${l.fill}" fill-opacity="${l.op ?? 1}" stroke="${l.stroke || "var(--landline)"}" stroke-width="${(l.sw || 0.8) * sw}" vector-effect="non-scaling-stroke" ${l.click ? 'style="cursor:pointer"' : ""}><title>${esc(l.title || "")}</title></path>`).join("")}</svg></div>`;
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
V.batch = () => {
  setTimeout(async () => { try { await loadBatchData(); drawBatch(); } catch (e) { const el = $("#batch-body"); if (el) el.innerHTML = `<p class="muted">${esc(e.message)}</p>`; } }, 0);
  const tabs = [["configure", "1 · Configure"], ["validate", "2 · Validate"], ["load", "3 · Load"]];
  return `<h1>Batch preparation</h1><p class="lead">Configure which territorial authorities to prepare, validate the suburbs in scope against LINZ, then load them. Each region runs as its own job within the free-tier budgets, and data already stored by anyone is reused.</p>
  <div class="row" role="tablist" style="margin-bottom:12px">${tabs.map(([k, l]) => `<button class="btn ${BATCH.tab === k ? "primary" : ""}" role="tab" aria-selected="${BATCH.tab === k}" data-btab="${k}" type="button">${l}</button>`).join("")}</div>
  <div id="batch-body"><p class="muted">Loading…</p></div>`;
};
function drawBatch() { const el = $("#batch-body"); if (!el || !BATCH.tas) return; el.innerHTML = { configure: configureHTML, validate: validateHTML, load: loadHTML }[BATCH.tab](); }

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
      <td class="l"><select data-tprvdr="${c}" aria-label="PRVDR for ${esc(t.name)}">${opts(p)}</select><br><span class="small muted">${prvdrSource(c)}${BATCH.prvdr[c] ? ` · <button class="btn" type="button" data-tprvdr-reset="${c}" style="padding:1px 6px">reset</button>` : ""}</span></td><td class="l small" style="white-space:normal;min-width:260px">${rate}</td>
      <td><button class="btn" type="button" data-tunsel="${c}" aria-label="Remove ${esc(t.name)}">×</button></td></tr>`; }).join("");
  return `<div class="grid g2">
    <div class="card">${zoomMap("cfg", layers, mapBox(BATCH.tas.map((t) => t.geom.coordinates)))}<p class="small muted" style="margin:6px 0 0">Scroll to zoom, drag to pan, click a TA to select it.</p></div>
    <div class="card"><h3>Saved configurations</h3>
      ${can("editor") ? `<div class="row"><select id="cfg-pick" aria-label="Saved configuration"><option value="">New configuration</option>${BATCH.configs.map((c) => `<option value="${c.id}" ${BATCH.config && BATCH.config.id === c.id ? "selected" : ""}>${esc(c.name)} (${c.ta_codes.length} TAs)</option>`).join("")}</select>
        <input type="text" id="cfg-name" placeholder="Name" value="${esc(BATCH.config ? BATCH.config.name : "")}" style="width:160px"><button class="btn" id="cfg-save" type="button">Save</button>${BATCH.config ? '<button class="btn" id="cfg-del" type="button">Delete</button>' : ""}</div>
        <p class="small muted">Stores the selected TAs, PRVDRs, keep rule and the resulting suburb names, not your files. Only you can see your configurations.</p>` : lock("editor", "Saving configurations")}
      <h3 style="margin-top:12px">Scope lists (optional)</h3>
      <p class="small muted">Read in your browser and applied to the selected TAs only.</p>
      ${[["map", "nz_suburb_map.csv", "M_SUBURB, PROVIDER, NZ_SUBURB_REF, M_TERRITORY"], ["ref", "nz_suburb_ref.csv", "M_SUBURB, …, M_TERRITORY"], ["provider", "nz_suburb_provider.csv", "M_SUBURB, Other spellings, PRVDR"]].map(([k, f, cols]) =>
        `<p class="small" style="margin:6px 0"><label><b>${f}</b> <input type="file" accept=".csv,.tsv,text/csv" data-sfile="${k}"></label>${BATCH.files[k] ? ` <span class="tag info">${BATCH.files[k].length} rows</span> <button class="btn" type="button" data-sclear="${k}">Clear</button>` : ""}<br><span class="muted">${cols}</span></p>`).join("")}
      <p class="small"><label>With both keep-lists, keep a suburb that is in <select id="batch-keep"><option value="any" ${BATCH.keep === "any" ? "selected" : ""}>either list</option><option value="both" ${BATCH.keep === "both" ? "selected" : ""}>both lists</option></select></label></p>
      ${newFound.length ? `<p class="small">Your files also mention ${newFound.length} TA(s) that aren't selected: ${newFound.map((c) => esc(taOf(c).name)).join(", ")}. <button class="btn" id="sel-found" type="button">Select them</button></p>` : ""}
    </div></div>
  <h2>Selected TAs (${sel.length}): PRVDR and charging rates</h2>
  <div class="card scroll">${sel.length ? `<table><thead><tr><th class="l">TA and scope</th><th class="l">PRVDR</th><th class="l">Charging (2026/27)</th><th></th></tr></thead><tbody>${selRows}</tbody></table>` : '<p class="muted">Select TAs on the map or in the table below.</p>'}
    ${sel.length ? `<div class="row" style="margin-top:8px"><button class="btn primary" type="button" data-btab="validate">Next: validate suburbs →</button><button class="btn" id="batch-clear" type="button">Clear selection</button></div>` : ""}</div>
  <h2>All regions with charging rates (${BATCH.tas.length} TAs)</h2>
  <div class="row" style="margin-bottom:8px"><label class="small">Filter <input type="text" id="bta-filter" value="${esc(filt)}" placeholder="TA, PRVDR or region"></label>
    <button class="btn" type="button" id="bta-all">Select shown</button><button class="btn" type="button" id="bta-none">Deselect shown</button></div>
  <div class="card scroll" style="max-height:320px;overflow:auto"><table><thead><tr><th></th><th class="l">TA</th><th class="l">PRVDR</th><th class="l">Region</th><th>SA2s</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

// ---------------------------------------------------------------- 2. validate
function similar(a, list) { const n = norm(a); return list.filter((x) => { const m = norm(x); return m.startsWith(n.slice(0, 4)) || n.startsWith(m.slice(0, 4)) || m.includes(n) || n.includes(m); }).slice(0, 3); }
async function validateAll() {
  const sc = scopeByTA(), sel = [...BATCH.sel].sort();
  for (const c of sel) {
    BATCH.valid[c] = { status: "checking" }; drawBatch();
    try {
      const { data, error } = await sb.functions.invoke("linz-suburbs", { body: { ta_code: c } });
      if (error) { let m = error.message; try { m = (await error.context.json()).error || m; } catch (_) { /* keep message */ } throw new Error(m); }
      const res = await q(sb.rpc("ta_suburbs", { p_ta: c, p_tol: 20 }));
      const linz = res.suburbs || [], s = sc[c];
      const byNorm = new Map(); for (const x of linz) { byNorm.set(norm(x.name), x); if (x.name_ascii) byNorm.set(norm(x.name_ascii), x); }
      let matched = [], unmatched = [];
      if (s) { for (const n of s.keep) { const hit = byNorm.get(norm(n)); hit ? matched.push({ input: n, linz: hit }) : unmatched.push(n); }
        matched = [...new Map(matched.map((m) => [m.linz.id, m])).values()]; }
      // other spellings that didn't match are not errors when their suburb matched under another name
      const spell = new Set((s ? s.rows : []).flatMap((r) => r.spellings || []).map(norm));
      unmatched = unmatched.filter((n) => !(spell.has(norm(n)) && matched.length));
      BATCH.valid[c] = { status: "done", linz, matched, unmatched, scoped: !!s, cached: data && data.cached, requests: (data && data.requests) || 0 };
    } catch (err) { BATCH.valid[c] = { status: "error", message: err.message }; }
    drawBatch();
  }
  if (!BATCH.vTA) BATCH.vTA = sel[0]; drawBatch();
}
function validateHTML() {
  const sel = [...BATCH.sel].sort(); if (!sel.length) return `<p class="muted">Select TAs on the Configure tab first.</p>`;
  const v = BATCH.valid, done = sel.every((c) => v[c] && v[c].status === "done");
  const rows = sel.map((c) => { const t = taOf(c), r = v[c];
    const st = !r ? '<span class="muted">not checked</span>' : r.status === "checking" ? '<span class="tag warn">checking…</span>' : r.status === "error" ? `<span class="tag bad">${esc(r.message)}</span>`
      : r.scoped ? `<span class="tag ${r.unmatched.length ? "warn" : "ok"}">${r.matched.length} matched${r.unmatched.length ? `, ${r.unmatched.length} not found` : ""}</span>` : `<span class="tag ok">whole TA: ${r.linz.length} suburbs</span>`;
    return `<tr data-vta="${c}" style="cursor:pointer${BATCH.vTA === c ? ";background:var(--accent-soft)" : ""}"><td class="l">${esc(t.name)}</td><td class="l">${st}</td><td class="small muted">${r && r.status === "done" ? (r.cached ? "from shared cache" : `${r.requests} LINZ request`) : ""}</td></tr>`; }).join("");
  const c = BATCH.vTA && sel.includes(BATCH.vTA) ? BATCH.vTA : sel[0], r = v[c], t = taOf(c);
  let detail = `<p class="muted">Press <b>Validate suburbs</b>.</p>`;
  if (r && r.status === "done") {
    const ids = new Set(r.matched.map((m) => m.linz.id)), scoped = r.scoped;
    const layers = [{ d: pathD(t.geom.coordinates), fill: "var(--land)", stroke: "var(--ink)", sw: 1.4, title: t.name },
      ...r.linz.map((x) => ({ d: pathD(x.geom.coordinates), fill: !scoped || ids.has(x.id) ? "var(--accent)" : "var(--land)", op: !scoped || ids.has(x.id) ? 0.65 : 0.6, sw: 0.8, title: `${x.name}${scoped && !ids.has(x.id) ? " (not in scope)" : ""}` }))];
    detail = `<div class="grid g2"><div class="card">${zoomMap("val-" + c, layers, mapBox([t.geom.coordinates]))}<p class="small muted" style="margin:6px 0 0">Blue = suburbs that will be loaded${scoped ? "; grey = LINZ suburbs not in your lists" : ""}.</p></div>
      <div class="card scroll"><h3>${esc(t.name)}</h3>
      ${scoped ? `<p class="small"><b>${r.matched.length}</b> of your names matched LINZ suburbs.</p>
        ${r.unmatched.length ? `<p class="small"><span class="tag warn">Not found in LINZ</span> ${r.unmatched.map((n) => { const sug = similar(n, r.linz.map((x) => x.name)); return `<br>· ${esc(n)}${sug.length ? ` <span class="muted">→ did you mean ${sug.map(esc).join(", ")}?</span>` : ""}`; }).join("")}</p>
        <p class="small muted">Fix the names in your list (put the LINZ name in NZ_SUBURB_REF) and upload it again. Names not found aren't loaded.</p>` : ""}
        <table><thead><tr><th class="l">Your name</th><th class="l">LINZ suburb</th><th class="l">Type</th></tr></thead><tbody>${r.matched.map((m) => `<tr><td class="l">${esc(m.input)}</td><td class="l">${esc(m.linz.name)}</td><td class="l small">${esc(m.linz.type || "")}</td></tr>`).join("")}</tbody></table>`
      : `<p class="small">No suburb list for this TA: all ${r.linz.length} LINZ suburbs and localities will be loaded${t.parts > 1 ? ', <span class="tag bad">too large: add a suburb list</span>' : ""}.</p>`}</div></div>`;
  }
  return `<div class="card"><div class="row" style="justify-content:space-between"><h3 style="margin:0">Suburbs in scope, checked against LINZ</h3>
    ${can("editor") ? '<button class="btn primary" id="validate-go" type="button">Validate suburbs</button>' : lock("editor", "Validation")}</div>
    <p class="small muted">Each TA's LINZ suburbs are fetched once and cached for everyone, so validating again, or later, makes no request. Click a row to see it on the map.</p>
    <table><tbody>${rows}</tbody></table>
    ${done ? '<div class="row" style="margin-top:8px"><button class="btn primary" type="button" data-btab="load">Next: load →</button></div>' : ""}</div>
  <h2 style="margin-top:16px">${esc(t.name || "")}</h2>${detail}`;
}

// ---------------------------------------------------------------- 3. load
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
    if (s && s.rows.length) {
      const old = await q(sb.from("m_suburbs").select("id").eq("region_id", id).not("source_file", "is", null));
      if (old.length) await q(sb.from("m_suburbs").delete().in("id", old.map((o) => o.id)));
      const ok = new Set(r.matched.map((m) => norm(m.input)));
      const rows = s.rows.filter((x) => ok.has(norm(x.linz_ref)) || ok.has(norm(x.m_suburb)));
      if (rows.length) await q(sb.from("m_suburbs").insert(rows.map((x) => ({ region_id: id, m_suburb: x.m_suburb, m_territory: x.territory || t.name, prvdr: x.prvdr || p, other_spellings: x.spellings || null, linz_ref: x.linz_ref, source_file: x.file }))));
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
    scope_by_ta: Object.fromEntries(Object.entries(sc).map(([c, s]) => [c, s.keep])), updated_at: new Date().toISOString() };
  if (BATCH.config && BATCH.config.name === name) { await q(sb.from("batch_configs").update(rec).eq("id", BATCH.config.id)); }
  else { const [r] = await q(sb.from("batch_configs").insert(rec).select("id")); BATCH.config = { id: r.id, name }; }
  toastMsg(`Saved configuration "${name}"`); await loadBatchData(); drawBatch();
}
function loadConfig(id) {
  const c = BATCH.configs.find((x) => String(x.id) === String(id));
  if (!c) { BATCH.config = null; BATCH.savedScope = null; return drawBatch(); }
  BATCH.config = { id: c.id, name: c.name }; BATCH.sel = new Set(c.ta_codes); BATCH.prvdr = { ...c.prvdr_by_ta }; BATCH.keep = c.keep_mode;
  BATCH.savedScope = c.scope_by_ta || {}; BATCH.files = {}; BATCH.valid = {}; saveSel(); toastMsg(`Loaded "${c.name}"`); drawBatch();
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
  const tab = cl("[data-btab]"); if (tab && stage === "batch") { BATCH.tab = tab.dataset.btab; store.set("batch-tab", BATCH.tab); BATCH.view = null; return render(); }
  const ta = cl("[data-ta]"); if (ta && stage === "batch" && !window._dragMoved) { const c = ta.dataset.ta; BATCH.sel.has(c) ? BATCH.sel.delete(c) : BATCH.sel.add(c); saveSel(); BATCH.valid = {}; return drawBatch(); }
  const z = cl("[data-zoom]");
  if (z) { const svg = z.closest(".zmap").querySelector("svg"), b = svg.getAttribute("viewBox").split(" ").map(Number), act = z.dataset.zoom;
    if (act === "reset") return setView(svg, svg.dataset.full.split(" ").map(Number));
    if (act === "sel") { const id = z.closest(".zmap").dataset.zmap;
      const g = id === "cfg" ? [...BATCH.sel].map((c) => taOf(c).geom && taOf(c).geom.coordinates).filter(Boolean) : ((BATCH.valid[id.slice(4)] || {}).matched || []).map((m) => m.linz.geom.coordinates);
      return g.length ? setView(svg, mapBox(g)) : setView(svg, svg.dataset.full.split(" ").map(Number)); }
    const k = act === "in" ? 0.7 : 1 / 0.7, w = b[2] * k, h = b[3] * k; return setView(svg, [b[0] + (b[2] - w) / 2, b[1] + (b[3] - h) / 2, w, h]); }
  const vr = cl("[data-vta]"); if (vr) { BATCH.vTA = vr.dataset.vta; BATCH.view = null; return drawBatch(); }
  if (t.dataset && t.dataset.tprvdrReset) { delete BATCH.prvdr[t.dataset.tprvdrReset]; saveSel(); return drawBatch(); }
  if (t.dataset && t.dataset.tunsel) { BATCH.sel.delete(t.dataset.tunsel); saveSel(); return drawBatch(); }
  if (t.dataset && t.dataset.sclear) { delete BATCH.files[t.dataset.sclear]; BATCH.valid = {}; return drawBatch(); }
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
  if (t.dataset && t.dataset.tprvdr) { BATCH.prvdr[t.dataset.tprvdr] = t.value; saveSel(); return drawBatch(); }
  if (t.id === "batch-keep") { BATCH.keep = t.value; store.set("batch-keep", t.value); BATCH.valid = {}; return drawBatch(); }
  if (t.id === "cfg-pick") return loadConfig(t.value);
  if (t.dataset && t.dataset.sfile && t.files && t.files[0]) {
    BATCH.files[t.dataset.sfile] = readCSV(await t.files[0].text()); BATCH.savedScope = null; BATCH.valid = {};
    toastMsg(`${BATCH.files[t.dataset.sfile].length} rows read; applied to ${Object.keys(scopeByTA()).length} selected TA(s)`); return drawBatch();
  }
});
document.addEventListener("input", (e) => { if (e.target.id === "bta-filter") { store.set("bta-filter", e.target.value); clearTimeout(window._bf); window._bf = setTimeout(() => { drawBatch(); const f = $("#bta-filter"); if (f) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); } }, 250); } });
