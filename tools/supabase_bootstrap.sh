#!/usr/bin/env bash
# Bootstrap the Supabase project and Google sign-in (docs/SPEC.md sections 12-13).
#   tools/supabase_bootstrap.sh            plan only: report what would happen (default)
#   tools/supabase_bootstrap.sh --apply    do it (idempotent: re-running skips finished steps)
#
# Reads credentials from owner-only files and never prints them:
#   ~/.config/supabase/access_token        personal access token (supabase.com/dashboard/account/tokens)
#   ~/.config/supabase/db_password         generated database password
#   ~/.config/supabase/org_id              optional: organisation ID (needed only if you belong to several)
#   ~/.config/google/oauth_client_id       Google OAuth web client ID      (after step "google")
#   ~/.config/google/oauth_client_secret   Google OAuth web client secret  (after step "google")
#   ~/.config/linz/api_key, ~/.config/statsnz/{ade_key,datafinder_key}   pushed as Edge Function secrets
# --apply passes --yes to the Supabase CLI (hosted changes): run it only after the user has approved.
# Writes ~/.config/supabase/project_ref and ./.env (gitignored: project URL + publishable anon key).
set -euo pipefail
cd "$(dirname "$0")/.."
SB="${SUPABASE_BIN:-$HOME/.local/bin/supabase}"
NAME="${SUPABASE_PROJECT_NAME:-explore-nz-suburb-water-syd}"; REGION="ap-southeast-2"
APPLY=0; [[ "${1:-}" == "--apply" ]] && APPLY=1
C="$HOME/.config"
has() { [[ -s "$1" ]]; }
val() { tr -d '\r\n' < "$1"; }
step() { printf '\n== %s\n' "$*"; }
do_or_plan() { if (( APPLY )); then "$@"; else echo "   would run: ${*//$PW/<db-password>}"; fi; }
json() { python3 -c "import json,sys; d=json.load(sys.stdin); $1"; }

for f in "$C/supabase/access_token" "$C/supabase/db_password" "$C/supabase/org_id" "$C"/google/oauth_client_* "$C/linz/api_key" "$C"/statsnz/*_key; do
  [[ -e "$f" ]] && [[ "$(stat -c %a "$f")" != 600 ]] && { echo "refusing: $f must be chmod 600"; exit 1; }
done

step "1. Supabase access token"
if ! has "$C/supabase/access_token"; then
  echo "   missing: create a personal access token at https://supabase.com/dashboard/account/tokens"
  echo "   and paste it into $C/supabase/access_token (chmod 600). Nothing else can run until then."
  exit 0
fi
export SUPABASE_ACCESS_TOKEN; SUPABASE_ACCESS_TOKEN="$(val "$C/supabase/access_token")"
PW="$(val "$C/supabase/db_password")"
echo "   ok (token present)"

step "2. Organisation"
if has "$C/supabase/org_id"; then
  ORG="$(val "$C/supabase/org_id")"; echo "   organisation: $ORG (from org_id; no organisation listing needed)"
else
  ORGS="$("$SB" orgs list -o json)"
  N="$(echo "$ORGS" | json 'print(len(d))')"
  [[ "$N" == 1 ]] || { echo "   you belong to $N organisations; put the right ID in $C/supabase/org_id:"; echo "$ORGS" | json 'print("\n".join(f"   {o[\"id\"]}  {o[\"name\"]}" for o in d))'; exit 0; }
  ORG="$(echo "$ORGS" | json 'print(d[0]["id"])')"
  echo "   organisation: $(echo "$ORGS" | json 'print(d[0]["name"])')"
fi

step "3. Project ($NAME, $REGION, free plan)"
REF="$("$SB" projects list -o json | json "print(next((p['id'] for p in d if p['name']=='$NAME'), ''))")"
if [[ -n "$REF" ]]; then echo "   exists: $REF"
else
  do_or_plan "$SB" --yes projects create "$NAME" --org-id "$ORG" --region "$REGION" --db-password "$PW"
  (( APPLY )) || { echo "   (plan stops here: later steps need the project)"; exit 0; }
  REF="$("$SB" projects list -o json | json "print(next((p['id'] for p in d if p['name']=='$NAME'), ''))")"
  echo "   created: $REF; waiting for it to become healthy"
  for i in $(seq 1 60); do
    S="$("$SB" projects list -o json | json "print(next((p.get('status','') for p in d if p['id']=='$REF'), ''))")"
    [[ "$S" == ACTIVE_HEALTHY ]] && break; sleep 10
  done
fi
echo "$REF" > "$C/supabase/project_ref"; chmod 600 "$C/supabase/project_ref"
echo "   Google redirect URI to register: https://$REF.supabase.co/auth/v1/callback"

step "4. Link and apply migrations"
do_or_plan "$SB" --yes link --project-ref "$REF"
if (( APPLY )); then "$SB" db push --remote --dry-run -p "$PW"; fi
do_or_plan "$SB" --yes db push --remote -p "$PW"

step "5. Google sign-in (auth config)"
if has "$C/google/oauth_client_id" && has "$C/google/oauth_client_secret"; then
  export SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET
  SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID="$(val "$C/google/oauth_client_id")"
  SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET="$(val "$C/google/oauth_client_secret")"
  do_or_plan "$SB" --yes config push   # site_url, redirect URLs, Google provider, email sign-in off (supabase/config.toml)
else
  echo "   waiting for the Google OAuth client: create it with redirect URI https://$REF.supabase.co/auth/v1/callback,"
  echo "   then put the client ID and secret in $C/google/oauth_client_id and oauth_client_secret (chmod 600)."
fi

step "6. Edge Function / worker secrets"
TMP="$(mktemp)"; chmod 600 "$TMP"; trap 'rm -f "$TMP"' EXIT
has "$C/linz/api_key" && echo "LINZ_API_KEY=$(val "$C/linz/api_key")" >> "$TMP"
has "$C/statsnz/ade_key" && echo "STATSNZ_ADE_KEY=$(val "$C/statsnz/ade_key")" >> "$TMP"
has "$C/statsnz/datafinder_key" && echo "STATSNZ_DATAFINDER_KEY=$(val "$C/statsnz/datafinder_key")" >> "$TMP"
echo "   $(wc -l < "$TMP") secret(s) found: $(cut -d= -f1 "$TMP" | tr '\n' ' ')"
[[ -s "$TMP" ]] && do_or_plan "$SB" --yes secrets set --env-file "$TMP"

step "7. Client config (.env, gitignored)"
if (( APPLY )); then
  ANON="$("$SB" projects api-keys --remote="$REF" -o json | json "print(next((k['api_key'] for k in d if k.get('name') in ('anon','publishable')), ''))")"
  umask 077; printf 'VITE_SUPABASE_URL=https://%s.supabase.co\nVITE_SUPABASE_ANON_KEY=%s\n' "$REF" "$ANON" > .env
  echo "   wrote .env (project URL and publishable anon key)"
else echo "   would write .env with the project URL and anon key"; fi

step "Done"
echo "   Next: first sign-in with Google creates your profile as 'viewer' (pending). Promote yourself to admin once:"
echo "   update profiles set role = 'admin', status = 'active' where email = '<your Google email>';   (SQL editor)"
