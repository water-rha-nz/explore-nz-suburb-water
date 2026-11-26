-- Per-household (residential section) rows for nz_household_ref (docs/SPEC.md section 34): LINZ parcel facts with spatial measures
-- (centre in NZTM and lon/lat, perimeter, compactness, land area per title) plus the section's imagery measures (roof, unbuilt,
-- garden, pools). Security invoker: row-level security applies, so the imagery columns (section_imagery, pool_candidates) are
-- filled only for editors and are blank for everyone else. Paged by parcel id.
create or replace function public.household_rows(p_region text, p_after integer default null, p_limit integer default 1000)
returns table (parcel_id integer, suburb_id integer, sa2_code text, parcel_intent text, polygon_m2 numeric, n_titles integer,
               x numeric, y numeric, lon numeric, lat numeric, perimeter_m numeric, compactness numeric,
               capture_id text, roof_m2 numeric, unbuilt_m2 numeric, garden_m2 numeric, valid_m2 numeric, pools integer, pool_m2 numeric)
language sql stable security invoker set search_path = public, extensions as $$
  select s.parcel_id, s.suburb_id, s.sa2_code, s.parcel_intent, s.polygon_m2, coalesce(s.n_titles, 1),
         round(st_x(c.p)::numeric, 1), round(st_y(c.p)::numeric, 1),
         round(st_x(st_transform(c.p, 4326))::numeric, 6), round(st_y(st_transform(c.p, 4326))::numeric, 6),
         round(st_perimeter(s.geom)::numeric, 1),
         round((4 * pi() * st_area(s.geom) / nullif(st_perimeter(s.geom) ^ 2, 0))::numeric, 3),
         si.capture_id, si.building_m2, si.unbuilt_m2, si.veg_m2, si.valid_m2, pc.n, pc.m2
  from sections s
  cross join lateral (select st_pointonsurface(s.geom) p) c
  left join lateral (select x.capture_id, x.building_m2, x.unbuilt_m2, x.veg_m2, x.valid_m2 from section_imagery x
                     where x.section_id = s.parcel_id order by x.valid_m2 desc nulls last limit 1) si on true
  left join lateral (select count(*)::int n, round(sum(p.area_m2), 1) m2 from pool_candidates p
                     where p.section_id = s.parcel_id and coalesce(p.model_pool, p.tool_pool)) pc on si.capture_id is not null
  where s.region_id = p_region and (p_after is null or s.parcel_id > p_after)
  order by s.parcel_id limit least(greatest(coalesce(p_limit, 1000), 1), 1000);
$$;
revoke all on function public.household_rows(text, integer, integer) from public, anon;
grant execute on function public.household_rows(text, integer, integer) to authenticated;
notify pgrst, 'reload schema';
