-- Timelines per region (set per TA/provider in Configure): the weather extraction period and the census years to use.
-- {"climate_start": "2013-01-01", "climate_end": "2025-12-31", "census_years": [2018, 2023]}; empty = defaults.
alter table public.regions add column if not exists timeline jsonb not null default '{}'::jsonb;
grant select (timeline) on public.regions to authenticated;
alter table public.batch_configs add column if not exists timelines jsonb not null default '{}'::jsonb;
grant select (timelines) on public.batch_configs to authenticated;

-- Map at full zoom: detected pools and validation chips inside a small box (NZTM metres). Runs with the caller's
-- rights (row-level security applies: property-level rows are visible to editors / labellers only), capped in size.
create or replace function public.map_items(p_region text, p_x0 float, p_y0 float, p_x1 float, p_y1 float) returns jsonb
language sql stable security invoker set search_path = public, extensions as $$
  with box as (select st_makeenvelope(p_x0, p_y0, p_x1, p_y1, 2193) g
               where (p_x1 - p_x0) * (p_y1 - p_y0) <= 9e6),          -- at most 3 km x 3 km
  pools as (select p.id, st_x(p.geom) x, st_y(p.geom) y, round(p.area_m2) area
            from pool_candidates p join sections s on s.parcel_id = p.section_id, box
            where p.tool_pool and s.region_id = p_region and p.geom && box.g limit 600),
  chips as (select v.id, v.task, v.chip_path, v.tool_verdict,
                   st_x(coalesce(c.geom, st_pointonsurface(s.geom))) x, st_y(coalesce(c.geom, st_pointonsurface(s.geom))) y
            from validation_items v left join pool_candidates c on c.id = v.candidate_id left join sections s on s.parcel_id = v.section_id, box
            where v.chip_path is not null and coalesce(c.geom, st_pointonsurface(s.geom)) && box.g limit 150)
  select jsonb_build_object('pools', coalesce((select jsonb_agg(pools) from pools), '[]'::jsonb),
                            'chips', coalesce((select jsonb_agg(chips) from chips), '[]'::jsonb));
$$;
revoke execute on function public.map_items(text, float, float, float, float) from public, anon;
grant execute on function public.map_items(text, float, float, float, float) to authenticated;
