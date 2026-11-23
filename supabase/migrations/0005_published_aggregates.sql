-- Published, viewer-readable aggregates (docs/SPEC.md sections 4 and 10). Property-level imagery results stay
-- editor-only; the worker writes these suburb-level summaries.

-- helper: region is visible to the caller (published, or the caller is an editor)
create or replace function public.region_visible(r text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from regions where id = r and (status = 'published' or public.has_role('editor')));
$$;
revoke execute on function public.region_visible(text) from public, anon;
grant execute on function public.region_visible(text) to authenticated;

alter table public.sections add column if not exists n_titles int, add column if not exists region_id text references public.regions;

create table public.suburb_metrics (
  linz_id integer primary key references public.suburbs on delete cascade,
  region_id text not null references public.regions,
  name text not null, type text, territorial_authority text, prvdr text references public.providers,
  area_km2 numeric, sections int, titles int, density_per_km2 numeric, urban_rural text,
  pools int, perc_pool numeric, pool_area numeric, lot_size numeric, survey_area numeric, footprint numeric,
  unbuilt numeric, gard_size numeric, gard_pct numeric, impervious_proxy numeric, unbuilt_per_title numeric, shared_pct numeric,
  hist_section int[], hist_section_bins int[], hist_garden int[], hist_garden_bins int[],
  capture_id text references public.imagery_captures, climate_cell text references public.climate_cells,
  updated_at timestamptz default now()
);
create table public.suburb_census (
  linz_id integer references public.suburbs on delete cascade, year int,
  sa2s int, sections numeric, hh_size_mean numeric, income_median numeric, bedrooms_mean_all numeric, pct_owner_all numeric,
  pct_separate numeric, pct_joined numeric, bedrooms_mean_separate numeric, bedrooms_mean_joined numeric,
  pct_owner_separate numeric, pct_owner_joined numeric, primary key (linz_id, year)
);
create table public.validation_summary (
  region_id text references public.regions, capture_id text references public.imagery_captures,
  stats jsonb not null, updated_at timestamptz default now(), primary key (region_id, capture_id)
);

alter table public.suburb_metrics enable row level security;
alter table public.suburb_census enable row level security;
alter table public.validation_summary enable row level security;
create policy "viewers read published" on public.suburb_metrics for select to authenticated using (public.has_role('viewer') and public.region_visible(region_id));
create policy "viewers read published" on public.suburb_census for select to authenticated
  using (public.has_role('viewer') and exists (select 1 from public.suburbs s where s.linz_id = suburb_census.linz_id and public.region_visible(s.region_id)));
create policy "viewers read published" on public.validation_summary for select to authenticated using (public.has_role('viewer') and public.region_visible(region_id));
create policy "worker rw" on public.suburb_metrics for all to worker using (true) with check (true);
create policy "worker rw" on public.suburb_census for all to worker using (true) with check (true);
create policy "worker rw" on public.validation_summary for all to worker using (true) with check (true);
grant select, insert, update, delete on public.suburb_metrics, public.suburb_census, public.validation_summary to worker;

-- monthly climate per cell (viewers can read climate_daily)
create view public.v_climate_monthly with (security_invoker = true) as
select cell_id, date_trunc('month', date)::date as month, sum(rain_mm) rain_mm, avg(tmean_c) tmean_c, avg(tmax_c) tmax_c,
       sum(et0_mm) et0_mm, sum(et0_mm) - sum(rain_mm) deficit_mm, count(*) days
from public.climate_daily group by 1, 2;

-- map outlines for a region as GeoJSON (NZTM metres, simplified); RLS on suburbs/sa2 applies (security invoker)
create or replace function public.region_outlines(p_region text, p_kind text default 'suburbs', p_tol float default 8)
returns jsonb language sql stable security invoker set search_path = public, extensions as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name,
           'geom', st_asgeojson(st_simplifypreservetopology(geom, p_tol), 0)::jsonb)), '[]'::jsonb)
  from (
    select linz_id::text id, name, geom from suburbs where p_kind = 'suburbs' and region_id = p_region
    union all
    select code, name, geom from sa2 where p_kind = 'sa2' and code in (
      select distinct s.sa2_code from sections s where s.region_id = p_region and s.sa2_code is not null)
  ) t;
$$;
revoke execute on function public.region_outlines(text, text, float) from public, anon;
grant execute on function public.region_outlines(text, text, float) to authenticated;

-- editors may change download rates (SPEC 20.6); other settings stay admin-only
create policy "editors manage rates" on public.app_settings for all to authenticated
  using (key = 'rates' and public.has_role('editor')) with check (key = 'rates' and public.has_role('editor'));
grant select on public.app_settings to worker;
create policy "worker reads settings" on public.app_settings for select to worker using (true);
insert into public.app_settings values ('rates', '{}'::jsonb) on conflict (key) do nothing;
