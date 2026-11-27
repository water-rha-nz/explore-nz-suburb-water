
// ---------------------------------------------------------------- study sessions and step prerequisites
// The header's Study menu holds: All regions (no study), each saved study, and "+ New study". The session follows the choice:
// only the chosen study's regions stay loaded, Configure shows that study (or a blank new one), and stages that need prepared
// data show what has to happen first instead of an empty or broken page.
const NEW_STUDY = "__new";
const DATA_STAGES = new Set(["imagery", "validate", "context", "explore", "export"]);
const stageNo = (id) => STAGES.findIndex(([x]) => x === id) + 1;
const stageLabel = (id) => (STAGES.find(([x]) => x === id) || [])[1] || id;
const studyIdsNow = () => { const st = studyOf(); return st ? (D.index || []).filter((r) => (st.ta_codes || []).includes(r.ta_code)).map((r) => r.id) : null; };
const isPrepared = (k) => !!(D && D.regions && D.regions[k] && D.regions[k].suburbs && D.regions[k].suburbs.some((s) => s.sections != null)) || ["published", "partial"].includes(indexOf(k).status);
const isPartial = (k) => indexOf(k).status === "partial";
const studyRows = () => { if (BATCH.isNew) return []; const ids = studyIdsNow(); return (D && D.index || []).filter((r) => !ids || ids.includes(r.id)); };

function resetBatchState() {
  Object.assign(BATCH, { config: null, sel: new Set(), prvdr: {}, cfgPrvdr: {}, matches: {}, alloc: {}, picks: {}, tl: {}, files: {}, fileNames: {}, valid: {}, savedScope: null, builder: null });
  saveSel();
}
function newStudy() {
  STUDY.id = ""; store.set("study", ""); resetBatchState(); BATCH.isNew = true; scopeSession();
  stage = "configure"; bsub = "select"; store.set("stage", stage); store.set("batch-sub", "select");
}
// keep only the chosen study's regions in memory, and a current region from the study (data loads lazily per page)
function scopeSession() {
  const ids = BATCH.isNew ? null : studyIdsNow();   // a new study keeps what's loaded; a saved study keeps only its regions
  if (ids && D && D.regions) for (const k of Object.keys(D.regions)) if (!ids.includes(k)) delete D.regions[k];
  if (ids && typeof SECTR !== "undefined") for (const k of Object.keys(SECTR)) if (!ids.includes(k)) delete SECTR[k];
  if (ids && ids.length && !ids.includes(region)) { region = ids.find(isPrepared) || ids[0]; store.set("region", region); }
  if (typeof MEMO !== "undefined") MEMO.fresh = false;
}
// "+ New study" is handled before the menu's own handler; any other choice ends a new, unsaved study and scopes the session
document.addEventListener("change", (e) => {
  if (e.target.id !== "study") return;
  if (e.target.value === NEW_STUDY) { e.stopImmediatePropagation(); newStudy(); render(); return; }
  BATCH.isNew = false;
  if (!e.target.value) { resetBatchState(); }   // no study: Configure starts clean (a new region can still be prepared)
}, true);
document.addEventListener("change", (e) => { if (e.target.id === "study" && e.target.value !== NEW_STUDY) { scopeSession(); render(); } });

// what each stage needs first
function stageState(id) {
  const rows = studyRows(), ready = rows.filter((r) => isPrepared(r.id)), tas = BATCH.sel.size;
  if (id === "region") return ["done", "Overview of the data in the database"];
  if (id === "configure") return tas ? ["done", `${tas} region(s) chosen`] : ["todo", "Choose the region(s) (TAs) for the study"];
  if (id === "load") return !tas ? ["blocked", "Needs: 2 Configure → choose the region(s)"] : rows.length && rows.every((r) => isPrepared(r.id)) ? ["done", "All of the study's regions are prepared"] : ["todo", "Queue the batch; the worker prepares each region"];
  if (DATA_STAGES.has(id)) return ready.length ? ["ready", `${ready.length} prepared region(s)`] : ["blocked", "Needs a prepared region: 2 Configure, then 3 Load"];
  return ["ready", ""];
}
// statuses are read at sign-in; while a stage waits for regions, re-check them every 30 s so finished regions open without a reload
let GATE_T = 0;
async function refreshStatuses(ids) {
  if (!ids.length || Date.now() - GATE_T < 30000) return; GATE_T = Date.now();
  try { const fresh = await q(sb.from("regions").select("id,status").in("id", ids)); let changed = false;
    for (const f of fresh) { const r = (D.index || []).find((x) => x.id === f.id); if (r && r.status !== f.status) { r.status = f.status; changed = true; } }
    if (changed) { if (typeof MEMO !== "undefined") MEMO.fresh = false; render(); }
    else if (DATA_STAGES.has(stage)) setTimeout(() => { if (DATA_STAGES.has(stage)) refreshStatuses(ids); }, 30500); } catch (e) { /* try again on the next view */ }
}
function gateHTML(id) {
  const rows = studyRows(), ready = rows.filter((r) => isPrepared(r.id));
  const waiting = rows.filter((r) => !isPrepared(r.id) || isPartial(r.id)).map((r) => r.id); if (waiting.length) setTimeout(() => refreshStatuses(waiting), 0);
  if (ready.length && !BATCH.isNew) {
    if (!rows.some((r) => r.id === region)) { region = ready[0].id; store.set("region", region); return null; }   // region outside the study
    if (isPrepared(region)) return null;
    const cur = indexOf(region);   // the chosen region isn't prepared yet: say so, and offer the prepared ones (no silent switch)
    return `<h1>${stageNo(id)} · ${esc(stageLabel(id))}</h1><p class="lead"><b>${esc(cur.name || region)}</b> isn't prepared yet (${esc(cur.status || "queued")}): the worker is still downloading its data, or it hasn't been queued on <b>3 · Load</b>.</p>
      <div class="card"><p class="small">Prepared regions you can open now:</p><p>${ready.map((r) => `<button class="btn" type="button" data-flow-region="${esc(r.id)}">${esc(r.name || r.id)}</button>`).join(" ")}</p>
      <p><button class="btn" type="button" data-flow-go="load">Check its progress on 3 · Load →</button></p></div>`;
  }
  const st = studyOf(), tas = [...BATCH.sel], step = (ok, title, body, go) => `<li style="margin:8px 0"><span class="tag ${ok ? "ok" : "bad"}">${ok ? "done" : "to do"}</span> <b>${title}</b><br><span class="small">${body}</span>${go && !ok ? ` <button class="btn" type="button" data-flow-go="${go}" style="margin-left:6px">Go →</button>` : ""}</li>`;
  const regs = rows.length ? rows.map((r) => `${esc(r.name || r.id)}: ${isPrepared(r.id) ? "prepared" : esc(r.status || "queued")}`).join(" · ") : "no region created yet";
  return `<h1>${stageNo(id)} · ${esc(stageLabel(id))}</h1>
    <p class="lead">This step works on a <b>prepared region</b>: one whose LINZ sections, imagery, census and climate have been downloaded by the worker. ${st ? `The study <b>${esc(st.name)}</b>` : BATCH.isNew ? "Your new study" : "No region in the database"} has none yet. Before this step:</p>
    <div class="card"><ol style="padding-left:18px;margin:0">
      ${step(!!(st || BATCH.isNew || tas.length), "1 · Choose or start a study", st ? `Study: ${esc(st.name)}.` : BATCH.isNew ? "New study (not saved yet): name it and Save in 2 Configure." : "Pick a study in the header, or + New study. You can also prepare a region with no study.", null)}
      ${step(tas.length > 0, `2 · Configure → 2.1 choose the region(s)`, tas.length ? `${tas.length} chosen: ${tas.map((c) => esc(taOf(c).name || c)).join(", ")}.` : "Tick the territorial authorities (TAs) the study covers, on the map or in the list.", "configure:select")}
      ${step(tas.length > 0 && tas.every((c) => BATCH.valid[c] && BATCH.valid[c].status === "done"), "2 · Configure → 2.3 Validate suburbs", "Check the study's suburb names against LINZ (also done on queueing).", "configure:vsuburbs")}
      ${step(ready.length > 0, "3 · Load: queue the batch", `The worker prepares each region in the background (runs start by themselves). Now: ${regs}.`, "load")}
    </ol></div>
    <p class="small muted">This page opens as soon as one of the study's regions is prepared.</p>`;
}
// a partly loaded region opens with what is stored so far, and says so
const partialNote = () => isPartial(region) ? `<div class="note" style="margin:6px 0">Partly loaded: <b>${esc(indexOf(region).name || region)}</b> is still being prepared (imagery, census or climate). Figures not yet available show as –; they fill in as the worker finishes. Progress is on <b>3 · Load</b>.</div>` : "";
for (const id of DATA_STAGES) { const f = V[id]; if (!f) continue; V[id] = (...a) => gateHTML(id) || f(...a).replace(/(<\/h1>)/, `$1${partialNote()}`); }
document.addEventListener("click", (e) => {
  const rb = e.target.closest && e.target.closest("[data-flow-region]");
  if (rb) { region = rb.dataset.flowRegion; store.set("region", region); render(); return; }
  const b = e.target.closest && e.target.closest("[data-flow-go]"); if (!b) return;
  const [st, sub] = b.dataset.flowGo.split(":"); stage = st; store.set("stage", st);
  if (sub) { bsub = sub; store.set("batch-sub", sub); }
  render(); scrollTo(0, 0);
});

// header: the Study menu gains "+ New study", the stage bar shows what's done, ready or still blocked
const _rhFlow = renderHeader;
renderHeader = function () {
  _rhFlow();
  const s = $("#study");
  if (s && s.querySelector && !s.querySelector(`option[value="${NEW_STUDY}"]`)) {
    const first = s.querySelector('option[value=""]'); if (first) first.textContent = "All regions (no study)";
    if (can("editor")) s.innerHTML += (`<option value="${NEW_STUDY}" ${BATCH.isNew ? "selected" : ""}>${BATCH.isNew ? "New study (unsaved)" : "+ New study…"}</option>`);
  }
  for (const btn of document.querySelectorAll("#stages [data-stage]")) {
    if (btn.querySelector(".flow-mark")) continue;
    const [state, why] = stageState(btn.dataset.stage), mark = { done: "✓", blocked: "🔒", todo: "•", ready: "" }[state];
    if (mark) btn.innerHTML += (` <span class="flow-mark" aria-hidden="true" style="font-size:.8em;${state === "done" ? "color:var(--ok,#2e7d32)" : "opacity:.75"}">${mark}</span>`);
    btn.title = why; if (state === "blocked") btn.style.opacity = ".6";
  }
};

// Configure: which study is being edited, and an explicit first step: choose the region(s)
const _drawBatchFlow = drawBatch;
drawBatch = function () {
  _drawBatchFlow();
  const el = $("#batch-body"); if (!el || stage !== "configure") return;
  const st = studyOf(), n = BATCH.sel.size;
  const head = st ? `<b>Study: ${esc(st.name)}</b> <span class="small muted">changes save to this study automatically</span>`
    : BATCH.isNew ? `<b>New study</b> <input type="text" id="flow-new-name" placeholder="Study name" style="width:200px"> <button class="btn primary" type="button" id="flow-new-save">Save study</button> <span class="small muted">saves the regions, PRVDRs, allocations and timelines chosen here (never your files)</span>`
    : `<b>No study selected</b> <span class="small muted">you can prepare a region without a study, or choose <i>+ New study</i> in the header to keep these choices</span>`;
  const pick = bsub === "select" ? `<div class="note" style="margin-top:8px"><b>First, choose the region(s) for this study.</b> Tick territorial authorities (TAs) in the list or click them on the map. PRVDRs, allocation (2.2), suburb validation (2.3), timelines and 3 Load all work on the regions chosen here.
      ${n ? ` <span class="tag ok">${n} chosen</span>` : ` <span class="tag bad">none chosen yet</span>`}</div>`
    : !n ? `<div class="note" style="margin-top:8px"><b>No region chosen yet.</b> <button class="btn" type="button" data-btab="select">Go to 2.1 and choose the region(s)</button></div>` : "";
  el.innerHTML = `<div class="card" style="margin-bottom:10px">${head}${pick}</div>` + el.innerHTML;
};
document.addEventListener("click", async (e) => {
  if (!e.target || e.target.id !== "flow-new-save") return;
  const name = (($("#flow-new-name") || {}).value || "").trim(); if (!name) return toastMsg("Give the study a name");
  if (!BATCH.sel.size) return toastMsg("Choose at least one region (TA) first");
  try { await saveConfig(name); BATCH.isNew = false; scopeSession(); render(); } catch (err) { toastMsg("Not saved: " + err.message); }
});

// ---------------------------------------------------------------- admin: database size and review keys
const FREE_DB_BYTES = 500e6;   // Supabase free plan database size
const _vAdminFlow = V.admin;
V.admin = (...a) => {
  const h = _vAdminFlow(...a); if (!can("admin")) return h;
  setTimeout(loadAdminExtras, 0);
  return h + `<h2>Database size</h2><div class="card" id="adm-sizes"><p class="small muted">Loading…</p></div>
    <h2>Review keys</h2><div class="card" id="adm-keys"><p class="small muted">Loading…</p></div>`;
};
async function loadAdminExtras() {
  const zs = $("#adm-sizes"), ks = $("#adm-keys");
  if (zs) try { const z = await q(sb.rpc("db_sizes")) || {}, used = +z.database_bytes || 0, pct = Math.min(100, 100 * used / FREE_DB_BYTES);
    zs.innerHTML = `<p><b>${fmt(used / 1e6)} MB</b> of the free plan's ${fmt(FREE_DB_BYTES / 1e6)} MB (${fmt(100 * used / FREE_DB_BYTES)}%)</p>
      <div class="bar-out" role="progressbar" aria-valuenow="${Math.round(pct)}" aria-valuemin="0" aria-valuemax="100" aria-label="Database size"><div class="bar-in" style="width:${pct.toFixed(1)}%;${pct >= 90 ? "background:var(--bad)" : ""}"></div></div>
      <p class="small muted">By schema: ${Object.entries(z.schemas || {}).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${esc(k)} ${fmt(v / 1e6)} MB`).join(" · ")}</p>
      <div class="scroll"><table><thead><tr><th class="l">Table</th><th>Total MB</th><th>Data MB</th><th>Indexes MB</th><th>Rows</th><th>Dead rows</th></tr></thead><tbody>${(z.tables || []).slice(0, 20).map((t) => `<tr><td class="l"><code>${esc(t.name)}</code></td><td>${fmt(t.total / 1e6, 1)}</td><td>${fmt(t.heap / 1e6, 1)}</td><td>${fmt(t.idx / 1e6, 1)}</td><td>${fmt(t.live_rows)}</td><td>${fmt(t.dead_rows)}</td></tr>`).join("")}</tbody></table></div>`; }
    catch (e) { zs.innerHTML = `<p class="small">Size report unavailable: ${esc(e.message)}</p>`; }
  if (ks) try { const rows = await q(sb.rpc("admin_review_keys")) || [];
    ks.innerHTML = `<p class="small">Review keys open only the blind image review (anonymous chips, no location) and record second-review labels. The database keeps only each key's SHA-256; a new key is shown once, here.</p>
      <table><thead><tr><th class="l">Key</th><th class="l">Label</th><th>Created</th><th>Status</th><th></th></tr></thead><tbody>${rows.map((r) => `<tr><td class="l"><code>${esc(r.hash_prefix)}…</code></td><td class="l">${esc(r.label || "")}</td><td>${esc(new Date(r.created_at).toLocaleDateString("en-NZ"))}</td><td><span class="tag ${r.revoked ? "bad" : "ok"}">${r.revoked ? "revoked" : "active"}</span></td><td><button class="btn" type="button" data-rkey="${esc(r.hash_prefix)}" data-rkey-on="${r.revoked ? "0" : "1"}">${r.revoked ? "Restore" : "Revoke"}</button></td></tr>`).join("") || `<tr><td colspan="5" class="muted">No keys.</td></tr>`}</tbody></table>
      <div class="row" style="margin-top:8px"><input type="text" id="rkey-label" placeholder="Label (who or what uses it)" style="width:240px"><button class="btn primary" type="button" id="rkey-new">Create key</button></div><div id="rkey-out"></div>`; }
    catch (e) { ks.innerHTML = `<p class="small">Review keys unavailable: ${esc(e.message)}</p>`; }
}
document.addEventListener("click", async (e) => {
  const t = e.target; if (!t || !can("admin")) return;
  if (t.id === "rkey-new") {
    const raw = crypto.getRandomValues(new Uint8Array(32)), key = [...raw].map((b) => b.toString(16).padStart(2, "0")).join("");
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)))].map((b) => b.toString(16).padStart(2, "0")).join("");
    try { await q(sb.rpc("admin_add_review_key", { p_sha256: hash, p_label: (($("#rkey-label") || {}).value || "").trim() })); await loadAdminExtras();
      const out = $("#rkey-out"); if (out) out.innerHTML = `<div class="note" style="margin-top:8px"><b>Copy this key now: it isn't shown again or stored anywhere.</b><br><input type="text" readonly value="${key}" style="width:100%;font-family:monospace" onclick="this.select()"><br><span class="small">Send it as the <code>x-review-token</code> header to <code>/functions/v1/review-chips</code>. Revoke it here if it's lost or shared.</span></div>`; }
    catch (err) { toastMsg("Key not created: " + err.message); }
    return;
  }
  const r = t.closest && t.closest("[data-rkey]");
  if (r) { try { await q(sb.rpc("admin_revoke_review_key", { p_prefix: r.dataset.rkey, p_revoked: r.dataset.rkeyOn === "1" })); await loadAdminExtras(); } catch (err) { toastMsg(err.message); } }
});


// ---------------------------------------------------------------- the selected study is loaded on start
// After a reload the browser keeps only part of the study (selected TAs, matches); the saved study itself (provider choices,
// acronyms per territory, allocations, timelines) is read again whenever the selected study isn't the one loaded yet, so PRVDR and
// the rest show as configured. It never replaces a study that is already loaded (and its files) in this session.
let STUDY_LOADING = null;
async function ensureStudyLoaded() {
  if (!STUDY.id || BATCH.isNew || !can("editor")) return;
  if (BATCH.config && String(BATCH.config.id) === String(STUDY.id)) return;
  if (STUDY_LOADING) return STUDY_LOADING;
  STUDY_LOADING = (async () => {
    try { await loadBatchData(); if (BATCH.configs.some((c) => String(c.id) === String(STUDY.id))) { loadConfig(STUDY.id, true); render(); } }
    catch (e) { console.warn("study not loaded:", e.message); }
    finally { STUDY_LOADING = null; }
  })();
  return STUDY_LOADING;
}
{ const _ls = loadStudies; loadStudies = async (...a) => { const r = await _ls(...a); ensureStudyLoaded(); return r; }; }
