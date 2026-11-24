// review-chips: blind second review of labelling chips (docs/SPEC.md section 29).
// Opened only by the single-purpose review key (REVIEW_TOKEN secret, sent as x-review-token). Serves anonymous JPEG chips (random
// token, task and image: no coordinates, tile, parcel, suburb, region or tool verdict) and records the reviewer's labels.
//   {action: "next", n?, task?, region?}  -> { chips: [{token, task, jpeg_b64}] }
//   {action: "label", token, label}        -> { result: "ok" | reason }
//   {action: "left", region?}              -> { chips, labelled }
import { createClient } from "npm:@supabase/supabase-js@2.119.0";

const REVIEWER = "second-reviewer";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const same = (a: string, b: string) => { if (!a || !b || a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const key = Deno.env.get("REVIEW_TOKEN") ?? "";
  if (key.length < 32 || !same(req.headers.get("x-review-token") ?? "", key)) return json({ error: "review key required" }, 401);
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  let b: { action?: string; n?: number; task?: string; region?: string; token?: string; label?: string } = {};
  try { b = await req.json(); } catch { /* empty */ }
  if (b.action === "next") {
    const { data, error } = await db.rpc("review_next", { p_reviewer: REVIEWER, p_n: Math.min(Number(b.n ?? 10), 20), p_task: b.task ?? null, p_region: b.region ?? null });
    return error ? json({ error: error.message }, 500) : json({ chips: data ?? [] });
  }
  if (b.action === "label") {
    const { data, error } = await db.rpc("review_label", { p_token: String(b.token ?? ""), p_reviewer: REVIEWER, p_label: String(b.label ?? "") });
    return error ? json({ error: error.message }, 400) : json({ result: data });
  }
  if (b.action === "left") {
    const { data, error } = await db.rpc("review_left", { p_reviewer: REVIEWER, p_region: b.region ?? null });
    return error ? json({ error: error.message }, 500) : json(data);
  }
  return json({ error: "action must be next, label or left" }, 400);
});
