-- explore-nz-suburb-water: initial schema (draft, see docs/SPEC.md sections 4 and 12)
-- Apply with: supabase db push
-- All geometries NZTM (EPSG:2193). Every source row records source, source_version, fetched_at.

create extension if not exists postgis;
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ---------------------------------------------------------------- roles & profiles
create type app_role as enum ('viewer', 'labeller', 'editor', 'admin');

create table profiles (
  id            uuid primary key references auth.users on delete cascade,
  email         text not null,
  display_name  text,
  role          app_role not null default 'viewer',
  status        text not null default 'pending' check (status in ('pending', 'active', 'disabled')),
  created_at    timestamptz not null default now()
);

create table app_settings (
  key   text primary key,
  value jsonb not null
);
insert into app_settings values ('auto_approve_domains', '[]'::jsonb);

-- profile row at first Google sign-in; auto-activate allowlisted domains
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare doms jsonb;
begin
  select value into doms from app_settings where key = 'auto_approve_domains';
  insert into profiles (id, email, display_name, status)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', new.email),
          case when doms ? split_part(new.email, '@', 2) then 'active' else 'pending' end);
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function handle_new_user();

-- true when the caller is active and ranks at least `min`
create or replace function has_role(min app_role) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles p where p.id = auth.uid() and p.status = 'active' and p.role >= min);
$$;

-- ---------------------------------------------------------------- audit
create table audit_log (
  id bigserial primary key, at timestamptz not null default now(), user_id uuid default auth.uid(),
  tbl text not null, row_key text, action text not null, old jsonb, new jsonb
);
create or replace function audit() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into audit_log (tbl, row_key, action, old, new)
  values (tg_table_name, coalesce((to_jsonb(new)->>'id'), (to_jsonb(old)->>'id')), tg_op,
          case when tg_op <> 'INSERT' then to_jsonb(old) end, case when tg_op <> 'DELETE' then to_jsonb(new) end);
  return coalesce(new, old);
end $$;

-- ---------------------------------------------------------------- regions & reference data
create table regions (
  id text primary key, name text not null, territorial_authorities text[] not null,
  suburb_names text[], imagery_captures text[], status text not null default 'draft'
    check (status in ('draft', 'processing', 'published')),
  created_by uuid default auth.uid(), created_at timestamptz default now()
);

create table suburbs (
  linz_id integer primary key, name text not null, type text, territorial_authority text,
  population_estimate integer, geom geometry(MultiPolygon, 2193) not null,
  region_id text references regions, source text default 'LINZ 113764', source_version text, fetched_at timestamptz default now()
);
create index on suburbs using gist (geom);

create table providers (
  prvdr text primary key check (prvdr ~ '^[A-Z0-9]+$'),   -- letters and digits only (no underscores)
  legacy_prvdr text,                                     -- reference builder's code, kept as an alias
  name text not null, aliases text[], territories text[]
);

create table m_suburbs (
  id bigserial primary key, region_id text references regions, m_suburb text not null, m_territory text,
  prvdr text references providers, other_spellings text[]
);
create table m_suburb_links (m_suburb_id bigint references m_suburbs on delete cascade, linz_id integer references suburbs, share_rule text,
  primary key (m_suburb_id, linz_id));

create table sections (
  parcel_id integer primary key, appellation text, parcel_intent text, survey_area numeric, polygon_m2 numeric,
  geom geometry(MultiPolygon, 2193) not null, suburb_id integer references suburbs, sa2_code text,
  source text default 'LINZ 50772', source_version text, fetched_at timestamptz default now()
);
create index on sections using gist (geom);
create index on sections (suburb_id);

create table titles (
  title_no text primary key, type text, status text, issue_date date, spatial_extents_shared boolean,
  parcel_ids integer[], source text default 'LINZ 50804', source_version text, fetched_at timestamptz default now()
);

create table buildings (
  building_id integer primary key, area_m2 numeric, capture_source text, geom geometry(Polygon, 2193) not null,
  source text default 'LINZ 101290', source_version text, fetched_at timestamptz default now()
);
create index on buildings using gist (geom);

create table water_rates (
  prvdr text references providers, valid_from date not null, charging_type text, fixed_pa numeric, volumetric_pa numeric,
  threshold_lpd numeric, date_est date, note text, source_url text, verified boolean default false,
  primary key (prvdr, valid_from)
);

-- ---------------------------------------------------------------- imagery & validation
create table imagery_captures (
  id text primary key, s3_prefix text not null, year int, resolution_m numeric, bands text,
  calibration jsonb   -- pool thresholds or model version
);
create table section_imagery (       -- property-level: editors only
  section_id integer references sections, capture_id text references imagery_captures,
  valid_m2 numeric, open_m2 numeric, veg_m2 numeric, building_m2 numeric, unbuilt_m2 numeric,
  primary key (section_id, capture_id)
);
create table pool_candidates (       -- property-level: editors only
  id bigserial primary key, capture_id text references imagery_captures, section_id integer references sections,
  geom geometry(Point, 2193), area_m2 numeric, features jsonb, tool_pool boolean
);
create table validation_items (
  id bigserial primary key, task text not null check (task in ('pool', 'garden')), capture_id text references imagery_captures,
  candidate_id bigint references pool_candidates, section_id integer references sections, grp text, chip_path text, tool_verdict text
);
create table validation_labels (
  item_id bigint references validation_items on delete cascade, user_id uuid references auth.users default auth.uid(),
  label text not null check (label in ('pool', 'not_pool', 'water', 'unknown', 'over', 'about_right', 'under')),
  labelled_at timestamptz default now(), primary key (item_id, user_id)
);

-- ---------------------------------------------------------------- census & climate
create table sa2 (code text primary key, name text, version int default 2023, geom geometry(MultiPolygon, 2193));
create index on sa2 using gist (geom);
create table census_values (
  sa2_code text references sa2, dataflow text, year int, dims jsonb, value numeric, status text,
  fetched_at timestamptz default now()
);
create index on census_values (sa2_code, dataflow, year);
create table census_metrics (
  sa2_code text references sa2, year int, households numeric, pct_separate numeric, pct_joined numeric,
  bedrooms_mean_all numeric, bedrooms_mean_separate numeric, bedrooms_mean_joined numeric,
  pct_owner_all numeric, pct_owner_separate numeric, pct_owner_joined numeric, hh_size_mean numeric, income_median numeric,
  primary key (sa2_code, year)
);
create table climate_cells (id text primary key, lat numeric, lon numeric);
create table suburb_climate_cell (linz_id integer references suburbs, cell_id text references climate_cells, primary key (linz_id));
create table climate_daily (
  cell_id text references climate_cells, date date, rain_mm numeric, tmean_c numeric, tmax_c numeric, et0_mm numeric,
  source text default 'Open-Meteo archive (best_match)', fetched_at timestamptz default now(), primary key (cell_id, date)
);

-- ---------------------------------------------------------------- orchestration & exports
create table jobs (
  id bigserial primary key, type text not null, region_id text references regions, params jsonb, status text default 'queued'
    check (status in ('queued', 'running', 'done', 'failed')), log text, counts jsonb,
  created_by uuid default auth.uid(), created_at timestamptz default now(), finished_at timestamptz
);
create table exports (
  id bigserial primary key, region_id text references regions, as_of timestamptz default now(), format text,
  storage_path text, checksum text, created_by uuid default auth.uid()
);

-- ---------------------------------------------------------------- RLS
alter table profiles enable row level security;
alter table app_settings enable row level security;
alter table audit_log enable row level security;
alter table regions enable row level security;
alter table suburbs enable row level security;
alter table providers enable row level security;
alter table m_suburbs enable row level security;
alter table m_suburb_links enable row level security;
alter table sections enable row level security;
alter table titles enable row level security;
alter table buildings enable row level security;
alter table water_rates enable row level security;
alter table imagery_captures enable row level security;
alter table section_imagery enable row level security;
alter table pool_candidates enable row level security;
alter table validation_items enable row level security;
alter table validation_labels enable row level security;
alter table sa2 enable row level security;
alter table census_values enable row level security;
alter table census_metrics enable row level security;
alter table climate_cells enable row level security;
alter table suburb_climate_cell enable row level security;
alter table climate_daily enable row level security;
alter table jobs enable row level security;
alter table exports enable row level security;

create policy "own profile" on profiles for select using (id = auth.uid() or has_role('admin'));
create policy "admin manages profiles" on profiles for update using (has_role('admin')) with check (has_role('admin'));
create policy "admin settings" on app_settings for all using (has_role('admin')) with check (has_role('admin'));
create policy "admin reads audit" on audit_log for select using (has_role('admin'));

create policy "read published regions" on regions for select using (has_role('viewer') and (status = 'published' or has_role('editor')));
create policy "editors write regions" on regions for all using (has_role('editor')) with check (has_role('editor'));

-- reference data: viewers read, editors write (worker uses the service role, which bypasses RLS)
do $$
declare t text;
begin
  foreach t in array array['suburbs','providers','m_suburbs','m_suburb_links','sections','titles','buildings','water_rates',
                           'imagery_captures','sa2','census_values','census_metrics','climate_cells','suburb_climate_cell','climate_daily'] loop
    execute format('create policy "viewers read" on %I for select using (has_role(''viewer''))', t);
    execute format('create policy "editors write" on %I for all using (has_role(''editor'')) with check (has_role(''editor''))', t);
  end loop;
end $$;

-- property-level imagery results: editors only
create policy "editors only" on section_imagery for all using (has_role('editor')) with check (has_role('editor'));
create policy "editors only" on pool_candidates for all using (has_role('editor')) with check (has_role('editor'));

create policy "labellers read items" on validation_items for select using (has_role('labeller'));
create policy "editors write items" on validation_items for all using (has_role('editor')) with check (has_role('editor'));
create policy "own labels or editor" on validation_labels for select using (user_id = auth.uid() or has_role('editor'));
create policy "label own" on validation_labels for insert with check (has_role('labeller') and user_id = auth.uid());
create policy "relabel own" on validation_labels for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "unlabel own" on validation_labels for delete using (user_id = auth.uid());

create policy "editors jobs" on jobs for all using (has_role('editor')) with check (has_role('editor'));
create policy "own or editor exports" on exports for select using (created_by = auth.uid() or has_role('editor'));
create policy "viewers request exports" on exports for insert with check (has_role('viewer'));

-- audit editor-facing tables
create trigger audit_regions after insert or update or delete on regions for each row execute function audit();
create trigger audit_m_suburbs after insert or update or delete on m_suburbs for each row execute function audit();
create trigger audit_water_rates after insert or update or delete on water_rates for each row execute function audit();
create trigger audit_profiles after update on profiles for each row execute function audit();

-- ---------------------------------------------------------------- consumer view (aggregates only)
create view v_suburb_pools with (security_invoker = true) as
select s.suburb_id as linz_id, c.id as capture_id,
       count(*) filter (where exists (select 1 from pool_candidates p where p.section_id = s.parcel_id and p.capture_id = c.id and p.tool_pool)) * 100.0
         / nullif(count(*), 0) as perc_pool,
       percentile_cont(0.5) within group (order by si.veg_m2) as gard_size,
       percentile_cont(0.5) within group (order by s.polygon_m2) as lot_size,
       percentile_cont(0.5) within group (order by si.building_m2) as footprint
from sections s
join section_imagery si on si.section_id = s.parcel_id
join imagery_captures c on c.id = si.capture_id
group by s.suburb_id, c.id;
-- NOTE: viewers need these aggregates without access to the editor-only base tables. In M6, publish them as a
-- materialised table (refreshed by the worker) readable by viewers, rather than this invoker view.
