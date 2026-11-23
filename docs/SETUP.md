# Setup checklist: Supabase and Google sign-in

This covers the steps between "accounts exist" and "a signed-in admin". The design is in `docs/SPEC.md` sections 12–13, and `tools/supabase_bootstrap.sh` automates everything that doesn't need a browser.

## Done (no credentials needed)
- [x] Supabase CLI 3.2.0 installed (`~/.local/bin/supabase`), with its checksum verified against the release's `checksums.txt`.
- [x] `supabase/config.toml` (`supabase init`) configured:
  - site URL: the GitHub Pages demo URL;
  - redirect URLs: Pages, `localhost:5173` and `127.0.0.1:3000`;
  - email sign-in **off**, **Google** sign-in on;
  - the client ID and secret are read from environment variables and never committed.
- [x] Migrations `0001_init`, `0002_worker` and `0003_storage` parse with PostgreSQL's parser (pglast / libpg_query), including the function and trigger bodies. Applied on 2026-11-23 (below).
- [x] Credential files created, owner-only (600):
  - `~/.config/supabase/access_token` (now filled by you);
  - `~/.config/supabase/db_password`: generated, 32 characters, never printed;
  - `~/.config/google/oauth_client_id` and `oauth_client_secret` (empty).
- [x] `tools/supabase_bootstrap.sh`. With no arguments it only plans; `--apply` creates and configures. Re-running it skips finished steps.

## Done with your Supabase token (2026-11-23)
- [x] Project **`explore-nz-suburb-water-syd`** created: ref `uthodoiocvnwxwfzahwd`, **Sydney (ap-southeast-2)**, free plan.
  - An earlier dashboard-created project, `explore-nz-suburb-water` (`mnncigxmrbmxfowwppfg`), is in Tokyo and isn't used. Delete it when convenient.
- [x] Linked. Migrations `0001`–`0004` applied and verified against the live database:
  - 27 tables with RLS, policies, `has_role`, `claim_job`, the sign-in trigger and audit triggers;
  - private `exports` / `chips` buckets and the `worker` role (no RLS bypass);
  - PostGIS and pg_net in the `extensions` schema.
- [x] Security advisor after `0004_hardening`: one expected warning, that signed-in users can execute `has_role`, which the RLS policies need.
- [x] Secrets set: `LINZ_API_KEY`, `STATSNZ_ADE_KEY`, `STATSNZ_DATAFINDER_KEY`. `.env` written (gitignored).
- **Google redirect URI:** `https://uthodoiocvnwxwfzahwd.supabase.co/auth/v1/callback`

## You do (needs your browser)
1. ~~Supabase access token~~ (done).
2. ~~`tools/supabase_bootstrap.sh --apply`~~ (done: see above).
3. ~~Google OAuth client~~ (done: authorised domains `water-rha-nz.github.io` and `uthodoiocvnwxwfzahwd.supabase.co`).
4. ~~Bootstrap again~~ (done: Google provider enabled; MFA kept available; redirect allow-list covers the Pages site and localhost).
5. ~~First admin~~ (done 2026-11-23: signed in via `signin.html`, promoted to admin / active; the change is in `audit_log`).

## Status: setup complete
- Real sign-in: https://water-rha-nz.github.io/explore-nz-suburb-water/signin.html
- Later Google accounts arrive as `viewer` / `pending`. An admin approves them by setting `status = 'active'` (and a role).
- Housekeeping: revoke the Supabase personal access token when setup changes are finished (the app doesn't use it); delete the unused Tokyo project; optionally rotate the Supabase secret key.

## Not part of this setup
- Worker hosting (GitHub Actions workflows need a token with the `workflow` scope) and the `worker` database role password. Both come at milestone M3–M4.
