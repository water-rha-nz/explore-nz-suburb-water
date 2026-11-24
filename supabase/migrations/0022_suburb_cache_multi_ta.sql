-- LINZ suburbs can belong to more than one TA (186 nationally, e.g. "Tauranga City, Western Bay of Plenty District"), so the
-- shared cache is keyed by (suburb, TA); a fetch log records whether a TA's list is complete, so a fetch that failed part-way
-- is retried instead of being served as a partial list (docs/SPEC.md section 25).
alter table public.linz_suburb_index drop constraint if exists linz_suburb_index_pkey;
alter table public.linz_suburb_index add primary key (linz_id, ta_code);

create table if not exists public.linz_suburb_fetch (
  ta_code text primary key references public.territorial_authorities, started_at timestamptz not null, fetched_at timestamptz,
  features int not null default 0, complete boolean not null default false
);
alter table public.linz_suburb_fetch enable row level security;
create policy "viewers read" on public.linz_suburb_fetch for select to authenticated using (public.has_role('viewer'));
create policy "worker reads fetch log" on public.linz_suburb_fetch for select to worker using (true);
grant select on public.linz_suburb_fetch to worker;
grant select, insert, update on public.linz_suburb_fetch to service_role;
revoke all on public.linz_suburb_fetch from anon;

create or replace function public.edge_store_suburbs(p_ta text, p_fc jsonb) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare f jsonb; n int := 0;
begin
  for f in select * from jsonb_array_elements(p_fc -> 'features') loop
    insert into linz_suburb_index (linz_id, ta_code, name, name_ascii, type, major_name, geom, fetched_at)
    values ((f -> 'properties' ->> 'id')::int, p_ta, f -> 'properties' ->> 'name', f -> 'properties' ->> 'name_ascii', f -> 'properties' ->> 'type',
            f -> 'properties' ->> 'major_name',
            st_multi(st_simplifypreservetopology(st_transform(st_setsrid(st_geomfromgeojson(f ->> 'geometry'), 4326), 2193), 5)), now())
    on conflict (linz_id, ta_code) do update set name = excluded.name, name_ascii = excluded.name_ascii, type = excluded.type, geom = excluded.geom,
      major_name = excluded.major_name, fetched_at = now();
    n := n + 1;
  end loop;
  return n;
end $$;
-- start / finish a TA's fetch: only a finished fetch is served from the cache; rows not refreshed by it are removed
create or replace function public.edge_suburb_fetch(p_ta text, p_done boolean, p_features int default 0) returns void
language plpgsql security definer set search_path = public as $$
declare st timestamptz;
begin
  if not p_done then
    insert into linz_suburb_fetch (ta_code, started_at, complete) values (p_ta, now(), false)
      on conflict (ta_code) do update set started_at = now(), complete = false;
  else
    select started_at into st from linz_suburb_fetch where ta_code = p_ta;
    delete from linz_suburb_index where ta_code = p_ta and fetched_at < st;
    update linz_suburb_fetch set fetched_at = now(), features = p_features, complete = true where ta_code = p_ta;
  end if;
end $$;
revoke execute on function public.edge_suburb_fetch(text, boolean, int) from public, anon, authenticated;
grant execute on function public.edge_suburb_fetch(text, boolean, int) to service_role;
