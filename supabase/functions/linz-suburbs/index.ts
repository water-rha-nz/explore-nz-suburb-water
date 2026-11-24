// linz-suburbs: LINZ suburbs of a TA, fetched once and cached for everyone, and place-name lookups (docs/SPEC.md section 25).
// Editors only. Uses the caller's own LINZ key (Vault) if set, else the project key (LINZ_API_KEY secret), counts usage against
// that key's daily budget (api_usage) and honours Retry-After.
//  - default: the TA's suburbs. LINZ lists 186 suburbs under more than one TA ("Tauranga City, Western Bay of Plenty District"),
//    so the filter matches any listed TA. A fetch is logged as complete only when every batch is stored; a partial fetch is
//    never served from the cache. The cache is fresh for 30 days (refresh: true forces a new fetch).
//  - action "nearby": LINZ suburbs with the given names that lie just outside the TA (within ~8 km), not yet in its list;
//    action "adopt": add chosen ones (by LINZ id) to the TA's list, flagged as adopted.
//  - action "places": NZ Gazetteer (official place names, layer 51681) points for names that match no LINZ suburb, in NZTM,
//    so the app can suggest the LINZ suburb that contains each place.
import { createClient } from "npm:@supabase/supabase-js@2.119.0";

const ORIGINS = ["https://water-rha-nz.github.io", "http://localhost:5173", "http://localhost:8000"];
const LINZ_BUDGET_DAY = 1500;      // matches backend/nzsw/limits.py DEFAULTS (raised up to the ceiling via app_settings.rates)
const LINZ_CEILING_DAY = 5000;
const FRESH_DAYS = 30;
const BATCH = 15;                  // suburbs stored per call (large rural outlines make big payloads)

function cors(req: Request) {
  const o = req.headers.get("Origin") ?? "";
  return { "Access-Control-Allow-Origin": ORIGINS.includes(o) ? o : ORIGINS[0], "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
           "Access-Control-Allow-Methods": "POST, OPTIONS", "Vary": "Origin" };
}
const json = (req: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors(req), "Content-Type": "application/json" } });
const lit = (s: string) => `'${String(s).replace(/'/g, "''").replace(/[%_]/g, "")}'`;
const fold = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "");
// round coordinates to ~0.1 m to keep payloads small
const roundGeom = (g: any): any => Array.isArray(g) ? (typeof g[0] === "number" ? g.map((v: number) => Math.round(v * 1e6) / 1e6) : g.map(roundGeom)) : g;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return json(req, { error: "POST only" }, 405);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: u } = await admin.auth.getUser(jwt);
  if (!u?.user) return json(req, { error: "sign in required" }, 401);
  const { data: role } = await admin.rpc("edge_user_role", { p_user: u.user.id });
  if (!["editor", "admin"].includes(role ?? "")) return json(req, { error: "editor role required" }, 403);

  let body: { ta_code?: string; refresh?: boolean; action?: string; names?: string[]; ids?: number[]; km?: number } = {};
  try { body = await req.json(); } catch { /* empty */ }
  const ta = String(body.ta_code ?? "").padStart(3, "0");
  const { data: t } = await admin.from("territorial_authorities").select("code,name,name_ascii").eq("code", ta).maybeSingle();
  if (!t) return json(req, { error: `unknown TA ${ta}` }, 400);

  // key and budget: the caller's own key or the project's, per key owner
  const { data: own } = await admin.rpc("edge_user_key", { p_user: u.user.id, p_service: "linz" });
  const key = own || Deno.env.get("LINZ_API_KEY");
  // budgets per key (as the worker counts them): '<user>:<8 hex of the key's SHA-256>'; the key itself is never stored
  const fp = async (k: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(k)))).slice(0, 4).map((b) => b.toString(16).padStart(2, "0")).join("");
  const owner = own ? `${u.user.id}:${await fp(own)}` : "project";
  const budgetLeft = async (n: number) => {
    const { data: rates } = await admin.from("app_settings").select("value").eq("key", "rates").maybeSingle();
    const budget = Math.min(Number(rates?.value?.linz_wfs?.budget_day ?? LINZ_BUDGET_DAY), LINZ_CEILING_DAY);
    const { data: used } = await admin.rpc("edge_usage_today", { p_service: "linz_wfs", p_owner: owner });
    return Number(used ?? 0) + n <= budget ? null : `LINZ daily budget used (${used}/${budget}); try again tomorrow (UTC)`;
  };
  const wfs = async (params: Record<string, string>) => {
    const url = new URL(`https://data.linz.govt.nz/services;key=${key}/wfs`);
    for (const [k, v] of Object.entries({ service: "WFS", version: "2.0.0", request: "GetFeature", outputFormat: "application/json", ...params })) url.searchParams.set(k, v);
    let r: Response | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      r = await fetch(url);
      await admin.rpc("edge_add_usage", { p_service: "linz_wfs", p_cost: 1, p_owner: owner });
      if (![429, 502, 503, 504].includes(r.status)) break;
      const ra = Number(r.headers.get("Retry-After") ?? "0");
      await new Promise((res) => setTimeout(res, Math.min(30, ra || 5 * 2 ** attempt) * 1000));
    }
    if (!r || r.status !== 200) throw new Error(`LINZ HTTP ${r?.status}`);
    return await r.json();
  };
  if (!key) return json(req, { error: "no LINZ key available" }, 500);

  // ---- place names (NZ Gazetteer) for study names that match no LINZ suburb
  if (body.action === "places") {
    const names = [...new Set((body.names ?? []).map((n) => String(n).trim()).filter(Boolean))].slice(0, 60);
    if (!names.length) return json(req, { places: [] });
    const chunks: string[][] = []; for (let i = 0; i < names.length; i += 20) chunks.push(names.slice(i, i + 20));
    const over = await budgetLeft(chunks.length); if (over) return json(req, { error: over }, 429);
    const places: unknown[] = [];
    try {
      for (const ch of chunks) {
        const terms = [...new Set(ch.flatMap((n) => [n, fold(n)]))];
        const fc = await wfs({ typeNames: "layer-51681", srsName: "EPSG:2193", count: "500", cql_filter: terms.map((n) => `name ILIKE ${lit(n)}`).join(" OR ") });
        for (const f of fc.features ?? []) { const p = f.properties ?? {}, c = f.geometry?.coordinates ?? [];
          places.push({ name: p.name, type: p.feat_type, status: p.status, x: c[0], y: c[1] }); }
      }
    } catch (e) { return json(req, { error: String((e as Error).message) }, 502); }
    return json(req, { places, requests: chunks.length });
  }

  // ---- suburbs just outside the TA: search LINZ by name nationally, keep those within a few km of the TA (not in its list)
  if (body.action === "nearby") {
    const names = [...new Set((body.names ?? []).map((n) => String(n).trim()).filter(Boolean))].slice(0, 60);
    if (!names.length) return json(req, { nearby: [] });
    const chunks: string[][] = []; for (let i = 0; i < names.length; i += 20) chunks.push(names.slice(i, i + 20));
    const over = await budgetLeft(chunks.length); if (over) return json(req, { error: over }, 429);
    const nearby: unknown[] = [];
    try {
      for (const ch of chunks) {
        const terms = [...new Set(ch.flatMap((n) => [n, fold(n)]))];
        const fc = await wfs({ typeNames: "layer-113764", srsName: "EPSG:2193", count: "300",
          cql_filter: terms.flatMap((n) => [`name ILIKE ${lit(n)}`, `name_ascii ILIKE ${lit(fold(n))}`]).join(" OR ") });
        const { data } = await admin.rpc("edge_near_ta", { p_ta: ta, p_fc: { features: fc.features ?? [] }, p_km: Number(body.km ?? 8) });
        nearby.push(...((data as unknown[]) ?? []));
      }
    } catch (e) { return json(req, { error: String((e as Error).message) }, 502); }
    return json(req, { nearby, requests: chunks.length });
  }
  // ---- adopt chosen nearby suburbs into the TA's list (by LINZ id)
  if (body.action === "adopt") {
    const ids = [...new Set((body.ids ?? []).map(Number).filter((x) => Number.isInteger(x)))].slice(0, 30);
    if (!ids.length) return json(req, { adopted: 0 });
    const over = await budgetLeft(1); if (over) return json(req, { error: over }, 429);
    try {
      const fc = await wfs({ typeNames: "layer-113764", srsName: "EPSG:4326", count: "100", cql_filter: `id IN (${ids.join(",")})` });
      const feats = (fc.features ?? []).map((f: any) => ({ ...f, geometry: f.geometry ? { ...f.geometry, coordinates: roundGeom(f.geometry.coordinates) } : f.geometry }));
      const { data, error } = await admin.rpc("edge_adopt_suburbs", { p_ta: ta, p_fc: { features: feats } });
      if (error) return json(req, { error: "store failed: " + error.message }, 500);
      return json(req, { adopted: data ?? 0, requests: 1 });
    } catch (e) { return json(req, { error: String((e as Error).message) }, 502); }
  }

  // ---- the TA's suburbs: shared cache first (complete and fresh), else fetch
  const { data: log } = await admin.from("linz_suburb_fetch").select("fetched_at,complete,features").eq("ta_code", ta).maybeSingle();
  if (log?.complete && !body.refresh && Date.now() - new Date(log.fetched_at).getTime() < FRESH_DAYS * 864e5)
    return json(req, { ta_code: ta, cached: true, requests: 0, suburbs: log.features });
  const over = await budgetLeft(1); if (over) return json(req, { error: over }, 429);

  const tnames = [...new Set([t.name, t.name_ascii, ta === "046" ? "Hutt City" : null].filter(Boolean) as string[])];
  const want = new Set(tnames.map((n) => fold(n).toLowerCase()));
  let fc: any;
  try {
    fc = await wfs({ typeNames: "layer-113764", srsName: "EPSG:4326", count: "10000",
      cql_filter: tnames.flatMap((n) => [`territorial_authority LIKE ${lit("%" + n + "%")}`, `territorial_authority_ascii LIKE ${lit("%" + fold(n) + "%")}`]).join(" OR ") });
  } catch (e) { return json(req, { error: String((e as Error).message) }, 502); }
  // keep suburbs whose list of TAs includes this one exactly ("Hutt City" must not match "Upper Hutt City")
  const feats = (fc.features ?? []).filter((f: any) => String(f.properties?.territorial_authority_ascii ?? f.properties?.territorial_authority ?? "")
    .split(",").map((x: string) => fold(x.trim()).toLowerCase()).some((x: string) => want.has(x)))
    .map((f: any) => ({ ...f, geometry: f.geometry ? { ...f.geometry, coordinates: roundGeom(f.geometry.coordinates) } : f.geometry }));
  await admin.rpc("edge_suburb_fetch", { p_ta: ta, p_done: false });
  for (let i = 0; i < feats.length; i += BATCH) {
    const { error } = await admin.rpc("edge_store_suburbs", { p_ta: ta, p_fc: { features: feats.slice(i, i + BATCH) } });
    if (error) return json(req, { error: `store failed after ${i} of ${feats.length} suburbs: ${error.message}; validate again to retry` }, 500);
  }
  await admin.rpc("edge_suburb_fetch", { p_ta: ta, p_done: true, p_features: feats.length });
  const shared = feats.filter((f: any) => String(f.properties?.territorial_authority ?? "").includes(",")).length;
  return json(req, { ta_code: ta, cached: false, requests: 1, suburbs: feats.length, shared_with_other_tas: shared, key: own ? "yours" : "project" });
});
