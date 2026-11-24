
// ---------------------------------------------------------------- study workbook (.xlsx): everything saved for the study, raw
// One workbook per study (or the export scope when no study is chosen): Overview and About sheets, the raw stored tables (one row
// per stored row, all columns except geometry, combined across the study's regions), and every CSV export as its own sheet.
// Built in the browser with the signed-in user's own access: property-level tables (section imagery, pool candidates) are only
// returned to editors by the database's row-level security, so other users' workbooks don't contain them. No third-party code:
// a minimal SpreadsheetML writer and a zip written here (deflate via the browser's CompressionStream when available).

const XLSX_SOURCES = [
  ["LINZ NZ Suburbs and Localities (layer 113764)", "https://data.linz.govt.nz/layer/113764", "CC BY 4.0"],
  ["LINZ NZ Primary Parcels (layer 50772)", "https://data.linz.govt.nz/layer/50772", "CC BY 4.0"],
  ["LINZ NZ Property Titles (layer 50804)", "https://data.linz.govt.nz/layer/50804", "CC BY 4.0"],
  ["LINZ NZ Building Outlines (layer 101290)", "https://data.linz.govt.nz/layer/101290", "CC BY 4.0"],
  ["LINZ aerial imagery, RGB+NIR (public COGs, STAC catalogue)", "https://nz-imagery.s3-ap-southeast-2.amazonaws.com/catalog.json", "CC BY 4.0"],
  ["Stats NZ Statistical Area 2 2023 (layer 111206)", "https://datafinder.stats.govt.nz/layer/111206", "CC BY 4.0"],
  ["Stats NZ Census 2018 and 2023 (Aotearoa Data Explorer)", "https://explore.data.stats.govt.nz", "CC BY 4.0"],
  ["Open-Meteo historical weather (ERA5 / ERA5-Land)", "https://open-meteo.com/en/docs/historical-weather-api", "CC BY 4.0"],
];

// ---- zip (store or deflate) and SpreadsheetML
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
async function deflateRaw(u8) {
  if (typeof CompressionStream === "undefined") return null;
  try { return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer()); } catch (e) { return null; }
}
async function zipFiles(files) {   // files: [[name, string]]
  const enc = new TextEncoder(), out = [], cen = []; let off = 0;
  for (const [name, text] of files) {
    const nm = enc.encode(name), data = enc.encode(text), crc = crc32(data), z = await deflateRaw(data), method = z && z.length < data.length ? 8 : 0, body = method ? z : data;
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, method, true); h.setUint16(10, 0, true); h.setUint16(12, 0x21, true);
    h.setUint32(14, crc, true); h.setUint32(18, body.length, true); h.setUint32(22, data.length, true); h.setUint16(26, nm.length, true); h.setUint16(28, 0, true);
    out.push(new Uint8Array(h.buffer), nm, body);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, method, true); c.setUint16(12, 0, true); c.setUint16(14, 0x21, true);
    c.setUint32(16, crc, true); c.setUint32(20, body.length, true); c.setUint32(24, data.length, true); c.setUint16(28, nm.length, true); c.setUint32(42, off, true);
    cen.push(new Uint8Array(c.buffer), nm);
    off += 30 + nm.length + body.length;
  }
  const csz = cen.reduce((a, b) => a + b.length, 0), e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, csz, true); e.setUint32(16, off, true);
  return new Blob([...out, ...cen, new Uint8Array(e.buffer)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}
const xesc = (s) => String(s).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const xcol = (i) => { let s = ""; for (i++; i; i = (i - 1) / 26 | 0) s = String.fromCharCode(65 + (i - 1) % 26) + s; return s; };
const NUMLIKE = /^-?(0|[1-9]\d{0,14})(\.\d+)?$/;   // numbers stay numbers; codes with leading zeros ("001") stay text
function xcell(v, r, c, style) {
  const ref = xcol(c) + r, st = style ? ` s="${style}"` : "";
  if (v == null || v === "") return "";
  if (typeof v === "boolean") return `<c r="${ref}" t="b"${st}><v>${v ? 1 : 0}</v></c>`;
  if (typeof v === "number" ? isFinite(v) : NUMLIKE.test(v)) return `<c r="${ref}"${st}><v>${+v}</v></c>`;
  let t = typeof v === "object" ? JSON.stringify(v) : String(v); if (t.length > 32000) t = t.slice(0, 32000) + "…";
  return `<c r="${ref}" t="inlineStr"${st}><is><t xml:space="preserve">${xesc(t)}</t></is></c>`;
}
// kind "table": bold frozen header row with filter; kind "text": first column bold (label / value pages)
function sheetXML(rows, kind) {
  const n = Math.max(1, ...rows.map((r) => r.length)), w = Array(n).fill(8);
  for (const r of rows.slice(0, 200)) r.forEach((v, i) => { w[i] = Math.min(kind === "text" && i > 0 ? 110 : 50, Math.max(w[i], String(v == null ? "" : typeof v === "object" ? JSON.stringify(v) : v).length + 2)); });
  const body = rows.map((r, i) => `<row r="${i + 1}">${r.map((v, j) => xcell(v, i + 1, j, kind === "table" ? (i === 0 ? 1 : 0) : (j === 0 && v ? 1 : 0))).join("")}</row>`).join("");
  const pane = kind === "table" && rows.length > 1 ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${pane}<cols>${w.map((x, i) => `<col min="${i + 1}" max="${i + 1}" width="${x}" customWidth="1"/>`).join("")}</cols><sheetData>${body}</sheetData>${kind === "table" && rows.length > 1 ? `<autoFilter ref="A1:${xcol(n - 1)}${rows.length}"/>` : ""}</worksheet>`;
}
async function buildXlsx(sheets) {   // [{name, rows, kind}]
  const used = new Set(), names = sheets.map((s) => { let b = s.name.replace(/[\\/?*[\]:]/g, " ").slice(0, 31), x = b, i = 2; while (used.has(x.toLowerCase())) x = b.slice(0, 28) + " " + i++; used.add(x.toLowerCase()); return x; });
  const files = [
    ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`],
    ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ["xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${xesc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets>${sheets.map((s, i) => s.kind === "table" && s.rows.length > 1 ? `<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${xesc(names[i]).replace(/'/g, "''")}'!$A$1:$${xcol(Math.max(1, ...s.rows.map((r) => r.length)) - 1)}$${s.rows.length}</definedName></definedNames>` : "").find(Boolean) || ""}</workbook>`],
    ["xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ["xl/styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf/><xf fontId="1" applyFont="1"/></cellXfs></styleSheet>`],
    ...sheets.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXML(s.rows, s.kind)]),
  ];
  return { blob: await zipFiles(files), names };
}

// ---- data
// rows of objects -> [header, ...rows]; geometry and very large columns left out
function objRows(list, lead = {}) {
  const drop = new Set(["geom", "geometry", "outline"]), cols = [];
  for (const r of list) for (const k of Object.keys(r)) if (!drop.has(k) && !cols.includes(k)) cols.push(k);
  const lk = Object.keys(lead);
  return [[...lk, ...cols], ...list.map((r) => [...lk.map((k) => lead[k]), ...cols.map((k) => r[k])])];
}
async function pagedAll(make, key) {   // keyset paging: make(last) returns a query ordered by key
  const out = []; let last = null;
  for (;;) { const p = await retry(() => q(make(last).limit(1000))); out.push(...p); if (p.length < 1000) break; last = p[p.length - 1][key]; }
  return out;
}
function parseDelimited(t) {
  const d = (t.split(/\r?\n/, 1)[0] || "").includes("\t") ? "\t" : ",", rows = []; let row = [], f = "", qt = false;
  for (let i = 0; i < t.length; i++) { const c = t[i];
    if (qt) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else qt = false; } else f += c; }
    else if (c === '"' && f === "") qt = true; else if (c === d) { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && t[i + 1] === "\n") i++; row.push(f); rows.push(row); row = []; f = ""; } else f += c; }
  if (f !== "" || row.length) { row.push(f); rows.push(row); }
  return rows;
}
const studyScope = () => {
  const st = typeof studyOf === "function" ? studyOf() : null;
  if (st) return { name: st.name, config: st, ids: (D.index || []).filter((r) => (st.ta_codes || []).includes(r.ta_code)).map((r) => r.id) };
  return { name: store.get("scope", "region") === "all" ? "All loaded regions" : (indexOf(region).name || region), config: null, ids: scopeRegions() };
};

async function studyWorkbook(say) {
  const S = studyScope(); if (!S.ids.length) throw new Error("the study has no regions in the database yet");
  say(`Loading the study's regions (${S.ids.length})…`);
  await ensureRegions(S.ids, (i, n, nm) => say(`Loading region ${i} of ${n}: ${nm}…`));
  const ids = S.ids.filter((k) => D.regions[k]), sheets = [], about = [], ed = can("editor");
  const add = (name, rows, desc, src) => { sheets.push({ name, rows, kind: "table" }); about.push([name, Math.max(0, rows.length - 1), desc, src || ""]); };
  const per = async (label, fn) => { const all = []; for (const [i, k] of ids.entries()) { say(`${label}: ${(D.regions[k] || {}).label || k} (${i + 1} of ${ids.length})…`); all.push(...((await fn(k)) || []).map((r) => ({ region_id: k, ...r }))); } return all; };

  // raw stored tables
  const regs = await retry(() => q(sb.from("regions").select("*").in("id", ids)));
  add("Regions", objRows(regs), "Stored region rows: TAs, suburb names, imagery captures, status, provider, timeline.", "this app");
  const sm = await per("Suburb metrics", (k) => q(sb.from("suburb_metrics").select("*").eq("region_id", k)));
  add("Suburb metrics", objRows(sm), "Published suburb aggregates (one row per LINZ suburb): sections, titles, density, pools, gardens, climate cell.", "LINZ, imagery, Open-Meteo");
  const linz = ids.flatMap((k) => D.regions[k].suburbs.map((s) => s.linz_id));
  const sc = []; for (let i = 0; i < linz.length; i += 100) { say(`Suburb census (${Math.min(i + 100, linz.length)} of ${linz.length})…`); sc.push(...await retry(() => q(sb.from("suburb_census").select("*").in("linz_id", linz.slice(i, i + 100))))); }
  add("Suburb census", objRows(sc), "Census figures apportioned to LINZ suburbs (one row per suburb).", "Stats NZ");
  let sa2 = []; for (let i = 0; i < linz.length; i += 200) sa2.push(...((await retry(() => q(sb.rpc("sa2_codes_for", { p_ids: linz.slice(i, i + 200) })))) || []));
  sa2 = [...new Set(sa2.map(String))];
  const cm = []; for (let i = 0; i < sa2.length; i += 100) { say(`SA2 census (${Math.min(i + 100, sa2.length)} of ${sa2.length})…`); cm.push(...await retry(() => q(sb.from("census_metrics").select("*").in("sa2_code", sa2.slice(i, i + 100))))); }
  add("SA2 census", objRows(cm), "Census metrics per Statistical Area 2 (the source of the suburb census).", "Stats NZ");
  const cells = [...new Set(sm.map((m) => m.climate_cell).filter(Boolean))];
  const mon = []; for (const c of cells) mon.push(...await retry(() => q(sb.from("v_climate_monthly").select("*").eq("cell_id", c).order("month"))));
  add("Climate monthly", objRows(mon), "Monthly climate per Open-Meteo grid cell (sums of rain and ET₀, mean temperatures).", "Open-Meteo");
  const day = []; for (const [i, c] of cells.entries()) { say(`Daily climate: cell ${i + 1} of ${cells.length}…`);
    day.push(...await pagedAll((last) => { let b = sb.from("climate_daily").select("*").eq("cell_id", c); if (last) b = b.gt("date", last); return b.order("date"); }, "date")); }
  add("Climate daily", objRows(day), "Every stored day per climate cell (rain, ET₀, temperatures) over the configured timelines.", "Open-Meteo");
  const secs = await per("Sections", (k) => pagedAll((last) => { let b = sb.from("sections").select(`parcel_id,appellation,parcel_intent,survey_area,polygon_m2,n_titles,suburb_id${ed ? ",section_imagery(capture_id,valid_m2,open_m2,veg_m2,building_m2,unbuilt_m2),pool_candidates(id,capture_id,area_m2,tool_pool,features)" : ""}`).eq("region_id", k); if (last != null) b = b.gt("parcel_id", last); return b.order("parcel_id"); }, "parcel_id"));
  const sname = {}; for (const k of ids) for (const s of D.regions[k].suburbs) sname[s.linz_id] = s.name;
  add("Sections", objRows(secs.map(({ section_imagery: si, pool_candidates: pc, ...r }) => { const m = (si || [])[0] || {}, pools = (pc || []).filter((p) => p.tool_pool);
    return { ...r, suburb: sname[r.suburb_id] || "", ...(ed ? { capture_id: m.capture_id, valid_m2: m.valid_m2, open_m2: m.open_m2, veg_m2: m.veg_m2, building_m2: m.building_m2, unbuilt_m2: m.unbuilt_m2, pools: pools.length, pool_m2: pools.reduce((a, p) => a + +p.area_m2, 0) || null } : {}) }; })),
    ed ? "Residential sections (LINZ parcels) with the imagery measurements per section. Property-level: editors only; handle under the project's privacy rules." : "Residential sections (LINZ parcels). Imagery measurements per property are editor-only and not included.", "LINZ, imagery");
  if (ed) add("Pool candidates", objRows(secs.flatMap((s) => (s.pool_candidates || []).map((p) => ({ region_id: s.region_id, section_id: s.parcel_id, ...p })))), "Every water body the tool found (accepted = counted as a pool), with its measured features. Property-level: editors only.", "imagery");
  const caps = [...new Set(regs.flatMap((r) => r.imagery_captures || []))];
  add("Imagery captures", objRows(caps.length ? await retry(() => q(sb.from("imagery_captures").select("*").in("id", caps))) : []), "Aerial imagery captures used (resolution, year, calibration).", "LINZ");
  add("Imagery tiles", objRows(await per("Imagery tiles", (k) => pagedAll((last) => { let b = sb.from("imagery_tiles").select("capture_id,tile_id,cog_url,stac_url,processed_at").eq("region_id", k); if (last) b = b.gt("tile_id", last); return b.order("tile_id"); }, "tile_id"))), "Public LINZ tiles indexed for each region (Cloud-Optimised GeoTIFF links).", "LINZ");
  const tal = []; for (const k of ids) { const t = await retry(() => q(sb.rpc("validation_tally", { p_region: k }))).catch(() => null);
    for (const [key, n] of Object.entries((t && t.labels) || {})) { const [task, tool, label] = key.split(":"); tal.push({ region_id: k, task, tool_verdict: tool, label, labels: n }); }
    for (const [key, n] of Object.entries((t && t.items) || {})) { const [task, tool] = key.split(":"); tal.push({ region_id: k, task, tool_verdict: tool, label: "(items sampled)", labels: n }); } }
  add("Validation", objRows(tal), "Labelling counts across all labellers (aggregates only).", "labellers");
  const provs = [...new Set(ids.map((k) => D.regions[k].provider).filter(Boolean))];
  add("Water rates", objRows((D.water_rates || []).filter((w) => provs.includes(w.PROVIDER))), "Water charging per provider, with sources.", "providers' published charges");
  add("Jobs", objRows(await per("Jobs", (k) => q(sb.from("jobs").select("id,type,status,reason,created_at,finished_at").eq("region_id", k).order("id")))), "Preparation history per region (job status and outcome).", "this app");
  if (S.config) add("Study config", [["setting", "value"], ...Object.entries(S.config).map(([k, v]) => [k, v])], "The saved configuration (names and mappings only; no file contents).", "this app");

  // the CSV outputs, as views over the same data (same columns as the CSV files)
  const keepRegs = D.regions, keepScope = store.get("scope", "region"), csvs = [];
  try {
    D.regions = Object.fromEntries(ids.map((k) => [k, keepRegs[k]])); store.set("scope", "all");
    for (const [f, e] of Object.entries(EXPORTS)) { if (!/\.(csv|tsv|txt)$/i.test(f)) continue; say(`Building ${f}…`);
      try { const rows = parseDelimited(await e.make()); csvs.push({ name: f.replace(/\.(csv|tsv|txt)$/i, "").replace(/^nz_/, ""), rows, kind: "table" }); about.push([csvs[csvs.length - 1].name, Math.max(0, rows.length - 1), `View: ${f}: ${e.desc}`, "CSV output"]); }
      catch (err) { about.push([f, 0, `Not built: ${err.message}`, "CSV output"]); } }
  } finally { D.regions = keepRegs; store.set("scope", keepScope); }

  // Overview and About
  const now = new Date();
  const overview = [["NZ Suburb Water Profiles: study workbook"], [], ["Study", S.name], ["Generated", now.toLocaleString("en-NZ")], ["Regions", ids.length], ["Suburbs", linz.length], ["Residential sections", secs.length],
    ["Climate cells", cells.length], ["Days of climate", day.length], ["Imagery captures", caps.join(", ")], ["Access", ed ? "Editor: includes property-level sheets (Sections with imagery measures, Pool candidates). Handle under the project's privacy rules." : "Viewer: published aggregates and public LINZ data only."], [],
    ["Region", "TA", "Status", "Suburbs", "Sections", "Imagery", "Provider"],
    ...ids.map((k) => { const g = D.regions[k], r = regs.find((x) => x.id === k) || {}; return [g.label, r.ta_code || g.ta || "", r.status || "", g.suburbs.length, secs.filter((s) => s.region_id === k).length, (r.imagery_captures || []).join(", "), g.provider || ""]; })];
  const aboutRows = [["About this workbook"], [], ["Raw sheets", "One row per stored row, every column except geometry, combined across the study's regions (region_id first). Nothing is recalculated."],
    ["View sheets", "The CSV outputs with the same columns as the CSV files (suburb_lookup.html formats), built from the same data."],
    ["Privacy", "Only suburb aggregates are published. Property-level sheets appear only for editors, and the study configuration holds names and mappings, never file contents."], [],
    ["Sheet", "Rows", "Contents", "Source"], ...about, [], ["Metric", "Label", "Source"], ...(typeof METRICS !== "undefined" ? METRICS.map((m) => [m.id, m.label, m.src || ""]) : []), [],
    ["Source", "Link", "Licence"], ...XLSX_SOURCES];
  say("Writing the workbook…");
  return { ...(await buildXlsx([{ name: "Overview", rows: overview, kind: "text" }, { name: "About", rows: aboutRows, kind: "text" }, ...sheets, ...csvs])), study: S.name };
}

const _vExportX = V.export;
V.export = (...a) => {
  const html = _vExportX(...a); if (!D || !D.regions || !D.regions[region]) return html;
  const S = studyScope();
  return html.replace('<div class="card scroll">', `<div class="card" style="margin-bottom:12px"><h3>Study workbook (.xlsx)</h3><p class="small">Everything stored for <b>${esc(S.name)}</b> (${S.ids.length} region${S.ids.length === 1 ? "" : "s"}) in one Excel file. Raw sheets come first: regions, suburb metrics and census, SA2 census, monthly and daily climate, sections${can("editor") ? " with imagery measures, pool candidates" : ""}, imagery, validation, water rates, jobs${S.config ? " and the study configuration" : ""}. Then every CSV output as its own sheet, plus Overview and About sheets (sheet contents, metric definitions, sources and licences).</p>
    <button class="btn primary" id="dl-xlsx" type="button" ${user ? "" : "disabled"}>Download study workbook</button> <span class="small muted" id="xlsx-status"></span></div>
  <div class="card scroll">`);
};
document.addEventListener("click", async (e) => {
  if (!e.target || e.target.id !== "dl-xlsx") return;
  const b = e.target, st = $("#xlsx-status"), say = (m) => { if (st) st.textContent = m; };
  b.disabled = true;
  try { const { blob, study, names } = await studyWorkbook(say);
    const fn = `nz_suburb_study_${String(study).replace(/[^\w-]+/g, "_").slice(0, 40)}_${new Date().toISOString().slice(0, 10)}.xlsx`;
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = fn; document.body.appendChild(a); a.click(); a.remove();
    say(`Saved ${fn}: ${names.length} sheets, ${(blob.size / 1e6).toFixed(1)} MB.`); }
  catch (err) { say("Couldn't build the workbook: " + (err.message || err)); }
  b.disabled = false;
});
