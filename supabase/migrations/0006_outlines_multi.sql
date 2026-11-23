-- region_outlines: always return MultiPolygon (simplification can collapse single-part shapes to Polygon)
create or replace function public.region_outlines(p_region text, p_kind text default 'suburbs', p_tol float default 8)
returns jsonb language sql stable security invoker set search_path = public, extensions as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name,
           'geom', st_asgeojson(st_multi(st_simplifypreservetopology(geom, p_tol)), 0)::jsonb)), '[]'::jsonb)
  from (
    select linz_id::text id, name, geom from suburbs where p_kind = 'suburbs' and region_id = p_region
    union all
    select code, name, geom from sa2 where p_kind = 'sa2' and code in (
      select distinct s.sa2_code from sections s where s.region_id = p_region and s.sa2_code is not null)
  ) t;
$$;
