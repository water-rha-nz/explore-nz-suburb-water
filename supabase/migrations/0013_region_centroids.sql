-- map markers: each visible region's position from its own suburbs (RLS on suburbs applies)
create or replace function public.region_centroids() returns jsonb
language sql stable security invoker set search_path = public, extensions as $$
  select coalesce(jsonb_object_agg(region_id, jsonb_build_array(round(st_x(c)::numeric, 4), round(st_y(c)::numeric, 4))), '{}'::jsonb)
  from (select region_id, st_transform(st_centroid(st_union(geom)), 4326) c from suburbs where region_id is not null group by region_id) t;
$$;
revoke execute on function public.region_centroids() from public, anon;
grant execute on function public.region_centroids() to authenticated;
