-- Overview map: where pools and green space are, separate from the suburb statistics (docs/SPEC.md, 1 Overview).
-- Aggregated to a square grid (cell >= 100 m) and only for cells with at least 5 sections, so viewers see presence without
-- any single property; property-level detail stays with editors (map_items at full zoom, row-level security).
create or replace function public.map_presence(p_region text, p_step float) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  with g as (select greatest(coalesce(p_step, 200), 100)::float st),
  ok as (select 1 where public.has_role('viewer') and public.region_visible(p_region)),
  sec as (select s.parcel_id, st_pointonsurface(s.geom) p,
                 (select max(si.veg_m2) from section_imagery si where si.section_id = s.parcel_id) veg
          from sections s, ok where s.region_id = p_region),
  cs as (select floor(st_x(p) / g.st)::bigint cx, floor(st_y(p) / g.st)::bigint cy, count(*) n, sum(coalesce(veg, 0)) green
         from sec, g group by 1, 2),
  cp as (select floor(st_x(pc.geom) / g.st)::bigint cx, floor(st_y(pc.geom) / g.st)::bigint cy, count(*) pools, sum(pc.area_m2) pool_m2
         from pool_candidates pc join sections s on s.parcel_id = pc.section_id, g, ok
         where pc.tool_pool and s.region_id = p_region group by 1, 2)
  select jsonb_build_object('step', (select st from g), 'cells', coalesce(jsonb_agg(jsonb_build_object(
           'x', (cs.cx + 0.5) * g.st, 'y', (cs.cy + 0.5) * g.st, 'n', cs.n, 'green', round(cs.green),
           'pools', coalesce(cp.pools, 0), 'pool_m2', round(coalesce(cp.pool_m2, 0)))), '[]'::jsonb))
  from cs left join cp using (cx, cy), g where cs.n >= 5;
$$;
revoke execute on function public.map_presence(text, float) from public, anon;
grant execute on function public.map_presence(text, float) to authenticated;

-- full zoom: also each section's green area (property-level: row-level security limits it to editors)
create or replace function public.map_items(p_region text, p_x0 float, p_y0 float, p_x1 float, p_y1 float) returns jsonb
language sql stable security invoker set search_path = public, extensions as $$
  with box as (select st_makeenvelope(p_x0, p_y0, p_x1, p_y1, 2193) g
               where (p_x1 - p_x0) * (p_y1 - p_y0) <= 9e6),
  pools as (select p.id, st_x(p.geom) x, st_y(p.geom) y, round(p.area_m2) area
            from pool_candidates p join sections s on s.parcel_id = p.section_id, box
            where p.tool_pool and s.region_id = p_region and p.geom && box.g limit 600),
  greens as (select st_x(st_pointonsurface(s.geom)) x, st_y(st_pointonsurface(s.geom)) y, round(max(si.veg_m2)) veg
             from sections s join section_imagery si on si.section_id = s.parcel_id, box
             where s.region_id = p_region and s.geom && box.g and si.veg_m2 > 0 group by s.parcel_id, s.geom limit 1500),
  chips as (select v.id, v.task, v.chip_path, v.tool_verdict,
                   st_x(coalesce(c.geom, st_pointonsurface(s.geom))) x, st_y(coalesce(c.geom, st_pointonsurface(s.geom))) y
            from validation_items v left join pool_candidates c on c.id = v.candidate_id left join sections s on s.parcel_id = v.section_id, box
            where v.chip_path is not null and coalesce(c.geom, st_pointonsurface(s.geom)) && box.g limit 150)
  select jsonb_build_object('pools', coalesce((select jsonb_agg(pools) from pools), '[]'::jsonb),
                            'greens', coalesce((select jsonb_agg(greens) from greens), '[]'::jsonb),
                            'chips', coalesce((select jsonb_agg(chips) from chips), '[]'::jsonb));
$$;
