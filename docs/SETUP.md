# Setup checklist: Supabase and Google sign-in

This covers the steps between "accounts exist" and "a signed-in admin". The design is in `docs/SPEC.md` sections 12–13, and `tools/supabase_bootstrap.sh` automates everything that doesn't need a browser.

## Done (no credentials needed)
- [x] Supabase CLI 3.2.0 installed (`~/.local/bin/supabase`), with its checksum verified against the release's `checksums.txt`.
- [x] `supabase/config.toml` (`supabase init`) configured:
  - site URL: the GitHub Pages demo URL;
  - redirect URLs: Pages, `localhost:5173` and `127.0.0.1:3000`;
  - email sign-in **off**, **Google** sign-in on;
  - the client ID and secret are read from environment variables and never committed.
- [x] Migrations `0001_init`, `0002_worker` and `0003_storage` parse with PostgreSQL's parser (pglast / libpg_query), including the function and trigger bodies. They haven't yet been applied to a database.
- [x] Credential files created, owner-only (600):
  - `~/.config/supabase/access_token` (empty);
  - `~/.config/supabase/db_password`: generated, 32 characters, never printed;
  - `~/.config/google/oauth_client_id` and `oauth_client_secret` (empty).
- [x] `tools/supabase_bootstrap.sh`. With no arguments it only plans; `--apply` creates and configures. Re-running it skips finished steps.

## You do (needs your browser)
1. **Supabase access token**
   - Create one at https://supabase.com/dashboard/account/tokens (name it e.g. `explore-nz-suburb-water bootstrap`) and paste it into `~/.config/supabase/access_token`.
   - If you belong to more than one organisation, also put the organisation ID in `~/.config/supabase/org_id`.
   - Revoke the token once setup is finished if you like; the app itself never uses it.
2. Then `tools/supabase_bootstrap.sh --apply` (I can run this):
   - creates the project `explore-nz-suburb-water` in **Sydney (ap-southeast-2)** on the **free** plan;
   - links it and applies the migrations;
   - pushes the API keys as secrets;
   - writes `.env`;
   - prints the Google redirect URI, `https://<project-ref>.supabase.co/auth/v1/callback`.
3. **Google OAuth client** (Google Cloud console, https://console.cloud.google.com):
   1. Create (or pick) a project: `explore-nz-suburb-water`.
   2. **Google Auth Platform → Branding** (OAuth consent screen):
      - app name `Explore NZ Suburb Water`, with your support email;
      - app home page `https://water-rha-nz.github.io/explore-nz-suburb-water/`;
      - authorised domain `supabase.co`;
      - developer contact email.
   3. **Audience:** External. While in *Testing*, add the Google accounts that may sign in as test users; publish when ready. The `openid`, `email` and `profile` scopes need no Google verification.
   4. **Data access → scopes:** `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile` only.
   5. **Clients → Create client → Web application**, name `Supabase auth`:
      - Authorised JavaScript origins: `https://water-rha-nz.github.io`, `http://localhost:5173`
      - Authorised redirect URI: **`https://<project-ref>.supabase.co/auth/v1/callback`** (from step 2)
   6. Copy the client ID and secret into `~/.config/google/oauth_client_id` and `~/.config/google/oauth_client_secret`.
4. Run `tools/supabase_bootstrap.sh --apply` again. Step 5 pushes the Google provider into Supabase Auth.
5. **First admin:** sign in once with Google; your profile is created as `viewer` / `pending`. Then, in the Supabase SQL editor:
   ```sql
   update profiles set role = 'admin', status = 'active' where email = '<your Google email>';
   ```

## Not part of this setup
- Worker hosting (GitHub Actions workflows need a token with the `workflow` scope) and the `worker` database role password. Both come at milestone M3–M4.
