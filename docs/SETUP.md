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
3. **Google OAuth client** (Google Cloud console, https://console.cloud.google.com):
   1. **New Project** screen: project name `explore-nz-suburb-water` (the project ID can stay as suggested). With a personal Google account, **Organisation / Parent resource = "No organisation"** is correct. Press **Create**, then select the new project in the top bar.
   2. Menu ☰ → **APIs & Services → OAuth consent screen**, which opens the **Google Auth Platform**. Press **Get started**, then **Branding** (OAuth consent screen):
      - app name `Explore NZ Suburb Water`, with your support email;
      - app home page `https://water-rha-nz.github.io/explore-nz-suburb-water/`;
      - authorised domains `water-rha-nz.github.io` and **`uthodoiocvnwxwfzahwd.supabase.co`**. `github.io` and `supabase.co` are public suffixes, so Google only accepts the subdomain, and rejects `supabase.co` with "must be a top private domain";
      - developer contact email.
   3. **Audience:** External. While in *Testing*, add the Google accounts that may sign in as test users; publish when ready. The `openid`, `email` and `profile` scopes need no Google verification.
   4. **Data access → scopes:** `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile` only.
   5. **Clients → Create client → Web application**, name `Supabase auth`:
      - Authorised JavaScript origins: `https://water-rha-nz.github.io`, `http://localhost:5173`
      - Authorised redirect URI: **`https://uthodoiocvnwxwfzahwd.supabase.co/auth/v1/callback`**
   6. Copy the client ID and secret into `~/.config/google/oauth_client_id` and `~/.config/google/oauth_client_secret`.
4. Run `tools/supabase_bootstrap.sh --apply` again. Step 5 pushes the Google provider into Supabase Auth.
5. **First admin:** sign in once with Google; your profile is created as `viewer` / `pending`. Then, in the Supabase SQL editor:
   ```sql
   update profiles set role = 'admin', status = 'active' where email = '<your Google email>';
   ```

## Not part of this setup
- Worker hosting (GitHub Actions workflows need a token with the `workflow` scope) and the `worker` database role password. Both come at milestone M3–M4.
