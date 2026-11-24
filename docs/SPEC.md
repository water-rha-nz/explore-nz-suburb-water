# explore-nz-suburb-water: application specification

Version 0.2 (draft), 2026-11-23

**Status:** specification, static demo and setup prerequisites. Supabase and Google Cloud accounts exist. The Supabase project `explore-nz-suburb-water-syd` (Sydney, free) exists with migrations 0001–0004 applied and secrets set. Google sign-in is live and the first admin is set up (`docs/SETUP.md`). The live app is on Pages (signed-in users only). Data is seeded from the Taupō and Tauranga pilot. The worker runs climate, census and metric steps; imagery and LINZ re-loads still run from the pilot pipeline. The demo is in `demo/`, built from the Taupō and Tauranga pilot.

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
  └─ heavy jobs, one region at a time: imagery tiles → pools / vegetation; LINZ layers (no national runs, section 20)
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
| `providers` | PRVDR | name, aliases, TAs served, legacy code | reference builder; codes are **uppercase letters and digits only** (`index/providers.csv`) |
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
   - **Validation pack** (labeller role): exports the imagery tiles flagged for visual validation and the matching outcome format, so validation can also be done outside the app, e.g. in QGIS or by a contractor. See section 19.
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
   - **Plan:** Free is enough for the pilot regions. As regions accumulate one at a time, Pro may be needed for database size (section 16).
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
| `public-exports` | optional, yes | published region metadata, if section 16 Q3 is "public" |

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
> **Revised (section 17):** data connectors run in the Python worker, so the codebase stays single and matches the pilot. Edge Functions stay thin: auth checks, `queue-job`, signed export URLs, and starting worker runs. The `fetch-*` functions below remain an option for light refreshes if a TypeScript port is wanted later.
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
   - Under **APIs & Services → OAuth consent screen**, choose user type **External**. Fill in app name, support email, the app domain (GitHub Pages or a custom domain) and the privacy-policy link. The authorised domains are `water-rha-nz.github.io` and `<project-ref>.supabase.co`, not `supabase.co`: both `github.io` and `supabase.co` are public suffixes.
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
index/                  per-region source index: API request templates for 67 TAs (section 18)
tools/                  build_source_index.py (and, from M2, build_demo_data.py)
backend/                Python worker: Dockerfile, requirements, package layout (section 17)
docs/examples/          example GitHub Actions workflow for the worker
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
3. **M3 Connectors:** Python worker connectors driven by `index/source_index.json` (LINZ WFS, Datafinder, ADE, Open-Meteo, imagery STAC); census metrics; climate daily.
4. **M4 Worker:** imagery pipeline (pools, vegetation) as a containerised job; per-capture calibration.
5. **M5 Validation:** labeller in the app, multi-user; calibration from labels; quality gates.
6. **M6 Panel and exports:** `v_suburb_metadata`, panel export, data dictionary, manifests.
7. **M7 Living refresh:** pg_cron schedules, changesets, STAC polling, audit.

Pilot data (Taupō and Tauranga: regions, outputs, 552 user labels, 552 Claude labels) is migrated in M1–M5 as seed and test data.

## 16. Open questions
1. Hosting for the worker. **Decision:** GitHub Actions; there are no national runs (section 20).
2. Should viewers need approval, or is any Google account a viewer?
3. Publish completed regions' metadata openly (e.g. a public read-only export bucket) or keep it behind sign-in?
4. Low-rise vs high-rise split: add LINZ LiDAR heights (M8)?
5. Supabase plan size: the free tier holds a handful of regions; move to Pro as more regions are prepared.

## 17. Back-end: running the Python worker
### 17.1 Why Python, and what runs where
The pilot pipeline is Python: GDAL/rasterio, OpenCV, geopandas, pandas and requests. Supabase Edge Functions run Deno (TypeScript) and can't host these libraries. They also have short time limits. So:

| Component | Runtime | Responsibilities |
|---|---|---|
| Browser app | static JS | UI; reads data through supabase-js under RLS |
| Edge Functions | Deno | thin: check the caller's role, insert `jobs`, start a worker run, sign export URLs |
| **Worker** | **Python 3.12 container** | everything heavy or keyed: connectors (via the source index), imagery (pools, vegetation), census metrics, climate, aggregation, export bundles, validation packs |
| Postgres (Supabase) | SQL | storage, RLS, `claim_job()`, materialised aggregates |

### 17.2 Package layout (`backend/`)
```
backend/
  Dockerfile              python:3.12-slim + wheels (rasterio, geopandas and pyogrio ship their own GDAL)
  requirements.txt
  nzsw/
    cli.py                nzsw run --ta "Taupo District" --steps linz,census,climate,imagery,aggregate
                          nzsw worker   (claim and run queued jobs until none remain)
    index.py              loads index/source_index.json, resolves {placeholders}, runs steps in dependency order
    keys.py               secrets from env (GitHub/Cloud secrets) or ~/.config files; redact() for logs
    connectors/           linz.py, statsnz.py, openmeteo.py, imagery_stac.py   (pilot: suburb_pilot/connectors)
    imagery/              detect.py (windowed COG reads, pools + vegetation), calibrate.py (labels -> thresholds/model)
    metrics/              census.py (SA2 -> suburb), aggregate.py (section -> suburb), panel.py
    exports/              writers shared with the demo formats (section 7), validation pack (section 19)
    db.py                 psycopg via the Supabase connection pooler; COPY for bulk upserts; PostGIS from WKB
```

### 17.3 Job flow
1. An editor presses **Queue** in the app. The `queue-job` Edge Function checks `has_role('editor')` and inserts `jobs(type, region_id, params)`.
2. The function **starts a worker run** with a GitHub `repository_dispatch` or `workflow_dispatch` event. An always-on worker would poll instead.
3. The worker claims work atomically:
   ```sql
   create function claim_job() returns jobs language sql as $$
     update jobs set status = 'running' where id = (
       select id from jobs where status = 'queued' order by created_at for update skip locked limit 1)
     returning *; $$;
   ```
4. It runs the steps for the region from the source index (section 18). Every write is an **idempotent upsert** keyed on natural keys plus `source_version`, so a failed run can simply be re-run. Per-tile imagery results are kept, so reruns skip finished tiles.
5. It writes `job_runs` (log, counts, durations) and sets `jobs.status` to `done` or `failed`. The app shows progress through Supabase Realtime on `jobs`.
6. Database access uses a dedicated Postgres role `worker`, granted insert/update on the data tables and nothing on `profiles` or `audit_log`. That avoids handing the full service-role key to the worker. Storage uploads (chips, exports) use a Storage key scoped to those buckets.

### 17.4 Where to run it
The **same Docker image** runs on all of these:

| Option | Fit | Limits / cost | Use for |
|---|---|---|---|
| **GitHub Actions** (`workflow_dispatch`, `repository_dispatch`, `schedule`) | No infrastructure; the repo is public, so standard runners are free | 6 h per job; about 4 vCPU / 16 GB on public-repo runners; secrets in repo or environment secrets | **M1–M5**: per-TA runs (Taupō imagery about 10 min, Tauranga about 2 min on 4 CPUs); daily climate cron |
| ~~Google Cloud Run Jobs~~ | **Not used.** Scaling out would only help national runs, which are ruled out (section 20). | — | — |
| Small always-on VM (Fly.io, Railway, a Lightsail-type host) | Simplest polling worker | monthly fee even when idle | If runs become frequent |
| Your own machine | Zero cost; same CLI and the same limits | manual | Debugging; single-region runs |

**Decision:** GitHub Actions, using `docs/examples/worker.yml`. A run is one region (or one part of a large TA) and fits well within the 6 h job limit. The queue stays in Postgres, so the trigger can change without touching the app. `concurrency: worker` keeps one run at a time, so two runs never share a free key's budget at once.

Note: pushing files under `.github/workflows/` needs a token with the `workflow` scope (`gh auth refresh -s workflow`). The example is kept in `docs/examples/` until then.

### 17.4a Image build, registry and spin-up
**Today nothing is hosted.** No image has been built, no workflow is active, and there is no Supabase project yet. The target lifecycle is:

1. **Build once per change.** A `build-worker` GitHub Actions workflow runs on push to `main` when `backend/**` or `index/**` change. It builds `backend/Dockerfile` and pushes the image to **GitHub Container Registry** as `ghcr.io/water-rha-nz/explore-nz-suburb-water-worker:<git-sha>` and `:latest`.
   - GHCR is free for public images and needs no extra account.
   - The image is about 600 MB: Python plus GDAL wheels, plus the source index.
2. **Trigger.** An editor presses *Queue* in the app.
   - The `queue-job` Edge Function inserts a `jobs` row.
   - It then calls the GitHub REST API (`POST /repos/water-rha-nz/explore-nz-suburb-water/dispatches`, event `job-queued`), using a fine-grained token stored as a Supabase secret and limited to that repo's Actions.
   - Cron schedules and manual "Run workflow" clicks also start runs.
3. **Spin-up (GitHub Actions).**
   - GitHub allocates a fresh **GitHub-hosted Ubuntu VM** (about 4 vCPU / 16 GB for public repos) in its own cloud. Neither you nor Supabase hosts it.
   - The workflow runs `docker pull ghcr.io/…-worker:<sha>` (about 30–60 s), then `docker run` with the secrets passed as environment variables.
   - Inside the container, `nzsw worker` calls `claim_job()`, runs the steps, writes results to Supabase, and claims the next job until the queue is empty.
   - The container exits and the VM is destroyed. Nothing stays running and there is no idle cost.
4. **No fan-out.** One container processes one claimed job: one region, or one part of a large TA. It processes tiles at most 4 at a time, and every external call goes through the limits client (section 20). There is no multi-container or national execution path.
5. **Data paths** during a run:
   - imagery is read straight from public S3 by COG window, with no download to disk;
   - LINZ, Stats NZ and Open-Meteo are reached over HTTPS;
   - results go to Supabase Postgres through the connection pooler, and to Supabase Storage for chips and exports.

Pushing the two workflow files (`build-worker`, `worker`) needs a token with the `workflow` scope.

### 17.5 Scheduled work
| Task | Trigger |
|---|---|
| Climate append (yesterday) | GitHub Actions `schedule` daily, or pg_cron → Edge Function → dispatch |
| LINZ changesets, STAC poll for new captures | weekly schedule; new captures create a `jobs` row for an editor to approve |
| Census refresh | manual, per census release |

### 17.6 Local development
`supabase start` runs the local stack (Postgres + Auth + Storage), then `docker build backend && docker run --env-file .env nzsw run --ta "Taupo District"`. Integration tests use the pilot regions as fixtures. Golden-file tests check that exports are byte-compatible with `suburb_lookup.html`.

## 18. Source index (per-region API requests)
`index/source_index.json`, generated by `tools/build_source_index.py`, holds every API request needed to prepare each of the **67 TAs served by the 64 providers** in the reference builder's water-rates table. That's 1,002 request templates, and **generating the index calls no data API**. Each entry has:
- the TA and its Stats NZ TA code, regional council and imagery folders;
- PRVDR and charging type;
- the TA's SA2 codes;
- `requests[]` (service, URL, params/headers, auth, `depends_on`, paging, expected output).

PRVDR codes are uppercase letters and digits only. The reference builder's 31 underscore codes are rewritten: council codes put the place abbreviation before the council type (`WDC_WHG` → `WHGDC`, `NCC_NPR` → `NPRCC`), and multi-district organisations keep their prefix (`IAWAI_HAM` → `IAWAIHAM`, `WWL_WAIPA` → `WWLWAIPA`). The old codes are kept as aliases (`index/providers.csv`), so files made with the reference builder still match.

The run order is: LINZ suburbs (filter by TA name; yields the bbox and suburb points) → parcels / titles / buildings / addresses (bbox, paged) → Datafinder SA2 and ADE census (chunks of 150 SA2s) → imagery collection list → STAC items → imagery job → Open-Meteo (at most 100 points per call) → provider pages for rate review. Keys are placeholders resolved from secrets at run time. See `index/README.md` for caveats.

## 19. Validation pack and outcome format
Labellers can export the tiles flagged for visual validation and get results back in a fixed format. The same item IDs are used in the app, the public demo and the local pilot app.

| File | Contents |
|---|---|
| `validation_tiles.csv` | `TILE_ID, REGION, CAPTURE_ID, COG_URL, STAC_URL, MINX, MINY, MAXX, MAXY` (NZTM), `ITEMS, POOL_ACCEPTED, POOL_REJECTED, GARDEN, LABELLED, FLAGS, PRIORITY` |
| `validation_items.csv` | `ITEM_ID, TILE_ID, REGION, TASK, GROUP, TOOL_VERDICT`, plus `X_NZTM, Y_NZTM, PARCEL_ID, CHIP_URL` **only for signed-in labellers** (omitted in public outputs) |
| `validation_outcome_template.csv` | `ITEM_ID, TILE_ID, TASK, LABEL, LABELLER, LABELLED_AT, NOTES`, with labels blank |
| `validation_outcome.schema.json` | JSON Schema 2020-12 for one outcome row; `LABEL` must suit `TASK` |

- **Flags:**
  - `calibration sample` (every tile with items);
  - `high miss rate` (at least 3 real pools among rejected candidates, and at least half of them);
  - `false positives`;
  - `unlabelled items`.
- **Priority:** 1 when a tile has any flag beyond the calibration sample.
- **Item ID:** `v` + the first 10 hex characters of SHA-1 of the internal item key, so IDs are stable and opaque.
- **Labels:**
  - pools: `pool`, `not_pool`, `water`, `unknown`;
  - gardens: `over`, `about_right`, `under`, `unknown`.
- `LABELLED_AT` is ISO 8601 with a time zone. `unknown` is discarded from the scores.
- **Import:** an uploaded outcome file is checked against the schema and item list (task match, allowed labels, labeller, timestamp). It's applied to `validation_labels` only if every labelled row is valid. Imported rows record `source = 'outcome-import'` and the labeller.
- Pilot check: the local app's pack and the demo's pack share all 552 item IDs. The pilot outcome file round-trips with 0 errors, and a corrupted row is rejected.

## 20. Usage limits and throttling (free keys only)
The app must work on the **free** keys and tiers of every service it depends on, and must never pull data at national scale. These limits are enforced in code by `backend/nzsw/limits.py`, which is tested in `backend/tests/test_limits.py`. They're also recorded in `index/source_index.json → meta.limits`.

### 20.1 One region per run, no national runs
- A run covers **one TA**. A TA larger than the per-run caps (**80 SA2s**, 60 suburbs, about 400,000 LINZ features, 12 climate cells, 250 imagery tiles) runs as **parts**: contiguous groups of SA2s, which Stats NZ codes in spatial order. The source index lists the parts.
  - 64 of 67 TAs run in one part.
  - Wellington City needs 2, Christchurch 3 and Auckland 8, which are queued separately and run on different days if budgets require.
- Multi-region and national requests are rejected before any call is made (`preflight` → `RunTooLarge` / problems). The app offers no "run all" action, and the worker has no national code path.
- Only one worker runs at a time (`concurrency: worker`), so the budgets apply to the whole project.

### 20.2 Budgets per service (per UTC day, set below the free limits)
| Service | Published free limit | App budget | Pacing | Cost model |
|---|---|---|---|---|
| Open-Meteo (no key) | 600/min, 5,000/h, **10,000/day**; non-commercial | **6,000/day, 3,000/h** | 1 request/s | weighted: locations × max(1, variables/10) × max(1, days/14) |
| LINZ LDS WFS | none published; 3,000 features/request default; ≤ 250,000/request advised | 1,500 requests/day; ≤ 400,000 features/run | 1 request/s, pages of 10,000 | 1 per page |
| Stats NZ Datafinder | none published (same platform as LINZ) | 300/day | 1 request/s | 1 per request (≤ 150 SA2s) |
| Stats NZ ADE | none published; fair use, shared keys may be throttled | 400/day | 1 request / 2 s | 1 per request (≤ 150 SA2s) |
| LINZ imagery (public S3) | no key | ≤ 250 tiles/run; ≤ 25 GB read/day | ≤ 4 parallel reads | bytes read (overview level only) |

**Climate cost control.** Open-Meteo counts long histories as many calls: 19 years for one location is about 491 calls. So:
- suburbs are grouped into grid cells (0.1°) before any call, and each cell is fetched once;
- the backfill starts in **2013**, the first census year used, which is about 361 calls per cell;
- cached cells only fetch the missing tail, so a daily top-up is 1 call per cell.

For scale, a typical single-part TA costs about 1,000–4,300 weighted calls. That's one region per day within the 6,000 budget, leaving room for top-ups. (The pilot's first pulls, one location per suburb from 2008 and repeated, used about 13,300 weighted calls in one day, more than the free cap. The per-cell design prevents this.)

### 20.3 Before a run: preflight
The worker estimates each run's cost per service, from the region's SA2s, suburbs, climate cells and features, and compares it with what's left of today's budget. If it doesn't fit, the job is **not started**: it is set to `scheduled`, with a reason, and the scheduler retries it the next UTC day. The app shows the estimate next to the *Queue* button, and the source index carries a heuristic estimate per part.

### 20.4 During a run: pacing and throttling
- **Pacing:** one request at a time per service, with the minimum interval above.
- **Ledger:** every attempt is counted, including retries, per service and per day/hour. In production this is the `api_usage` table; locally it's `~/.cache/nzsw/api_usage.json`.
- **429 / 503 / 502 / 504:**
  - honour `Retry-After` (seconds or HTTP date);
  - otherwise exponential backoff with jitter (5 s × 2ⁿ, capped at 10 min), up to 5 retries;
  - a 504 from LINZ also logs advice to reduce the page size;
  - S3's `503 SlowDown` counts as throttling.
- **Circuit breaker:** 3 throttled responses within 15 minutes pause that service for 6 hours. The job is parked as `paused_quota` and resumes from where it stopped, because all steps are idempotent upserts and cached tiles and cells are skipped.
- **Budget edges:**
  - a request that would exceed the **hourly** budget waits for the next hour;
  - one that would exceed the **daily** budget stops the run (`paused_quota`), to resume tomorrow;
  - a single request larger than the hourly budget is refused, and must be split.

### 20.5 Caching (don't re-request what we have)
| Data | Refresh |
|---|---|
| Census | once per census release (dataflow version recorded) |
| SA2 boundaries | once per boundary release |
| LINZ layers | weekly changesets for published regions, not full re-downloads |
| Imagery | per capture; processed tiles are never re-read |
| Climate | cells cached; only new days fetched |
| ADE dataflow structures and the geography code list | cached locally |

### 20.6 Adjusting download rates (download progress panel)
While a region downloads, the **Download progress** panel shows each service's calls made against the run's estimate, the time remaining at the current rate, and a rate control.
- **Editors** can raise or lower each service's rate (requests per minute), and its daily or hourly budget, while the run continues. A change applies to the next request.
  - In production the value is written to `app_settings.rates`; locally to `~/.config/nzsw/rates.json`.
  - The worker re-reads it before every request (`limits.effective()`).
- **Ceilings cannot be exceeded.** Values above them are clamped (`limits.set_rate()` → `clamped_to_ceiling`).
- **Automatic step-down:** if a raised rate is throttled (429 / SlowDown), it is halved, but never below the default. The change is logged with `reason = "auto: throttled"`, and the normal Retry-After / backoff / circuit-breaker rules still apply.

| Service | Default | Ceiling | Basis for ceiling |
|---|---|---|---|
| Open-Meteo | 60/min · 6,000/day · 3,000/h | 600/min · 9,500/day · 4,750/h | published free limits (600/min, 10,000/day, 5,000/h), minus a margin |
| LINZ WFS | 60/min · 1,500/day | 240/min · 5,000/day | none published: conservative fair use |
| Stats NZ Datafinder | 60/min · 300/day | 240/min · 1,000/day | none published (same platform as LINZ) |
| Stats NZ ADE | 30/min · 400/day | 120/min · 1,500/day | none published; shared keys get throttled |
| LINZ imagery S3 | 4 parallel · 25 GB/day | 8 parallel · 60 GB/day | public bucket; be a good citizen |

Raising rates never lifts the per-run region caps (section 20.1). A faster download is still one region.

## 21. Access model as deployed (2026-11-23)
- **Pages** serves the app, a landing page for signed-out visitors, and a reference file with NZ outlines, limits and the source index (no suburb results). The static demo isn't published.
- **Database:**
  - every public table has RLS (migration 0007 fails if one doesn't);
  - the `anon` role has no privileges on tables, views, sequences or functions, and default privileges for new objects are revoked too;
  - viewers see published regions only;
  - property-level imagery tables are editor-only;
  - chips are served to labellers by signed URL;
  - the worker uses its own role with explicit policies and no RLS bypass.


## 22. Batch preparation (Batch stage)
- **Select** territorial authorities by clicking them on the map (TA 2023 outlines, from Stats NZ Datafinder layer 111193, in `territorial_authorities`), or by ticking them in the table of 67 TAs with water charging rates. Both stay in sync.
- **Scope** each TA with the user's lists, using the rules of `suburb_lookup.html`. The files are read in the browser:
  - `nz_suburb_map.csv` (`M_SUBURB, PROVIDER, NZ_SUBURB_REF, M_TERRITORY`) keeps the LINZ suburb named in `NZ_SUBURB_REF`.
  - `nz_suburb_ref.csv` (`M_SUBURB, …, M_TERRITORY`) keeps `M_SUBURB`.
  - With both lists for a TA, keep a suburb when it is in **either** or in **both**.
  - `nz_suburb_provider.csv` (`M_SUBURB, Other spellings, PRVDR`) assigns PRVDRs and other spellings (separated by `;` `,` `|` `/`). It scopes a TA only when neither keep-list covers it.
  - Names match with or without macrons. `M_TERRITORY` (or the PRVDR's territories) places a row in its TA. Uploading a file also selects the TAs it names.
- **Queue:**
  - one `batches` row;
  - for each TA, a region (`ta-<code>`, or the existing region for that TA) with its `scope` and the user's `m_suburbs` rows;
  - one `prepare` job: `linz → imagery_index → imagery → census → publish_new → climate`.
  - Jobs run one at a time within budgets (section 20). Large TAs (more than one run part) need a suburb list.
- **Worker steps:**
  - LINZ: suburbs filtered by TA and scope, residential parcels with a building of at least 40 m², buildings, SA2s, climate cells;
  - imagery index: the newest RGB+NIR capture at 0.125 m or finer covering the region's buildings;
  - imagery: windowed reads; pools and vegetation per section; resumable;
  - publish metrics.

  Finished steps are skipped when a job resumes. Imagery hands long runs back to the queue before the runner's time limit.
- **Progress and output:**
  - per-region job status, and **Publish** (editors) once a region is done;
  - **Download tile list (CSV)**: the COG and STAC URLs of the tiles indexed for the batch;
  - the Export stage covers published regions.
- Verified on Kawerau District: 1 suburb, 2,777 sections, 7 tiles of the 2025 0.1 m capture, 20 pools. Climate was parked by the budget and resumed later.

## 23. Per-user API keys (Account stage)
- Each user can set their own LINZ, Stats NZ ADE, Stats NZ Datafinder and (optional, commercial) Open-Meteo keys. Keys are encrypted in **Supabase Vault** through `set_my_api_key` / `delete_my_api_key`. Users see only the last 4 characters (`user_api_keys`) and can't read keys back.
- The worker decrypts a key only through `job_api_key(job, service)` (worker role only), for the user who created the job. Without a user key it uses the project keys (GitHub secrets). The admin's keys are stored the same way.
- Budgets are counted per key owner (`api_usage.key_owner`), since each free-tier key has its own limits.

## 24. Shared data and reuse across accounts
Everything a job downloads goes into shared tables, whichever user's or the project's keys were used, so every approved user sees published regions. The worker checks what is already stored before requesting anything:

| Step | Reused when | Request still made |
|---|---|---|
| `linz` | sections already exist for a scoped suburb | one suburbs lookup to resolve the scope; parcels and buildings only for suburbs not yet stored |
| SA2 | sections already fall in stored SA2 boundaries | a Datafinder request only if some sections are unassigned |
| `census` | `census_metrics` already holds the SA2 | ADE only for missing SA2s; suburb apportioning is recomputed in SQL |
| `imagery_index` | every section is covered by indexed tiles | none |
| `imagery` | tiles already processed (`processed_at`) | none |
| `climate` | cells are shared between regions; days already stored | only new days |

A batch for a TA that already has a region reuses that region; the pilot regions carry their TA codes (021, 023). Verified: re-preparing Kawerau made one LINZ request (the suburbs lookup) and nothing else.

**1 Overview** is a read-only overview of the data already in the database, built from what the app loads at sign-in, with no extra queries and no jobs:
- totals: regions, LINZ suburbs (with housing), residential sections, SA2s, pools detected, providers;
- a map of regions with data;
- the selected region's details;
- a table of all regions: TA, PRVDR, suburbs, sections, SA2s, imagery capture, pools, gardens, census years, climate coverage, status.

Refreshing a region's data, job progress and download rates are on **3 Load**.

**Lazy loading.** Sign-in loads only an index of the regions (one row each: name, TA, PRVDR, status, timeline), not their suburbs, census or climate. **1 Overview** is a light landing page: a map of TA outlines (one cached request) with each region in the database outlined together with its suburbs (simplified outlines only, no data; one small request per region), where clicking a region loads it (loaded regions are filled), and the list of regions (filtered by the header's study), each with a *Load* button, plus *load this study's / all regions* and *load last session's regions*. A region's detail loads on demand when you load it there, add it on the data map, or open a per-region stage (Imagery, Validate, Context, Explore, Export), with a loading view meanwhile. The **detailed overview** (data map, symbols, comparisons, regions table, sources) appears on **3 Load** and **Explore**, for the loaded regions, with an *add regions* control. Refresh jobs and region timelines work from the index, without loading the region.

**Loading.** From the first moment after a refresh, a loading view shows each step (sign-in, profile, then each region as it loads) instead of an empty page.

**1 Overview: data map.** Stage 1 is named *Overview*. The header's study filters it to that study's TAs that have prepared data; when there are none, it says so and outlines the study's TAs. The map is a zoomable, pannable view of the data, kept light: all layers come from data loaded at sign-in plus one cached request for TA outlines.
- **Pan and zoom:** a drag moves only the viewBox, and layers are redrawn once it ends. Drag distance matches the cursor; the wheel zooms in proportion to the scroll, about the cursor; releasing anywhere ends a drag.
- **Suburb statistics, several axes at once:**
  - *layout:* geographic, or an equal-area tile grid (one square per suburb, in the free cell nearest its real centre);
  - *glyph:* **colour** (a continuous scale of one statistic), **radar** in the suburb's own shape (one wedge per statistic, up to 6, reaching toward the suburb's edge in proportion to the value), or **section make-up** (a square per suburb sized by its median section, divided into building, garden, pool and other);
  - *size axis:* a non-contiguous cartogram (area ∝ sections, titles or pools), or tile size in the tile layout;
  - census values come from the chosen census year.
- **Scales and legend:** continuous colour scales with a clearly coloured lightest step (not mistaken for "no data"). *Stretch* sets how values map to colour: **Rank** (default) places each suburb by its position among those shown, which spreads suburbs evenly even when one region stands apart; **Value** uses true values (logarithmic when right-skewed: all positive and skewness > 1). Diverging statistics are always centred on zero. Each spectrum shows its name above it and no printed values. Hover text (value under the cursor and span) sits on a fixed-height line beneath the spectrum, so nothing moves. Scrolling over a spectrum narrows or widens the range about the cursor, and a double-click resets it. Radar wedges use the same scales.
- **Radar wedges** show the spatial statistics only: owner-occupied %, separate houses %, bedrooms per dwelling, titles per km² and median section.
- **Summary symbols** (drawn large: a 26 px radar plus side icons): one symbol per group of suburbs; symbols that would overlap on screen merge into one. It has a compact radar of the spatial statistics; a pool dot (∝ pools) and a green-space dot (∝ green area) on its left; and climate on its right: a water drop filled by rainfall, a thermometer filled by mean temperature, and rising vapour (more and darker wisps for more ET₀). Each part can be switched off. Section-weighted means and totals are used for groups, and a symbol expands on hover. How much is merged depends on the zoom:
  - *zoomed out:* nearby suburbs (centres within ~60 px) merge into one symbol, never more than one per suburb;
  - *suburbs large on screen* (median > 260 px across): one symbol per suburb, with pools and green space as grid dots from `map_presence` (cells ≥ 100 m, ≥ 5 sections);
  - *full zoom* (under ~2.5 km): single pools at true size, each section's garden, and validation chips, from `map_items` (editors).
- **Summary of a clicked suburb or symbol** (below the map): four radars on the same axes (spatial statistics, garden, pools), each axis being its position among all suburbs in the database. The four are the suburb, its provider, its island (North/South, from the TA code) and all suburbs in the database, each group with the suburb's outline overlaid. A table follows, with every statistic for the suburb and a box-and-whisker bar per group (whiskers = range, box = middle half, line = median, ◆ = the suburb) and its rank. A merged symbol lists its other suburbs to switch to. "In database" means suburbs prepared so far, not all of New Zealand.
- **Explanations:** each statistic's note also says *why it matters* for residential water demand (e.g. title density shows how intensively land is subdivided: smaller lots and less garden per dwelling, more connections per km of pipe). Each spectrum, each *Scale suburbs by* option (a radio list: real area, or area ∝ sections, titles or pools) and the *Stretch* setting has an ⓘ superscript. Clicking it opens a short plain-language definition beneath (what the statistic is, how it is built from its sources, how the scaling works); clicking again closes it.
- **Suburb details** (click) appear below the map; **sources** are superscript references to the numbered list at the bottom of the page.

**Header.** The header shows the **study**: the saved configuration in use, selectable. Choosing one loads it and limits the region picker to its TAs. The region picker appears only on stages that work on one region (Imagery onwards).

## 25. Batch preparation: 2 Configure (2.1 Inputs and TAs → 2.2 Allocate → 2.3 Validate suburbs) → 3 Load
These two stages replace the reference builder's Load and Allocate stages. The stage bar runs 1 Region, 2 Configure, 3 Load, then Imagery, Validate, Context, Explore and Export; Configure has three sub-steps.
1. **2.1 Inputs and TAs:**
   - select TAs on a zoomable map (scroll to zoom, drag to pan, +/−, zoom to selection, reset) or in the 67-TA table;
   - the input files have distinct roles, and the tool builds on them:
     - `nz_suburb_provider.csv` (M_SUBURB, Other spellings, PRVDR) is the **study scope**: the study suburbs of interest and their provider;
     - `nz_suburb_map.csv` (M_SUBURB, PROVIDER, NZ_SUBURB_REF, M_TERRITORY) holds the **allocations** of study suburbs to LINZ suburbs;
     - `nz_suburb_ref.csv` (M_SUBURB, TYPE, M_TERRITORY, …) is the **LINZ suburb reference**;
     - without a provider file, map and ref act as keep-lists (either / both), as in the builder;
   - uploaded files apply **only to the selected TAs**: files never change the selection, but TAs they mention can be added with **Select them**;
   - **saving:** every Configure sub-step has a bar to name, save and export the configuration. A loaded configuration saves itself about a second after any change (PRVDRs, mappings, picks, timelines). Choosing a PRVDR for a TA also matches that TA's own file acronyms or unmatched codes (not saved PRVDR codes, and only codes no other TA uses) to it, so it reaches 2.2, the refined files and the builder config's `prvdrMatches`;
   - each selected TA's **PRVDR** is filled from the reference CSVs, resolved as the builder does: `nz_suburb_provider.csv` PRVDR, then `nz_suburb_map.csv` PROVIDER (the most common code among the TA's rows, through your matches; legacy codes, aliases and provider names map to current codes), then a loaded saved configuration, then the TA's saved provider. Provider rows (no M_TERRITORY in the builder's format) reach their TA through the same suburb or spelling in your map/ref lists, else the TA's LINZ suburbs. Your acronym is shown with the saved provider it resolves to (used for rates and stored in the database); codes matching no provider are flagged with a link to 2.2. Only a hand pick (`prvdr_manual`) outranks your files, and it can be reset;
   - each selected TA shows that PRVDR's **charging rates** (type, fixed $/yr, volumetric $/m³, date checked) with a link to the provider's **source**;
   - **timeline per TA, set independently:** each row has its own weather period (two text fields that accept typed or pasted dates such as `2012-01-01`, also `2012/01/01` or NZ-style `1/1/2012`; blank end = latest; invalid or reversed dates are rejected) and census-year pills (’13, ’18, ’23). A template above the table with *Apply to all* copies one timeline to every selected TA, which can then be changed individually. Regions already in the database have their own timeline editor in 3 Load (Refresh a region), saved to `regions.timeline` and used by the region's next climate/census job;
   - **saved configurations** (`batch_configs`) store the selected TAs, PRVDRs, keep rule, provider-code matches (`prvdr_matches`), allocations (`allocations`) and the resulting suburb names, never file contents; they are private to their owner;
   - **input files:** the builder config and the three lists, each in its own slot or several at once (routed by file name);
   - **study section in exported configs:** besides the builder's own fields, an exported config carries a `study` section: the configuration name, keep rule, timeline template and, per selected TA, its PRVDR (with name, origin and whether it was chosen by hand), the acronyms and unmatched codes from your files, its timeline (`weatherFrom`, `weatherTo`, `censusYears`), scope basis and suburbs in scope, picks, every study → LINZ mapping (how it was made, and whether excluded) and the LINZ suburbs to load. It also carries your three list files (name, separator, headers and rows) and the id of the saved configuration it came from. The list files live in the exported file only and are never stored in the database. The reference builder ignores the section. Importing the file here restores the TAs, PRVDRs, timelines, picks, scope and list files, so the CSVs needn't be loaded again, and selects the matching study in the header when it is one of your saved configurations;
   - **builder configs:** `nz_suburb_builder_config.json` from `suburb_lookup.html` can be imported (keep rule, `prvdrMatches`, `suburbAllocations`; it lists which of the lists it expects) and exported in the same format, keeping fields this app doesn't use (data folder, outputs, other settings).
2. **2.2 Allocate** (as the builder's Allocate tab):
   - every PRVDR / PROVIDER value in your files, with the saved provider it resolves to and a picker to assign or override it;
   - on opening, each selected TA's LINZ suburbs are loaded from the shared cache, so study names are cross-referenced without validating first;
   - **one table of study suburbs per TA** (from the provider file, or the keep-lists), each with its status: *not found* (listed first), *mapped* (by an allocation) or *matched* (by name or spelling), its LINZ suburbs as removable chips, and "did you mean" suggestions;
   - **assigning on the map:** tick one or more study suburbs, then click LINZ areas to assign them; clicking an area again unassigns it from all ticked suburbs. A study suburb can use several LINZ suburbs and a LINZ suburb several study suburbs. With nothing ticked, clicking an area ticks the study suburbs that use it;
   - untick *Load* to leave a study suburb out (`suburb_picks.skip`); earlier include/exclude picks still apply and can be cleared. Study suburbs not in your files can be added;
   - **finding suburbs:** names match ignoring macrons, case, punctuation and the abbreviations Mt/Mount, St/Saint, Pt/Point. Suggestions rank LINZ names by edit distance. *Locate not-found names* looks each name up in the **NZ Gazetteer** (LINZ official place names, layer 51681, through the `linz-suburbs` Edge Function, budgeted) and suggests the LINZ suburb containing each place's coordinates. *Re-fetch LINZ suburbs* refreshes a TA's list;
   - **LINZ suburbs of a TA:** LINZ lists 186 suburbs under more than one TA (e.g. "Tauranga City, Western Bay of Plenty District"). The fetch matches any listed TA exactly (Tauranga 32 suburbs instead of 27, Auckland 805 instead of 794), the shared cache is keyed by (suburb, TA), and a TA's list is served from the cache only after a complete fetch (`linz_suburb_fetch`; migration 0022). Earlier caches were refetched once;
   - **suburbs just outside the TA:** *Find not-found names* also searches LINZ nationally for each not-found name (action `nearby`) and keeps suburbs within ~8 km of the TA that aren't in its list. They are offered as ↗ suggestions with the council LINZ places them in and the distance. Choosing one adopts it into the TA's suburb list (action `adopt`; `linz_suburb_index.adopted`, `home_ta`; migration 0023) and assigns it. Adopted suburbs survive re-fetches of the TA and are loaded by the worker with the region;
   - **bulk and exclusions:** *Select all shown*, *Load all shown*, *Exclude all shown*, and a Load / Excluded toggle per row (matched and mapped alike);
   - **combine study suburbs:** treat one study suburb as another spelling of another. Its rows and LINZ suburbs join the kept one, which can be undone (`suburb_picks.alias`);
   - **incomplete allocation is flagged:** the TA buttons and the Next button show how many study suburbs are still unassigned, and moving on to 2.3 asks for confirmation;
   - old builder configs keep working: allocations keyed on the provider list (M_SUBURB) and on the map list (NZ_SUBURB_REF, or M_SUBURB when blank) apply to the matching study suburbs;
   - derived data (scope, PRVDRs, allocation rows, SVG paths) is cached and recomputed only when its inputs change, so switching steps and clicking the map stay quick.
3. **2.3 Validate suburbs:**
   - each selected TA's scoped names are checked against LINZ suburbs (macron-insensitive); allocated rows count as matched, 2.2's picks apply; not-found names show "did you mean" suggestions;
   - the located suburbs are drawn on a zoomable map: in scope in blue, the TA's other suburbs in grey;
   - LINZ suburbs come from the `linz-suburbs` Edge Function, which is editor-only, uses the caller's key or the project key, counts against the key's daily budget, honours Retry-After, and fetches each TA **once into a shared cache** (`linz_suburb_index`, fresh for 30 days); Allocate and Validate share it;
   - the worker reads the same cache, so loading a validated TA makes no suburbs request.
   - **refined input files** (end of 2.2 and 2.3): your refinements (mappings, exclusions, added study suburbs) merged into the three files and saved as **new versions**, never over the originals: `<name>_v<N+1>_<yyyymmdd-hhmm>.csv`, with the same headers, separator and extra columns. Rows for TAs not refined (not selected, or LINZ suburbs not loaded) are kept as they were. *All three* also saves a builder config whose inputs point to the new versions. The refined provider file drops study suburbs whose LINZ suburbs were all excluded and adds study suburbs created in 2.2; the map file has one row per study → LINZ pair; the ref file lists the LINZ suburbs to load.
4. **3 Load:** directly under *Queue batch*, a **live progress panel** shows your recent batches. Each has an overall progress bar and, per region, the job status and each pipeline step (✓ done, ⏳ running, ⏸ paused at the daily limit, ✗ failed, ○ waiting) with its latest log line, reason and *resumes after* time. **Logs are anonymised in public:** the repository is public, so in GitHub Actions the worker prints only anonymous lines: a job token (salted hash, set `NZSW_LOG_SALT` or the database URL secret is used), step names, statuses and durations, and error types without messages. It prints no region or suburb names, IDs, coordinates, capture or tile names, dates or key usage. Full detail is stored only in `job_runs`, readable by the job's owner and admins. While a step runs, the worker reports every few seconds (`job_runs.progress`, `detail` = latest 12 lines, `updated_at`; migration 0025): LINZ pages and features downloaded, tiles processed with pools found, census tables fetched, climate cells. The panel shows the running step's progress bar, latest line, *updated N s ago* (flagged after 10 minutes without an update) and a *details* list. It refreshes every ~8 s while a step runs (15 s otherwise) and while the page is visible, and shows when the worker next runs (every 15 minutes). Batches run on the server (GitHub Actions worker), so refreshing or closing the page doesn't interrupt them. GitHub runs the 15-minute schedule only on a best-effort basis (it has gone hours without a run), so queuing a batch, or *Run worker now*, also asks the `kick-worker` Edge Function to start the worker. It is editors only and needs the secret `GITHUB_DISPATCH_TOKEN`, a fine-grained token for this repository with Actions: read and write. It skips the request when a run is already queued or in progress, or one was requested in the last 5 minutes. The imagery index fetches tile footprints 16 at a time and stops before the run's time limit (continuing next run). At start, the worker queues again any job left *running* with no activity for 3 hours, i.e. a run that was stopped. App queries may take up to 30 s (`statement_timeout` for signed-in users; migration 0026); region outlines load simplified to 20 m, and a region that fails to load shows the error with *Try again*. Each worker run has **three parallel legs**, each claiming a different region (`claim_job` uses `FOR UPDATE SKIP LOCKED`); daily budgets are shared through the database ledger. Large regions load **in parts**: each run stores at most 60 neighbouring suburbs' parcels and buildings, 80 new SA2s' census data and 250 imagery tiles, then the step continues in the next run until done (the suburb, census and imagery steps raise *continue* instead of refusing the region). Failed regions can be queued again with *Retry failed* (finished steps are skipped). *Queue batch* queues the TAs that are ready (validated, with suburbs to load). Each other TA shows why it isn't ready (not validated, validation failed, nothing to load, too large), and *Validate the rest* validates them from here. *Next* on the last TA of 2.3 goes to 3 Load (and on the last TA of 2.2 to 2.3). Queuing loads only validated LINZ suburbs (`regions.scope`) with the region's PRVDR (`regions.prvdr`). `m_suburbs` keeps your M_SUBURB names with the LINZ suburb each maps to, one row per allocated suburb. Then follow progress, publish, and download the tile list.

## 26. Privacy
- Users see only their own configurations, batches, jobs (plus scheduled project jobs), job runs, validation labels and exports, and usage of their own keys or the project's. Admins see everything.
- `created_by` columns are not readable by users. The rate setting doesn't record who changed it.
- Uploaded files are processed in the browser; only the resulting suburb names and mappings are stored.
- Development workspace: personal data was removed from test fixtures, and the full-access database login was deleted after setup. Tests use the worker's limited login and synthetic users.

## 27. Deploying database changes
- `.github/workflows/deploy-supabase.yml` runs when `supabase/migrations/**` or `supabase/functions/**` change on `main`, or by hand (Actions → Deploy Supabase → Run workflow). It links the project, prints a dry run, applies pending migrations, and deploys every Edge Function.
- Credentials are only in the GitHub `production` environment, restricted to `main`: secrets `SUPABASE_DB_PASSWORD` and `SUPABASE_ACCESS_TOKEN`, variable `SUPABASE_PROJECT_REF`. Development workspaces hold no database admin login.
- Auth settings (`config.toml`) are not pushed by the workflow; change them in the dashboard.
