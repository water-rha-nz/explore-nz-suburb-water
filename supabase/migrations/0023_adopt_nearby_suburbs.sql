-- Study suburbs that LINZ places just outside the TA (in a neighbouring TA) can be adopted into the TA's suburb list: found by
-- name nationally, kept only if within a few km of the TA, stored with adopted = true and the TA(s) LINZ lists (home_ta).
-- Adopted suburbs survive a re-fetch of the TA (docs/SPEC.md section 25).
alter table public.linz_suburb_index add column if not exists adopted boolean not null default false;
alter table public.linz_suburb_index add column if not exists home_ta text;

create or replace function public.edge_suburb_fetch(p_ta text, p_done boolean, p_features int default 0) returns void
language plpgsql security definer set search_path = public as $$
declare st timestamptz;
begin
  if not p_done then
    insert into linz_suburb_fetch (ta_code, started_at, complete) values (p_ta, now(), false)
      on conflict (ta_code) do update set started_at = now(), complete = false;
  else
    select started_at into st from linz_suburb_fetch where ta_code = p_ta;
    delete from linz_suburb_index where ta_code = p_ta and fetched_at < st and not adopted;
    update linz_suburb_fetch set fetched_at = now(), features = p_features, complete = true where ta_code = p_ta;
  end if;
end $$;

-- candidates (NZTM GeoJSON features from LINZ) within p_km of the TA that are not in its list yet, nearest first
create or replace function public.edge_near_ta(p_ta text, p_fc jsonb, p_km float default 8) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select coalesce(jsonb_agg(c order by c ->> 'km'), '[]'::jsonb) from (
    select jsonb_build_object('id', (f -> 'properties' ->> 'id')::int, 'name', f -> 'properties' ->> 'name', 'type', f -> 'properties' ->> 'type',
             'ta', f -> 'properties' ->> 'territorial_authority', 'km', round((st_distance(t.geom, g) / 1000)::numeric, 1)) c
    from jsonb_array_elements(p_fc -> 'features') f
    cross join lateral (select st_setsrid(st_geomfromgeojson(f ->> 'geometry'), 2193) g) gg
    join territorial_authorities t on t.code = p_ta
    where st_dwithin(t.geom, g, p_km * 1000)
      and not exists (select 1 from linz_suburb_index i where i.ta_code = p_ta and i.linz_id = (f -> 'properties' ->> 'id')::int)) x;
$$;
create or replace function public.edge_adopt_suburbs(p_ta text, p_fc jsonb) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare f jsonb; n int := 0;
begin
  for f in select * from jsonb_array_elements(p_fc -> 'features') loop
    insert into linz_suburb_index (linz_id, ta_code, name, name_ascii, type, major_name, geom, fetched_at, adopted, home_ta)
    values ((f -> 'properties' ->> 'id')::int, p_ta, f -> 'properties' ->> 'name', f -> 'properties' ->> 'name_ascii', f -> 'properties' ->> 'type',
            f -> 'properties' ->> 'major_name',
            st_multi(st_simplifypreservetopology(st_transform(st_setsrid(st_geomfromgeojson(f ->> 'geometry'), 4326), 2193), 5)), now(), true,
            f -> 'properties' ->> 'territorial_authority')
    on conflict (linz_id, ta_code) do update set adopted = true, home_ta = excluded.home_ta, geom = excluded.geom, fetched_at = now();
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function public.edge_near_ta(text, jsonb, float), public.edge_adopt_suburbs(text, jsonb) from public, anon, authenticated;
grant execute on function public.edge_near_ta(text, jsonb, float), public.edge_adopt_suburbs(text, jsonb) to service_role;

-- the app sees which suburbs were adopted and where LINZ places them
create or replace function public.ta_suburbs(p_ta text, p_tol float default 20) returns jsonb
language sql stable security invoker set search_path = public, extensions as $$
  select jsonb_build_object('fetched_at', max(fetched_at), 'suburbs', coalesce(jsonb_agg(jsonb_build_object('id', linz_id, 'name', name,
         'name_ascii', name_ascii, 'type', type, 'adopted', adopted, 'home_ta', home_ta,
         'geom', st_asgeojson(st_multi(st_simplifypreservetopology(geom, p_tol)), 0)::jsonb) order by name), '[]'::jsonb))
  from linz_suburb_index where ta_code = p_ta;
$$;
