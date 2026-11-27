-- Invalid polygon outlines (as delivered by LINZ for a few suburbs) made ST_Union fail ("TopologyException: unable to assign
-- free hole to a shell") in region_centroids, which the app calls at sign-in. (docs/SPEC.md section 38)
set local statement_timeout = '20min';

-- 1) centroids without a union: the centroid of the region's outlines collected together
create or replace function public.region_centroids() returns jsonb
language sql stable security invoker set search_path = public, extensions as $$
  select coalesce(jsonb_object_agg(region_id, jsonb_build_array(round(st_x(c)::numeric, 4), round(st_y(c)::numeric, 4))), '{}'::jsonb)
  from (select region_id, st_transform(st_centroid(st_collect(geom)), 4326) c from suburbs where region_id is not null and geom is not null group by region_id) t;
$$;

-- 2) repair stored outlines that are invalid (keep the polygon parts of the repaired shape)
create or replace function public.valid_multipolygon(g extensions.geometry) returns extensions.geometry
language sql immutable set search_path = public, extensions as $$
  select case when g is null or st_isvalid(g) then g
              else st_multi(st_collectionextract(st_makevalid(g), 3)) end;
$$;
update public.suburbs set geom = public.valid_multipolygon(geom) where geom is not null and not st_isvalid(geom);
update public.sections set geom = public.valid_multipolygon(geom) where not st_isvalid(geom);
update public.sa2 set geom = public.valid_multipolygon(geom) where geom is not null and not st_isvalid(geom);
update public.linz_suburb_index set geom = public.valid_multipolygon(geom) where geom is not null and not st_isvalid(geom);

-- 3) keep them valid: repair on every insert or update
create or replace function public.make_geom_valid() returns trigger
language plpgsql set search_path = public, extensions as $$
begin
  if new.geom is not null and not st_isvalid(new.geom) then new.geom := public.valid_multipolygon(new.geom); end if;
  return new;
end $$;
drop trigger if exists geom_valid on public.suburbs;
create trigger geom_valid before insert or update of geom on public.suburbs for each row execute function public.make_geom_valid();
drop trigger if exists geom_valid on public.sections;
create trigger geom_valid before insert or update of geom on public.sections for each row execute function public.make_geom_valid();
drop trigger if exists geom_valid on public.sa2;
create trigger geom_valid before insert or update of geom on public.sa2 for each row execute function public.make_geom_valid();
drop trigger if exists geom_valid on public.linz_suburb_index;
create trigger geom_valid before insert or update of geom on public.linz_suburb_index for each row execute function public.make_geom_valid();
