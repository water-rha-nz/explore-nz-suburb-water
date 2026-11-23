// Account: per-user API keys (stored encrypted in Supabase Vault). Loaded after live.js.
"use strict";
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
