-- Region data loads in small chunks (docs/SPEC.md: lazy loading): outlines by id lists, SA2 codes a few suburbs at a time
-- (index on sections.suburb_id), so no single request scans a whole large region. RLS applies (security invoker).
create or replace function public.suburb_outlines(p_ids bigint[], p_tol float default 20) returns jsonb
language sql stable security invoker set search_path = public, extensions as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', linz_id::text, 'name', name,
           'geom', st_asgeojson(st_multi(st_simplifypreservetopology(geom, p_tol)), 0)::jsonb)), '[]'::jsonb)
  from suburbs where linz_id = any(p_ids);
$$;
create or replace function public.sa2_codes_for(p_ids bigint[]) returns text[]
language sql stable security invoker set search_path = public as $$
  select coalesce(array_agg(distinct sa2_code), '{}') from sections where suburb_id = any(p_ids) and sa2_code is not null;
$$;
create or replace function public.sa2_outlines(p_codes text[], p_tol float default 15) returns jsonb
language sql stable security invoker set search_path = public, extensions as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', code, 'name', name,
           'geom', st_asgeojson(st_multi(st_simplifypreservetopology(geom, p_tol)), 0)::jsonb)), '[]'::jsonb)
  from sa2 where code = any(p_codes);
$$;
revoke execute on function public.suburb_outlines(bigint[], float), public.sa2_codes_for(bigint[]), public.sa2_outlines(text[], float) from public, anon;
grant execute on function public.suburb_outlines(bigint[], float), public.sa2_codes_for(bigint[]), public.sa2_outlines(text[], float) to authenticated;
create index if not exists sections_region_id_idx on public.sections (region_id);
create index if not exists climate_daily_cell_date_idx on public.climate_daily (cell_id, date);
-- make the API pick up the 30 s statement timeout for signed-in users (migration 0026)
notify pgrst, 'reload config';
