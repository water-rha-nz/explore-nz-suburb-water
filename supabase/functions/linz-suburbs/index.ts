// linz-suburbs: fetch a TA's LINZ suburbs once and cache them for everyone (docs/SPEC.md section 25).
// Editors only. Uses the caller's own LINZ key (Vault) if set, else the project key (LINZ_API_KEY secret).
// Counts usage against that key's daily budget (api_usage), honours Retry-After, and serves the shared cache
// (fresh for 30 days) without calling LINZ.
import { createClient } from "npm:@supabase/supabase-js@2.119.0";

const ORIGINS = ["https://water-rha-nz.github.io", "http://localhost:5173", "http://localhost:8000"];
const LINZ_BUDGET_DAY = 1500;      // matches backend/nzsw/limits.py DEFAULTS (raised up to the ceiling via app_settings.rates)
const LINZ_CEILING_DAY = 5000;
const FRESH_DAYS = 30;

function cors(req: Request) {
  const o = req.headers.get("Origin") ?? "";
  return { "Access-Control-Allow-Origin": ORIGINS.includes(o) ? o : ORIGINS[0], "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
           "Access-Control-Allow-Methods": "POST, OPTIONS", "Vary": "Origin" };
}
const json = (req: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors(req), "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return json(req, { error: "POST only" }, 405);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: u } = await admin.auth.getUser(jwt);
  if (!u?.user) return json(req, { error: "sign in required" }, 401);
  const { data: role } = await admin.rpc("edge_user_role", { p_user: u.user.id });
  if (!["editor", "admin"].includes(role ?? "")) return json(req, { error: "editor role required" }, 403);

  let body: { ta_code?: string; refresh?: boolean } = {};
  try { body = await req.json(); } catch { /* empty */ }
  const ta = String(body.ta_code ?? "").padStart(3, "0");
  const { data: t } = await admin.from("territorial_authorities").select("code,name,name_ascii").eq("code", ta).maybeSingle();
  if (!t) return json(req, { error: `unknown TA ${ta}` }, 400);

  // shared cache first: no LINZ request if anyone fetched this TA recently
  const { data: c } = await admin.from("linz_suburb_index").select("fetched_at").eq("ta_code", ta).order("fetched_at", { ascending: true }).limit(1);
  if (c?.length && !body.refresh && Date.now() - new Date(c[0].fetched_at).getTime() < FRESH_DAYS * 864e5)
    return json(req, { ta_code: ta, cached: true, requests: 0 });

  // key: the caller's own (Vault) or the project's; budget per key owner
  const { data: own } = await admin.rpc("edge_user_key", { p_user: u.user.id, p_service: "linz" });
  const key = own || Deno.env.get("LINZ_API_KEY");
  const owner = own ? u.user.id : "project";
  if (!key) return json(req, { error: "no LINZ key available" }, 500);
  const { data: rates } = await admin.from("app_settings").select("value").eq("key", "rates").maybeSingle();
  const budget = Math.min(Number(rates?.value?.linz_wfs?.budget_day ?? LINZ_BUDGET_DAY), LINZ_CEILING_DAY);
  const { data: used } = await admin.rpc("edge_usage_today", { p_service: "linz_wfs", p_owner: owner });
  if (Number(used ?? 0) + 1 > budget) return json(req, { error: `LINZ daily budget used (${used}/${budget}); try again tomorrow (UTC)` }, 429);

  const names = [...new Set([t.name, t.name_ascii, ta === "046" ? "Hutt City" : null].filter(Boolean))].map((n) => `'${String(n).replace(/'/g, "''")}'`).join(",");
  const url = new URL(`https://data.linz.govt.nz/services;key=${key}/wfs`);
  for (const [k, v] of Object.entries({ service: "WFS", version: "2.0.0", request: "GetFeature", typeNames: "layer-113764", outputFormat: "application/json",
    srsName: "EPSG:4326", count: "10000", cql_filter: `territorial_authority_ascii IN (${names}) OR territorial_authority IN (${names})` })) url.searchParams.set(k, v);
  let r: Response | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    r = await fetch(url);
    await admin.rpc("edge_add_usage", { p_service: "linz_wfs", p_cost: 1, p_owner: owner });
    if (![429, 502, 503, 504].includes(r.status)) break;
    const ra = Number(r.headers.get("Retry-After") ?? "0");
    await new Promise((res) => setTimeout(res, Math.min(30, ra || 5 * 2 ** attempt) * 1000));
  }
  if (!r || r.status !== 200) return json(req, { error: `LINZ HTTP ${r?.status}` }, 502);
  const fc = await r.json();
  const feats = fc.features ?? [];
  for (let i = 0; i < feats.length; i += 40) {   // store in batches (large TAs have big outlines)
    const { error } = await admin.rpc("edge_store_suburbs", { p_ta: ta, p_fc: { features: feats.slice(i, i + 40) } });
    if (error) return json(req, { error: "store failed: " + error.message }, 500);
  }
  return json(req, { ta_code: ta, cached: false, requests: 1, suburbs: feats.length, key: own ? "yours" : "project" });
});
