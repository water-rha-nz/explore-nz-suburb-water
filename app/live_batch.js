// Batch preparation (select TAs on the map, scope with the user's lists, queue, track, download tiles) and
// per-user API keys. Loaded after live.js.
"use strict";
STAGES.splice(1, 0, ["batch", "Batch"]);
const BATCH = { tas: null, sel: new Set(JSON.parse(store.get("batch-sel", "[]"))), files: {}, keep: store.get("batch-keep", "any"), batches: [], jobs: [], regions: [] };
const norm = (s) => String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
const saveSel = () => store.set("batch-sel", JSON.stringify([...BATCH.sel]));

// ---------------------------------------------------------------- scope files (rules of the original suburb_lookup.html)
function readCSV(text) {
  const first = text.split(/\r?\n/, 1)[0] || "";
  const sep = (first.match(/\t/g) || []).length > (first.match(/,/g) || []).length ? "\t" : ",";
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) { const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { f += '"'; i++; } else if (c === '"') q = false; else f += c; }
    else if (c === '"') q = true; else if (c === sep) { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(f); rows.push(row); row = []; f = ""; } else f += c; }
  if (f || row.length) { row.push(f); rows.push(row); }
  const all = rows.filter((r) => r.some((x) => x.trim() !== ""));
  if (!all.length) return [];
  const h = all[0].map((x) => x.trim().toUpperCase().replace(/^﻿/, ""));
  return all.slice(1).map((r) => Object.fromEntries(h.map((k, i) => [k, (r[i] || "").trim()])));
}
function taFor(territory, prvdr) {
  const t = norm(territory).replace(/ (district|city|territory)$/, "");
  const hit = t ? (BATCH.tas || []).filter((x) => { const n = norm(x.name).replace(/ (district|city|territory)$/, ""); return n === t || norm(x.name) === norm(territory) || (t === "hutt" && n === "lower hutt"); }) : [];
  if (hit.length) return hit.map((x) => x.code);
  if (prvdr) { const p = String(prvdr).toUpperCase(); return (BATCH.tas || []).filter((x) => (x.prvdrs || []).includes(p)).map((x) => x.code); }
  return [];
}
// per TA: { lists: {map:Set, ref:Set, provider:Set}, rows: [{m_suburb, linz_ref, territory, prvdr, spellings, file}] }
function scopeByTA() {
  const out = {};
  const add = (code, list, name, row) => { const o = out[code] = out[code] || { lists: {}, rows: [] }; (o.lists[list] = o.lists[list] || new Set()).add(name); if (row) o.rows.push(row); };
  for (const r of BATCH.files.map || []) {
    const name = r.NZ_SUBURB_REF || r.M_SUBURB; if (!name) continue;
    for (const c of taFor(r.M_TERRITORY, r.PROVIDER)) add(c, "map", name, { m_suburb: r.M_SUBURB || name, linz_ref: name, territory: r.M_TERRITORY, prvdr: r.PROVIDER, file: "nz_suburb_map.csv" });
  }
  for (const r of BATCH.files.ref || []) {
    if (!r.M_SUBURB) continue;
    for (const c of taFor(r.M_TERRITORY, r.PRVDR || r.PROVIDER)) add(c, "ref", r.M_SUBURB, { m_suburb: r.M_SUBURB, linz_ref: r.M_SUBURB, territory: r.M_TERRITORY, file: "nz_suburb_ref.csv" });
  }
  for (const r of BATCH.files.provider || []) {
    if (!r.M_SUBURB) continue;
    const other = (r["OTHER SPELLINGS"] || r.OTHER_SPELLINGS || "").split(/[;,|/]/).map((x) => x.trim()).filter(Boolean);
    for (const c of taFor(r.M_TERRITORY, r.PRVDR)) { add(c, "provider", r.M_SUBURB, { m_suburb: r.M_SUBURB, linz_ref: r.M_SUBURB, territory: r.M_TERRITORY, prvdr: r.PRVDR, spellings: other, file: "nz_suburb_provider.csv" });
      for (const o of other) add(c, "provider", o); }
  }
  // keep rule (as suburb_lookup.html): nz_suburb_map.csv and nz_suburb_ref.csv are the keep-lists; with both given for a TA,
  // keep a suburb when it is in either (any) or in both (both). nz_suburb_provider.csv assigns PRVDRs and other spellings;
  // it scopes a TA only when neither keep-list covers that TA.
  for (const o of Object.values(out)) {
    const keepLists = ["map", "ref"].filter((k) => o.lists[k]);
    const use = keepLists.length ? keepLists : ["provider"];
    const sets = use.map((k) => new Set([...o.lists[k]].map(norm)));
    const all = use.flatMap((k) => [...o.lists[k]]);
    let keep = all.filter((n) => BATCH.keep === "any" || sets.every((st) => st.has(norm(n))));
    // other spellings from the provider file are added for suburbs that are kept (LINZ may use either spelling)
    if (o.lists.provider && keepLists.length) for (const r of o.rows.filter((r) => r.file === "nz_suburb_provider.csv"))
      if (keep.some((k) => norm(k) === norm(r.m_suburb) || (r.spellings || []).some((x) => norm(x) === norm(k)))) keep.push(r.m_suburb, ...(r.spellings || []));
    o.keep = [...new Map(keep.map((n) => [norm(n), n])).values()];
    o.basis = use.join(" + ");
  }
  return out;
}

// ---------------------------------------------------------------- data
async function loadBatchData() {
  if (!BATCH.tas) BATCH.tas = await q(sb.rpc("ta_outlines", { p_tol: 400 }));
  if (can("editor")) {
    BATCH.batches = await q(sb.from("batches").select("*").order("id", { ascending: false }).limit(10));
    BATCH.regions = await q(sb.from("regions").select("id,name,ta_code,status,scope,batch_id,imagery_captures"));
    const ids = BATCH.regions.filter((r) => r.batch_id).map((r) => r.id);
    BATCH.jobs = ids.length ? await q(sb.from("jobs").select("id,region_id,status,reason,batch_id,created_at").in("region_id", ids).order("id", { ascending: false })) : [];
  }
}
const idx = () => Object.fromEntries((D.index_regions || []).map((r) => [r.TA_CODE, r]));

// ---------------------------------------------------------------- stage
V.batch = () => {
  setTimeout(async () => { try { await loadBatchData(); drawBatch(); } catch (e) { $("#batch-body").innerHTML = `<p class="muted">${esc(e.message)}</p>`; } }, 0);
  return `<h1>Batch preparation</h1><p class="lead">Select the territorial authorities to prepare by clicking them on the map or ticking them in the table. Optionally limit each to the suburbs in your lists (<code>nz_suburb_map.csv</code>, <code>nz_suburb_provider.csv</code>, <code>nz_suburb_ref.csv</code>). Each region becomes its own job, run one at a time within the free-tier budgets, so a large batch is spread over several days. Data already stored, by any user, is shared and reused (suburbs, sections, buildings, SA2s, census, imagery tiles, climate), so your keys are only used for what is missing.</p>
  <div id="batch-body"><p class="muted">Loading the map…</p></div>`;
};
function taMap() {
  const tas = BATCH.tas || []; let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const t of tas) for (const p of t.geom.coordinates) for (const r of p) for (const [x, y] of r) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const W = 520, sc = W / (x1 - x0), H = Math.round((y1 - y0) * sc);
  const P = (r) => r.map(([x, y], i) => (i ? "L" : "M") + ((x - x0) * sc).toFixed(1) + "," + ((y1 - y) * sc).toFixed(1)).join("") + "Z";
  const ready = new Set(Object.values(D.regions).map((g) => g.ta_code).filter(Boolean));
  return `<svg viewBox="-2 -2 ${W + 4} ${H + 4}" role="img" aria-label="Territorial authorities; click to select">${tas.map((t) => `<path data-ta="${t.code}" d="${t.geom.coordinates.map((p) => p.map(P).join("")).join("")}"
    fill="${BATCH.sel.has(t.code) ? "var(--accent)" : "var(--land)"}" fill-opacity="${BATCH.sel.has(t.code) ? 0.75 : 1}" stroke="var(--landline)" stroke-width=".6" style="cursor:pointer"><title>${esc(t.name)} · ${esc((t.prvdrs || []).join(", "))}${t.parts > 1 ? " · needs a suburb list (" + t.parts + " parts)" : ""}</title></path>`).join("")}</svg>`;
}
function drawBatch() {
  const el = $("#batch-body"); if (!el) return;
  const ix = idx(), sc = scopeByTA(), sel = [...BATCH.sel].sort();
  const L = D.limits || {}, budget = ((L.defaults || {}).openmeteo || {}).budget_day || 6000;
  const tot = sel.reduce((t, c) => t + (+((ix[c] || {}).EST_OPENMETEO_CALLS_PER_PART) || 0) * (sc[c] ? 0.5 : 1), 0);
  const filt = store.get("bta-filter", "");
  const rows = (BATCH.tas || []).filter((t) => !filt || norm([t.name, (t.prvdrs || []).join(" "), t.rc].join(" ")).includes(norm(filt))).map((t) => {
    const s = sc[t.code], r = ix[t.code] || {};
    return `<tr><td><input type="checkbox" data-tsel="${t.code}" ${BATCH.sel.has(t.code) ? "checked" : ""} aria-label="Select ${esc(t.name)}"></td><td class="l">${esc(t.name)}</td><td class="l">${esc((t.prvdrs || []).join(", "))}</td>
      <td class="l">${esc(r.CHARGING_TYPE || "")}</td><td>${t.sa2}</td><td class="l">${s ? `<span class="tag ${s.keep.length ? "info" : "bad"}" title="from ${esc(s.basis)}">${s.keep.length} suburbs</span>` : t.parts > 1 ? '<span class="tag warn">needs a list</span>' : "whole TA"}</td></tr>`;
  }).join("");
  el.innerHTML = `<div class="grid g2">
    <div class="card map">${taMap()}<p class="small muted" style="margin:6px 0 0">Click to select or deselect. Blue = selected.</p></div>
    <div class="card"><h3>1 · Scope (optional)</h3>
      <p class="small muted">Files are read in your browser. Their territories and providers also select TAs.</p>
      ${[["map", "nz_suburb_map.csv", "M_SUBURB, PROVIDER, NZ_SUBURB_REF, M_TERRITORY"], ["provider", "nz_suburb_provider.csv", "M_SUBURB, Other spellings, PRVDR"], ["ref", "nz_suburb_ref.csv", "M_SUBURB, …, M_TERRITORY"]].map(([k, f, cols]) =>
        `<p class="small" style="margin:6px 0"><label><b>${f}</b> <input type="file" accept=".csv,.tsv,text/csv" data-sfile="${k}"></label><br><span class="muted">${cols}${BATCH.files[k] ? ` · <b>${BATCH.files[k].length} rows loaded</b>` : ""}</span></p>`).join("")}
      <p class="small"><label>With several lists, keep a suburb when it is in <select id="batch-keep"><option value="any" ${BATCH.keep === "any" ? "selected" : ""}>any list</option><option value="both" ${BATCH.keep === "both" ? "selected" : ""}>every list</option></select></label></p>
      <h3 style="margin-top:12px">2 · Selected: ${sel.length} TA${sel.length === 1 ? "" : "s"}</h3>
      <div class="small">${sel.map((c) => { const t = (BATCH.tas || []).find((x) => x.code === c) || {}; const s = sc[c];
        return `<div class="job"><span>${esc(t.name || c)}${s ? ` · ${s.keep.length} suburbs: <span class="muted">${esc(s.keep.slice(0, 6).join(", "))}${s.keep.length > 6 ? "…" : ""}</span>` : " · whole TA"}</span>${t.parts > 1 && !s ? '<span class="tag warn">needs a list</span>' : ""}</div>`; }).join("") || '<p class="muted">None yet.</p>'}</div>
      <p class="small muted">Estimated Open-Meteo use ≈ ${fmt(tot)} weighted calls (budget ${fmt(budget)}/day) → about ${Math.max(1, Math.ceil(tot / budget))} day(s), plus imagery time. Large TAs (Auckland, Christchurch, Wellington City) need a suburb list.</p>
      ${can("editor") ? `<div class="row"><button class="btn primary" id="batch-queue" type="button" ${sel.length ? "" : "disabled"}>Queue batch</button><button class="btn" id="batch-clear" type="button">Clear selection</button></div>` : lock("editor", "Queuing batches")}
    </div></div>
  <h2>All regions with charging rates (${(BATCH.tas || []).length} TAs)</h2>
  <div class="row" style="margin-bottom:8px"><label class="small">Filter <input type="text" id="bta-filter" value="${esc(filt)}" placeholder="TA, PRVDR or region"></label>
    <button class="btn" type="button" id="bta-all">Select shown</button><button class="btn" type="button" id="bta-none">Deselect shown</button></div>
  <div class="card scroll" style="max-height:360px;overflow:auto"><table><thead><tr><th></th><th class="l">TA</th><th class="l">PRVDR</th><th class="l">Charging</th><th>SA2s</th><th class="l">Scope</th></tr></thead><tbody>${rows}</tbody></table></div>
  ${can("editor") ? progressHTML() : ""}`;
}
function progressHTML() {
  if (!BATCH.batches.length) return `<h2>Batches</h2><p class="muted small">No batches yet.</p>`;
  const tag = (s) => `<span class="tag ${s === "done" ? "ok" : s === "failed" ? "bad" : s === "running" ? "warn" : "info"}">${esc(s)}</span>`;
  return `<h2>Batches</h2>${BATCH.batches.map((b) => { const regs = BATCH.regions.filter((r) => r.batch_id === b.id);
    return `<div class="card" style="margin-bottom:10px"><div class="row" style="justify-content:space-between"><b>${esc(b.name || "Batch " + b.id)}</b><span class="small muted">${esc(new Date(b.created_at).toLocaleString())}</span></div>
    <table><tbody>${regs.map((r) => { const j = BATCH.jobs.find((x) => x.region_id === r.id); return `<tr><td class="l">${esc(r.name)}${r.scope ? ` <span class="muted small">(${r.scope.length} suburbs)</span>` : ""}</td>
      <td>${j ? tag(j.status) : "–"}</td><td class="l small muted" style="white-space:normal">${esc(j && j.reason || "")}</td>
      <td>${r.status === "published" ? '<span class="tag ok">published</span>' : j && j.status === "done" ? `<button class="btn" data-publish="${r.id}" type="button">Publish</button>` : `<span class="tag info">${esc(r.status)}</span>`}</td></tr>`; }).join("")}</tbody></table>
    <div class="row" style="margin-top:8px"><button class="btn" data-tiles="${b.id}" type="button">Download tile list (CSV)</button><button class="btn" type="button" id="batch-refresh">Refresh</button></div></div>`; }).join("")}`;
}
async function queueBatch() {
  const sc = scopeByTA(), sel = [...BATCH.sel].sort();
  const bad = sel.filter((c) => { const t = BATCH.tas.find((x) => x.code === c); return t.parts > 1 && !sc[c]; });
  if (bad.length) return toastMsg("Add a suburb list for: " + bad.map((c) => BATCH.tas.find((x) => x.code === c).name).join(", "));
  const empty = sel.filter((c) => sc[c] && !sc[c].keep.length);
  if (empty.length) return toastMsg("No suburbs kept for: " + empty.map((c) => BATCH.tas.find((x) => x.code === c).name).join(", ") + " (check the keep rule or your lists)");
  const [b] = await q(sb.from("batches").insert({ name: `Batch of ${sel.length} (${new Date().toLocaleDateString("en-NZ")})`, ta_codes: sel, keep_mode: BATCH.keep }).select("id"));
  for (const c of sel) {
    const t = BATCH.tas.find((x) => x.code === c), s = sc[c];
    const existing = BATCH.regions.find((r) => r.ta_code === c);
    const id = existing ? existing.id : "ta-" + c;
    const scope = s ? [...new Set(s.keep.flatMap((n) => [n, n.normalize("NFKD").replace(/[̀-ͯ]/g, "")]))] : null;
    await q(sb.from("regions").upsert({ id, name: t.name + (s ? ` (${s.keep.length} suburbs)` : ""), territorial_authorities: [t.name], ta_code: c, scope, status: existing ? existing.status : "draft", batch_id: b.id }));
    if (s) {
      const old = await q(sb.from("m_suburbs").select("id").eq("region_id", id).not("source_file", "is", null));
      if (old.length) await q(sb.from("m_suburbs").delete().in("id", old.map((o) => o.id)));
      const rows = s.rows.filter((r) => BATCH.keep === "any" || s.keep.some((k) => norm(k) === norm(r.linz_ref)));
      if (rows.length) await q(sb.from("m_suburbs").insert(rows.map((r) => ({ region_id: id, m_suburb: r.m_suburb, m_territory: r.territory || t.name, prvdr: (t.prvdrs || [])[0], other_spellings: r.spellings || null, linz_ref: r.linz_ref, source_file: r.file }))));
    }
    await q(sb.from("jobs").insert({ type: "prepare", region_id: id, batch_id: b.id, status: "queued", params: { steps: ["linz", "imagery_index", "imagery", "census", "publish_new", "climate"] } }));
  }
  toastMsg(`Queued ${sel.length} region job(s): the worker runs them one at a time`);
  await loadBatchData(); drawBatch();
}
async function tileCSV(batchId) {
  const regs = BATCH.regions.filter((r) => r.batch_id === batchId).map((r) => r.id);
  const rows = regs.length ? await q(sb.from("imagery_tiles").select("region_id,capture_id,tile_id,cog_url,stac_url,processed_at").in("region_id", regs).order("region_id")) : [];
  if (!rows.length) return toastMsg("No tiles indexed yet: the imagery step lists them when it runs");
  download(`tiles_batch_${batchId}.csv`, csv([["REGION", "CAPTURE_ID", "TILE_ID", "COG_URL", "STAC_URL", "PROCESSED_AT"], ...rows.map((r) => [r.region_id, r.capture_id, r.tile_id, r.cog_url, r.stac_url, r.processed_at || ""])]));
}
document.addEventListener("click", async (e) => {
  const t = e.target, ta = t.closest && t.closest("[data-ta]");
  if (ta && stage === "batch") { const c = ta.dataset.ta; BATCH.sel.has(c) ? BATCH.sel.delete(c) : BATCH.sel.add(c); saveSel(); return drawBatch(); }
  if (t.id === "batch-clear") { BATCH.sel.clear(); saveSel(); return drawBatch(); }
  if (t.id === "bta-all" || t.id === "bta-none") { const f = norm(store.get("bta-filter", "")); for (const x of BATCH.tas) if (!f || norm([x.name, (x.prvdrs || []).join(" "), x.rc].join(" ")).includes(f)) t.id === "bta-all" ? BATCH.sel.add(x.code) : BATCH.sel.delete(x.code); saveSel(); return drawBatch(); }
  if (t.id === "batch-queue" && can("editor")) { t.disabled = true; try { await queueBatch(); } catch (err) { toastMsg("Not queued: " + err.message); t.disabled = false; } return; }
  if (t.id === "batch-refresh") { await loadBatchData(); return drawBatch(); }
  if (t.dataset && t.dataset.tiles) return tileCSV(+t.dataset.tiles).catch((err) => toastMsg(err.message));
  if (t.dataset && t.dataset.publish && can("editor")) { try { await q(sb.from("regions").update({ status: "published" }).eq("id", t.dataset.publish)); toastMsg("Published: viewers can now see this region (reload to add it to the region list)"); await loadBatchData(); drawBatch(); } catch (err) { toastMsg(err.message); } }
});
document.addEventListener("change", async (e) => {
  const t = e.target;
  if (t.dataset && t.dataset.tsel) { t.checked ? BATCH.sel.add(t.dataset.tsel) : BATCH.sel.delete(t.dataset.tsel); saveSel(); return drawBatch(); }
  if (t.id === "batch-keep") { BATCH.keep = t.value; store.set("batch-keep", t.value); return drawBatch(); }
  if (t.dataset && t.dataset.sfile && t.files && t.files[0]) {
    const rows = readCSV(await t.files[0].text()); BATCH.files[t.dataset.sfile] = rows;
    const sc = scopeByTA(); for (const c of Object.keys(sc)) BATCH.sel.add(c); saveSel();
    toastMsg(`${rows.length} rows read; ${Object.keys(sc).length} TA(s) matched`); return drawBatch();
  }
});
document.addEventListener("input", (e) => { if (e.target.id === "bta-filter") { store.set("bta-filter", e.target.value); clearTimeout(window._bf); window._bf = setTimeout(() => { drawBatch(); const f = $("#bta-filter"); if (f) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); } }, 250); } });

// ---------------------------------------------------------------- account: my API keys (stored encrypted in Supabase Vault)
const KEY_SERVICES = [
  ["linz", "LINZ Data Service", "https://data.linz.govt.nz/my/api/", "Parcels, titles, buildings and suburbs"],
  ["statsnz_ade", "Stats NZ Aotearoa Data Explorer", "https://portal.apis.stats.govt.nz/", "Census tables (subscription key; primary)"],
  ["statsnz_datafinder", "Stats NZ Datafinder", "https://datafinder.stats.govt.nz/my/api/", "SA2 and TA boundaries"],
  ["openmeteo", "Open-Meteo (optional)", "https://open-meteo.com/en/pricing", "Only for commercial use; the free tier needs no key"],
];
V.account = () => {
  setTimeout(loadKeys, 0);
  return `<h1>Account</h1><p class="lead">Signed in as <b>${esc(PROFILE.email)}</b> (${esc(PROFILE.role)}).</p>
  <h2>My API keys</h2><p class="small muted">Jobs you queue use your own keys where you set them, so they count against your own free-tier limits. Otherwise the project's keys are used. Keys are encrypted in Supabase Vault: you can replace or remove them but never read them back, and only the worker can decrypt them, for your jobs.</p>
  <div class="card scroll" id="keys-card"><p class="muted">Loading…</p></div>`;
};
async function loadKeys() {
  const el = $("#keys-card"); if (!el) return;
  const mine = await q(sb.from("user_api_keys").select("service,last4,updated_at"));
  el.innerHTML = `<table><thead><tr><th class="l">Service</th><th class="l">Used for</th><th class="l">Your key</th><th class="l">Set / replace</th><th></th></tr></thead><tbody>${KEY_SERVICES.map(([k, name, url, use]) => {
    const m = mine.find((x) => x.service === k);
    return `<tr><td class="l"><a href="${url}" target="_blank" rel="noopener">${name}</a></td><td class="l small" style="white-space:normal">${use}</td>
      <td class="l">${m ? `<code>••••${esc(m.last4)}</code> <span class="small muted">${esc(new Date(m.updated_at).toLocaleDateString())}</span>` : '<span class="muted">project key</span>'}</td>
      <td class="l"><input type="password" autocomplete="off" data-keyin="${k}" placeholder="paste key" style="width:180px"> <button class="btn" data-keysave="${k}" type="button">Save</button></td>
      <td>${m ? `<button class="btn" data-keydel="${k}" type="button">Remove</button>` : ""}</td></tr>`; }).join("")}</tbody></table>`;
}
document.addEventListener("click", async (e) => {
  const t = e.target;
  if (t.dataset && t.dataset.keysave) { const inp = $(`[data-keyin="${t.dataset.keysave}"]`); const v = inp.value; inp.value = "";
    try { const last4 = await q(sb.rpc("set_my_api_key", { p_service: t.dataset.keysave, p_key: v })); toastMsg(`Saved (••••${last4})`); loadKeys(); } catch (err) { toastMsg("Not saved: " + err.message); } }
  if (t.dataset && t.dataset.keydel) { if (!confirm("Remove this key? Your jobs will use the project key.")) return;
    try { await q(sb.rpc("delete_my_api_key", { p_service: t.dataset.keydel })); toastMsg("Removed"); loadKeys(); } catch (err) { toastMsg(err.message); } }
});
