# explore-nz-suburb-water: application specification

Version 0.2 (draft), 2026-11-23

**Status:** specification and static demo only. Supabase and Google Cloud accounts exist, but no Supabase project or OAuth client has been created yet; sections 12–13 give the setup. The demo is in `demo/`, built from the Taupō and Tauranga pilot.

## 1. Purpose
A web application that prepares, maintains and exports **suburb-level metadata for residential water-demand analysis anywhere in New Zealand**. It covers every explanatory variable of Ghavidelfar, Shamseldin & Melville (2018) *except water consumption*.

It combines four existing workflows into one app backed by a **living Supabase database**, with Google sign-in:

1. **`nz_suburb_lookup`** (single-file HTML reference builder): LINZ suburbs, dwellings, addresses, section sizes, urban/rural classification, provider (PRVDR) mapping, water rates, census demographics joined to suburbs.
2. **Imagery pipeline** (`suburb_pilot/detect.py`, `aggregate.py`): pools, vegetated (garden) area, roofs and unbuilt area per section, from LINZ RGB + near-infrared aerial imagery.
3. **Validation app** (`suburb_pilot/app`): arrow-key labelling of pool and garden chips, with tool-vs-human-vs-reference agreement statistics.
4. **API connectors** (`suburb_pilot/connectors`): LINZ LDS, Stats NZ Datafinder, Stats NZ ADE (census) and Open-Meteo (climate).

### Out of scope
- **Water consumption.** The app never stores or processes meter or billing data. Users join consumption elsewhere, e.g. in the original HTML tool's Report stage or their own models, using the exported keys (`M_SUBURB`, `PRVDR`, SA2 code).
- Census microdata (IDI / Data Lab). Only published aggregate tables are used.
- Earth Sciences NZ (NIWA) data. Climate comes from Open-Meteo (decision 2026-11-23).

## 2. Users, access and roles
- **Authentication:** Supabase Auth with **Google OAuth** only. There is no anonymous access to the app UI.
- **Authorisation:** a `profiles` table with a `role`, enforced by Postgres **row-level security (RLS)** on every table.

| Role | Can |
|---|---|
| `viewer` | Browse regions, suburbs and maps; download exports of published regions |
| `labeller` | Viewer, plus label pool and garden validation items |
| `editor` | Labeller, plus create regions, run pipelines, allocate suburbs and providers, edit water rates, publish a region |
| `admin` | Everything, including managing users and roles, service keys (via secrets, never shown), refresh schedules |

- New Google sign-ins get `viewer`, or wait for approval: **pending** status until an admin approves them (configurable). An optional email-domain allowlist is possible.
- Every edit is recorded in `audit_log` (who, when, table, row, old and new values).

## 3. Architecture

```
Browser SPA (static; GitHub Pages / Vercel / Netlify)
  └─ supabase-js (anon key + user JWT; RLS does all authorisation)
Supabase
  ├─ Postgres + PostGIS   living database (section 4)
  ├─ Auth (Google)        roles in profiles
  ├─ Storage              imagery chips, export bundles, run logs
  ├─ Edge Functions       light API calls: Stats NZ ADE, Datafinder, LINZ WFS, Open-Meteo
  │                       keys held in Supabase secrets; never sent to the browser
  └─ pg_cron              schedules refresh jobs (section 6)
Worker (Python container: GitHub Actions runner, Fly.io, or a local machine)
  └─ heavy jobs: imagery tiles → pools / vegetation; LINZ bulk layers; national runs
     polls a `jobs` table, writes results back with a service-role key held only by the worker
```

- **Why a worker:** imagery processing needs GDAL, rasterio and OpenCV, minutes per tile and gigabytes of reads. That exceeds Edge Function limits. The pilot's Python code becomes the worker with minimal change.
- **Frontend:** TypeScript plus a light framework (e.g. Svelte or React with Vite) and MapLibre GL for maps. The existing pages' visual language (stages, colour tokens, dark mode) carries over.
- **Living database:** every source row records `source`, `source_version` (e.g. capture ID, census year, LDS changeset date) and `fetched_at`. Refreshes add new versions instead of overwriting, so any export can be reproduced for an `as_of` date.

## 4. Data model (core tables)
All geometries are NZTM (EPSG:2193) with a PostGIS GIST index.

| Table | Key | Main columns | Source |
|---|---|---|---|
| `regions` | id | name, TA list, suburb list, imagery capture(s), status (draft/processing/published) | editor |
| `suburbs` | linz_id | name, type, territorial_authority, geom, population_estimate | LINZ 113764 |
| `m_suburbs` | id | M_SUBURB, M_TERRITORY, PRVDR, other spellings | user lists (`nz_suburb_map`, `nz_suburb_provider`) |
| `m_suburb_links` | m_suburb_id, linz_id | allocation, share rule | Allocate workflow |
| `sections` | parcel_id | appellation, intent, survey_area, polygon_m2, geom, suburb_id, sa2_code | LINZ 50772 |
| `titles` | title_no | type (Freehold / Cross lease / Unit title…), issue_date, spatial_extents_shared, parcel links | LINZ 50804 |
| `buildings` | building_id | geom, area_m2, capture_source | LINZ 101290 |
| `addresses` | address_id | geom, unit, suburb_locality, is_land | LINZ addresses |
| `dwellings` | id | section_id, title_no, SECTION_TYPE, NUM_SECTIONS, housing_type (detached / multi-unit; storeys when LiDAR is added) | derived (reference-builder logic) |
| `imagery_captures` | id | s3 prefix, year, resolution, bands, calibration (pool thresholds or model version) | LINZ S3 STAC |
| `section_imagery` | section_id, capture_id | valid_m2, open_m2, veg_m2, building_m2, unbuilt_m2 | worker |
| `pool_candidates` | id | capture_id, geom (point + polygon), area_m2, colour features, tool verdict, section_id | worker |
| `validation_items` / `validation_labels` | item_id / (item_id, user_id) | chip path, task (pool/garden), tool verdict; label, timestamp | validation workflow |
| `sa2` | sa2_code | name, geom, version (2023) | Datafinder 111206 |
| `census_values` | sa2_code, dataflow, year, dims (jsonb) | value, status (c / _U) | ADE |
| `census_metrics` | sa2_code, year | households, % separate/joined, bedrooms, % owner (by type), hh size, median income | derived |
| `climate_daily` | grid_cell_id, date | rain, Tmean, Tmax, ET0 | Open-Meteo (fetched once per grid cell, mapped to suburbs) |
| `water_rates` | PRVDR, valid_from | CHARGING_TYPE, FIXED_PA, VOLUMETRIC_PA, THRESHOLD_Lpd, DATE_EST, source URL, verified | `WATER` constant plus editor edits (history kept for the price variable) |
| `providers` | PRVDR | name, aliases, TAs served | reference builder |
| `jobs`, `job_runs` | id | type, region, params, status, log, counts | orchestration |
| `exports` | id | region, as_of, format, file in Storage, checksum | export workflow |

### Derived views (what users consume)
- `v_suburb_metadata` (one row per M_SUBURB or LINZ suburb × year): the paper's variables except DWU:
  - `HhSize`, `Income`, `BRooms`, `Owner` (census, apportioned SA2 → suburb by residential sections)
  - `PercPool`, `PoolArea` (imagery, latest or by capture year)
  - `GardSize` (vegetated m², mean and median), `Unbuilt`, `LotSize`, `Footprint`, `ImperviousProxy` (unbuilt − vegetated)
  - `PctDetached` / `PctJoined` (census and titles), `MedianTitleAge` (title issue_date)
  - `Price` (volumetric water + wastewater $/m³ from `water_rates`; real-terms using CPI)
  - `Temp`, `Rain`, `ET0`, `Deficit`: daily, monthly, and summer-February / winter-June
  - `UrbanRural`, `HH_COUNT`, `PRVDR`
- `v_suburb_metadata_by_type`: the same split detached vs multi-unit where the source supports it (bedrooms, owner, lot, garden, pool).

## 5. Workflows (app stages)
The stage layout of the original tool is kept and extended.

1. **Region:** choose TA(s) and suburbs, or draw an area. The app shows which LINZ imagery captures with near-infrared cover it, and lets you queue the pipeline.
2. **Load:** LINZ layers (suburbs, parcels, titles, buildings, addresses) through the WFS Edge Function or the worker for large areas. Optional user lists (`nz_suburb_map.csv`, `nz_suburb_ref.csv`, `nz_suburb_provider.csv`) and config import (`nz_suburb_builder_config.json`).
3. **Allocate:** suburbs, providers and duplicates, as in the reference builder; saved to `m_suburb_links` and `providers`.
4. **Imagery:** worker runs pools and vegetation per capture, with progress. Calibration is per capture.
5. **Validate:** the arrow-key labeller (← not pool, ↑ water not pool, ↓ unknown, → pool; gardens ← too much, ↑ about right, → too little, ↓ unknown). Multiple labellers; agreement and per-capture precision / recall shown. Labels feed calibration: thresholds, or a small classifier trained on blob features with a held-out test split.
6. **Context:** census (ADE) and climate (Open-Meteo) fetch and refresh; SA2 → suburb apportioning.
7. **Explore:** maps and tables of `v_suburb_metadata`; distributions; comparison across regions.
8. **Export:** section 7. A region must be **published** (editor) before viewers can export it.

## 6. Keeping the database "living"

| Source | Refresh | Mechanism |
|---|---|---|
| LINZ parcels, titles, buildings, addresses | Weekly | LDS changesets (WFS `changeset` endpoint) by region bbox |
| LINZ imagery | When a new capture appears in `nz-imagery` STAC | Weekly STAC poll → job queued for the editor to approve |
| Stats NZ census | Per census release (2028…) | Manual trigger; dataflow version recorded |
| Stats NZ CPI | Quarterly | Edge Function |
| Open-Meteo climate | Daily (append yesterday) or monthly | pg_cron → Edge Function; one call per grid cell |
| Water rates | Annual (July) | Editor workflow with verification status and source link |

## 7. Exports
### 7a. Compatible with the original `suburb_lookup.html`
Same file names, columns, delimiters and encoding, so the files drop straight into the original tool (including its Report stage):

| File | Columns / format |
|---|---|
| `nz_suburb_ref.csv` | M_SUBURB, TYPE, M_TERRITORY, M_SUBURB_HH_COUNT |
| `nz_household_ref.csv` | M_SUBURB, M_DWELLING_ID, SECTION_TYPE, SECTION_SIZE_M2, NUM_SECTIONS, SECTION_AVG_M2 |
| `nz_urban_rural.csv` (**tab-separated**) | SUBURB, TYPE, PROVIDER, NOTE |
| `nz_water_rates.csv` | PROVIDER, CHARGING_TYPE, FIXED_PA, VOLUMETRIC_PA, THRESHOLD_Lpd, DATE_EST, NOTE |
| `nz_suburb_map_allocations.csv`, `nz_suburb_ref_dropped.csv`, `nz_household_ref_dropped.csv` | as the original |
| `nz_suburb_demographics.csv` | M_SUBURB, M_TERRITORY, PRVDR, then one column per metric. **New metric columns** include PercPool, GardSize, etc. |
| SA2-keyed wide tables | One row per SA2, for the original tool's *Demographics* loader (wide format, columns as measures) |
| `nz_suburb_builder_config.json` | `tool`, `version`, `inputs`, `outputs`, `settings`, `prvdrMatches`, `suburbAllocations` |
| Build zip | Optional: `nz-suburb-builder_YYYYMMDD-HHMMSS.zip` layout, so **Restore last build** works |

### 7b. Analysis formats
- `suburb_metadata_panel.csv` / `.parquet`: suburb × year (× season) panel ready for panel models (fixed or random effects), with a data dictionary.
- `section_metadata.parquet` (editor only, if property-level output is enabled): per-section values, **without** pool flags in public exports (privacy, section 10).
- GeoPackage: suburbs, SA2s and sections with metrics.
- `climate_daily.csv.gz` per suburb.
- Every bundle includes `README.md`, `DATA_DICTIONARY.csv`, `ATTRIBUTION.md` and `manifest.json` (as_of, source versions, app version, checksums).

## 8. External services and keys

| Service | Credential (Supabase secret) | Used by |
|---|---|---|
| LINZ Data Service | `LINZ_API_KEY` | Edge Function and worker |
| Stats NZ Datafinder | `STATSNZ_DATAFINDER_KEY` | Edge Function |
| Stats NZ ADE | `STATSNZ_ADE_KEY` (primary; secondary kept for rotation) | Edge Function |
| Open-Meteo | none (non-commercial free tier); `OPENMETEO_API_KEY` if commercial | Edge Function |
| LINZ imagery (S3 `nz-imagery`) | none | worker |
| Google OAuth | client ID and secret (Supabase Auth settings) | Auth |

Keys live only in Supabase secrets and the worker's environment. They are never in the repo, the browser, logs or exports. Locally, `~/.config/{linz,statsnz}/…` files with mode 600 are read via `keys.py`.

## 9. Quality and validation
- Pools: per-capture precision and estimated recall from labels. A capture must pass a threshold (e.g. precision ≥ 95%, recall ≥ 80%, on ≥ 150 labelled chips) before its pool metrics are published.
- Gardens: share of sections labelled "about right" (pilot: 90 of 90 by the user; 82 of 86 judged by Claude).
- Census: suppressed cells (`c`, `_U`) flagged; SA2 → suburb weights recorded.
- Climate: grid-cell ID stored; suburbs sharing a cell are flagged as such.
- Area check: polygon area vs survey area (pilot: 98–99.5% within 1%).

## 10. Privacy and ethics
- Public and viewer exports are aggregated to suburb or SA2, never per-property pool or garden flags. Property-level tables are editor-only and never public.
- No owner names: use LINZ *NZ Property Titles* (open), not the *Including Owners* layer.
- Validation chips are aerial imagery of private sections. They're kept in private Storage and served only to signed-in labellers.

## 11. Licensing and attribution
- **Code:** Apache-2.0 (`LICENSE`).
- **Data outputs:** CC BY 4.0 (`LICENSE-DATA`), with `ATTRIBUTION.md` in the repo and in every export:
  - Toitū Te Whenua LINZ (CC BY 4.0), with imagery credited per survey;
  - Stats NZ (CC BY 4.0);
  - Open-Meteo / Copernicus ERA5 (CC BY 4.0).
- Open-Meteo's free API tier is **non-commercial**. Commercial deployments need an Open-Meteo key.

## 12. Supabase project setup
**Current state (2026-11-23):** a Supabase account exists, but no project yet. These steps create it. Everything below is the target configuration; the starting schema is in `supabase/migrations/0001_init.sql`.

### 12.1 Create the project
1. In the Supabase dashboard, create a new project in the organisation. Name it `explore-nz-suburb-water`.
   - **Region:** Sydney (`ap-southeast-2`), the closest to NZ. LINZ imagery is also in `ap-southeast-2`, so the worker's reads stay in-region.
   - **Plan:** Free is enough for the two pilot regions. National data needs Pro (database size; see section 16).
   - Save the generated database password in a password manager. Don't commit it.
2. Install the Supabase CLI locally and link it:
   ```bash
   supabase login
   supabase link --project-ref <project-ref>
   supabase db push          # applies supabase/migrations/*.sql
   ```
3. Under **Database → Extensions**, enable `postgis`, `pg_cron` and `pg_net` (the migration also runs `create extension if not exists`).
4. Under **Storage**, create the buckets:

| Bucket | Public | Contents |
|---|---|---|
| `exports` | no (signed URLs) | export bundles |
| `chips` | no | validation image chips (labellers only) |
| `public-exports` | optional, yes | published national metadata, if section 16 Q3 is "public" |

5. **Secrets** (Project settings → Edge Functions → Secrets, or `supabase secrets set`): `LINZ_API_KEY`, `STATSNZ_ADE_KEY`, `STATSNZ_DATAFINDER_KEY`, and `OPENMETEO_API_KEY` (only for commercial use).
6. **Keys used by clients:**
   - The browser uses only the project URL and the **anon** (publishable) key. These are safe to ship, because RLS enforces access.
   - The **service-role** key goes only to the worker and Edge Functions. Never commit it or ship it to the browser.
   - See `.env.example`.

### 12.2 Schema, roles and RLS
- `profiles(id uuid primary key references auth.users, email, display_name, role app_role default 'viewer', status text default 'pending', created_at)`.
  - A trigger on `auth.users` inserts the profile at first sign-in.
  - `app_role` is an enum: `viewer`, `labeller`, `editor`, `admin`.
- A helper `has_role(min app_role)` (`security definer`, `stable`) returns true when the caller's profile is `active` and their role ranks at least `min`. Every policy uses it.
- Policy pattern:

| Table group | select | insert / update / delete |
|---|---|---|
| Reference data (suburbs, sections, titles, buildings, sa2, census, climate, water rates) | `has_role('viewer')`, and the region is `published` or the caller is an editor | `has_role('editor')`; worker via service role |
| `section_imagery`, `pool_candidates` (property-level) | `has_role('editor')` only | worker via service role |
| `validation_items` | `has_role('labeller')` | `has_role('editor')` |
| `validation_labels` | own rows for labellers; all rows for editors | own rows only (`user_id = auth.uid()`) |
| `jobs` | `has_role('editor')` | `has_role('editor')` |
| `profiles` | own row; all rows for admin | admin only (role and status changes) |
| `audit_log` | admin | triggers only |

- Views such as `v_suburb_metadata` are created `with (security_invoker = true)`, so the underlying policies apply.
- **Storage policies:**
  - `chips`: read for `has_role('labeller')`.
  - `exports`: read for the owner or editors. Writes only via service role.

### 12.3 Edge Functions
| Function | Role required | Does |
|---|---|---|
| `fetch-linz` | editor | WFS by region bbox (suburbs, parcels, titles, buildings); upserts with `source_version` |
| `fetch-census` | editor | ADE dataflows for the region's SA2s; writes `census_values`, refreshes `census_metrics` |
| `fetch-sa2` | editor | Datafinder SA2 2023 (layer 111206) |
| `fetch-climate` | cron / editor | Open-Meteo archive per grid cell; appends `climate_daily` |
| `queue-job` | editor | inserts a `jobs` row for the worker (imagery and bulk loads) |
| `build-export` | viewer | builds the export bundle (section 7) into `exports` and returns a signed URL |

Each function checks the caller's JWT and role first (`has_role` via RPC), then uses the service-role client.

### 12.4 Scheduling (`pg_cron` + `pg_net`)
- Daily 03:00 NZT: `fetch-climate` (append yesterday).
- Weekly: LINZ changesets for each published region; STAC poll for new `nz-imagery` captures.
- Quarterly: CPI.

## 13. Google sign-in (Supabase Auth)
**Current state:** a Google Cloud account exists, but no OAuth client yet.

1. **Google Cloud console:**
   - Create a project `explore-nz-suburb-water`.
   - Under **APIs & Services → OAuth consent screen**, choose user type **External**. Fill in app name, support email, the app domain (GitHub Pages or a custom domain) and the privacy-policy link.
   - Scopes: `openid`, `email`, `profile` only.
   - Publish the app. While it is in "testing", only listed test users can sign in.
2. **Credentials → Create OAuth client ID:** type **Web application**.
   - Authorised JavaScript origins: the app URL(s), e.g. `https://water-rha-nz.github.io` and `http://localhost:5173`.
   - Authorised redirect URI: **`https://<project-ref>.supabase.co/auth/v1/callback`**.
3. **Supabase dashboard → Authentication → Providers → Google:** enable it and paste the client ID and secret.
4. **Supabase → Authentication → URL configuration:**
   - Site URL: the production app URL.
   - Additional redirect URLs: preview and local URLs.
5. **Client code:**
   ```js
   await supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo: location.origin + location.pathname } });
   ```
   The session JWT is then sent with every query, and RLS uses `auth.uid()`.
6. **Approval flow:**
   - New users arrive as `viewer` with `status = 'pending'`. An admin sets `status = 'active'` (and the role) on the Users page.
   - Optional: auto-activate allowlisted email domains (`app_settings.auto_approve_domains`).
7. Sign-out clears the session. Admins can revoke a user by setting `status = 'disabled'`, which makes `has_role` false immediately.

## 14. Repository layout and the static demo
```
LICENSE                 Apache-2.0 (code)
LICENSE-DATA            CC BY 4.0 legal code (data, exports, labels)
ATTRIBUTION.md          source credits (also shipped in every export)
docs/SPEC.md            this document
supabase/migrations/    SQL migrations (schema, RLS, functions)
demo/                   static demo (GitHub Pages): index.html + data/*.json
.env.example            client and worker configuration names (no values)
```
**Static demo (`demo/`):** a single HTML page that exemplifies this spec without the stack.
- It has all eight stages, with sign-in and roles simulated, and runs on the Taupō and Tauranga pilot data.
- Exports use the original tool's formats, plus the panel, data dictionary, attribution and manifest, all generated in the browser.
- It contains aggregates only (section 10): suburb outlines and statistics, SA2 census values, climate per grid cell, and validation summaries. No property-level pool or garden values and no image chips.
- The one exception is the public LINZ section sizes used by the `nz_household_ref.csv` export.
- The demo data is regenerated from pilot outputs by `build_demo_data.py`, which is in the pilot workspace and will be moved to `tools/` in M2.

## 15. Milestones
1. **M1 Foundation:** Supabase project, PostGIS schema, Google Auth, roles and RLS, jobs table, CI.
2. **M2 Port reference builder:** Load / Allocate / Explore / Export against the database; compatible exports (7a) byte-compatible with the HTML tool, with golden-file tests against `nz_suburb_lookup/data`.
3. **M3 Connectors:** Edge Functions for ADE, Datafinder, LINZ WFS, Open-Meteo; census metrics; climate daily.
4. **M4 Worker:** imagery pipeline (pools, vegetation) as a containerised job; per-capture calibration.
5. **M5 Validation:** labeller in the app, multi-user; calibration from labels; quality gates.
6. **M6 Panel and exports:** `v_suburb_metadata`, panel export, data dictionary, manifests.
7. **M7 Living refresh:** pg_cron schedules, changesets, STAC polling, audit.

Pilot data (Taupō and Tauranga: regions, outputs, 552 user labels, 552 Claude labels) is migrated in M1–M5 as seed and test data.

## 16. Open questions
1. Hosting for the worker (GitHub Actions minutes vs a small VM vs your machine).
2. Should viewers need approval, or is any Google account a viewer?
3. Publish national metadata openly (e.g. a public read-only export bucket) or keep it behind sign-in?
4. Low-rise vs high-rise split: add LINZ LiDAR heights (M8)?
5. Supabase plan size: national sections (~2M) plus climate daily (cells × days) fit in Pro; the free tier will not hold national data.
