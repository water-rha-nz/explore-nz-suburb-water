// kick-worker: start the GitHub Actions worker now (docs/SPEC.md section 17). GitHub runs the 15-minute schedule on a
// best-effort basis and can skip it for hours, so the app asks for a run when a batch is queued (or on "Run worker now").
// Editors only. Needs the secret GITHUB_DISPATCH_TOKEN: a fine-grained token for this repository with "Actions: read and write".
// Skips when a worker run is already queued or in progress, or one was requested in the last 5 minutes.
import { createClient } from "npm:@supabase/supabase-js@2.119.0";

const ORIGINS = ["https://water-rha-nz.github.io", "http://localhost:5173", "http://localhost:8000"];
const REPO = "water-rha-nz/explore-nz-suburb-water", WORKFLOW = "worker.yml", GAP_MIN = 5;
const cors = (req: Request) => { const o = req.headers.get("Origin") ?? "";
  return { "Access-Control-Allow-Origin": ORIGINS.includes(o) ? o : ORIGINS[0], "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS", "Vary": "Origin" }; };
const json = (req: Request, body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors(req), "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return json(req, { error: "POST only" }, 405);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { data: u } = await admin.auth.getUser((req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, ""));
  if (!u?.user) return json(req, { error: "sign in required" }, 401);
  const { data: role } = await admin.rpc("edge_user_role", { p_user: u.user.id });
  if (!["editor", "admin"].includes(role ?? "")) return json(req, { error: "editor role required" }, 403);
  const token = Deno.env.get("GITHUB_DISPATCH_TOKEN");
  if (!token) return json(req, { started: false, configured: false, message: "The worker can't be started from the app yet (no GITHUB_DISPATCH_TOKEN); it runs on GitHub's schedule." });

  const { data: last } = await admin.from("app_settings").select("value").eq("key", "worker_kick").maybeSingle();
  const at = last?.value?.at ? new Date(last.value.at).getTime() : 0;
  if (Date.now() - at < GAP_MIN * 60000) return json(req, { started: false, configured: true, message: `A worker run was requested ${Math.round((Date.now() - at) / 60000)} min ago.` });
  const gh = (path: string, init: RequestInit = {}) => fetch(`https://api.github.com/repos/${REPO}/actions/${path}`, { ...init,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "nz-suburb-water-profiles", ...(init.headers ?? {}) } });
  for (const status of ["in_progress", "queued"]) {
    const r = await gh(`workflows/${WORKFLOW}/runs?status=${status}&per_page=1`);
    if (r.ok && ((await r.json()).total_count ?? 0) > 0) return json(req, { started: false, configured: true, message: `A worker run is already ${status.replace("_", " ")}.` });
  }
  const r = await gh(`workflows/${WORKFLOW}/dispatches`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ref: "main" }) });
  if (r.status !== 204) return json(req, { started: false, configured: true, error: `GitHub HTTP ${r.status}` }, 502);
  await admin.from("app_settings").upsert({ key: "worker_kick", value: { at: new Date().toISOString() } });
  return json(req, { started: true, configured: true, message: "Worker started: it picks up the queued jobs within a minute or two." });
});
