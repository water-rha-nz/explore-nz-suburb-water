-- Batch configurations, shared LINZ suburb cache for validation, PRVDR per region (docs/SPEC.md section 25).

create table public.batch_configs (
  id bigserial primary key, name text not null, ta_codes text[] not null default '{}', keep_mode text not null default 'any',
  prvdr_by_ta jsonb not null default '{}'::jsonb,       -- {"021": "TDC", ...}
  files jsonb not null default '{}'::jsonb,             -- parsed rows of nz_suburb_map / _ref / _provider
  created_by uuid default auth.uid(), created_at timestamptz default now(), updated_at timestamptz default now()
);
alter table public.batch_configs enable row level security;
create policy "editors read configs" on public.batch_configs for select to authenticated using (public.has_role('editor'));
create policy "editors write own configs" on public.batch_configs for insert to authenticated with check (public.has_role('editor') and created_by = (select auth.uid()));
create policy "owners update configs" on public.batch_configs for update to authenticated using (created_by = (select auth.uid()) or public.has_role('admin'));
create policy "owners delete configs" on public.batch_configs for delete to authenticated using (created_by = (select auth.uid()) or public.has_role('admin'));
revoke all on public.batch_configs from anon;

-- LINZ suburbs per TA, fetched once by the linz-suburbs Edge Function and shared by everyone (validation + map)
create table public.linz_suburb_index (
  linz_id integer primary key, ta_code text not null references public.territorial_authorities, name text not null, name_ascii text,
  type text, major_name text, geom extensions.geometry(MultiPolygon, 2193), fetched_at timestamptz not null default now()
);
create index on public.linz_suburb_index (ta_code);
alter table public.linz_suburb_index enable row level security;
create policy "viewers read" on public.linz_suburb_index for select to authenticated using (public.has_role('viewer'));
revoke all on public.linz_suburb_index from anon;

alter table public.regions add column if not exists prvdr text references public.providers;

-- app: a TA's cached suburbs (names + simplified outlines) for validation and the map
create or replace function public.ta_suburbs(p_ta text, p_tol float default 20) returns jsonb
language sql stable security invoker set search_path = public, extensions as $$
  select jsonb_build_object('fetched_at', max(fetched_at), 'suburbs', coalesce(jsonb_agg(jsonb_build_object('id', linz_id, 'name', name,
         'name_ascii', name_ascii, 'type', type, 'geom', st_asgeojson(st_multi(st_simplifypreservetopology(geom, p_tol)), 0)::jsonb) order by name), '[]'::jsonb))
  from linz_suburb_index where ta_code = p_ta;
$$;
revoke execute on function public.ta_suburbs(text, float) from public, anon;
grant execute on function public.ta_suburbs(text, float) to authenticated;

-- Edge Function helpers (service role only): store fetched suburbs, count usage, pick the caller's key
create or replace function public.edge_store_suburbs(p_ta text, p_fc jsonb) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare f jsonb; n int := 0;
begin
  for f in select * from jsonb_array_elements(p_fc -> 'features') loop
    insert into linz_suburb_index (linz_id, ta_code, name, name_ascii, type, major_name, geom, fetched_at)
    values ((f -> 'properties' ->> 'id')::int, p_ta, f -> 'properties' ->> 'name', f -> 'properties' ->> 'name_ascii', f -> 'properties' ->> 'type',
            f -> 'properties' ->> 'major_name',
            st_multi(st_simplifypreservetopology(st_transform(st_setsrid(st_geomfromgeojson(f ->> 'geometry'), 4326), 2193), 5)), now())
    on conflict (linz_id) do update set name = excluded.name, name_ascii = excluded.name_ascii, type = excluded.type, geom = excluded.geom,
      ta_code = excluded.ta_code, fetched_at = now();
    n := n + 1;
  end loop;
  return n;
end $$;
create or replace function public.edge_add_usage(p_service text, p_cost numeric, p_owner text) returns numeric
language plpgsql security definer set search_path = public as $$
declare d text := to_char(now() at time zone 'utc', 'YYYY-MM-DD'); h text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24'); used numeric;
begin
  insert into api_usage (service, period, bucket, cost, key_owner) values (p_service, 'day', d, p_cost, p_owner)
    on conflict (service, period, bucket, key_owner) do update set cost = api_usage.cost + excluded.cost returning cost into used;
  insert into api_usage (service, period, bucket, cost, key_owner) values (p_service, 'hour', h, p_cost, p_owner)
    on conflict (service, period, bucket, key_owner) do update set cost = api_usage.cost + excluded.cost;
  return used;
end $$;
create or replace function public.edge_usage_today(p_service text, p_owner text) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(sum(cost), 0) from api_usage where service = p_service and period = 'day' and key_owner = p_owner
    and bucket = to_char(now() at time zone 'utc', 'YYYY-MM-DD');
$$;
create or replace function public.edge_user_key(p_user uuid, p_service text) returns text
language sql stable security definer set search_path = public, vault as $$
  select d.decrypted_secret from user_api_keys k join vault.decrypted_secrets d on d.id = k.secret_id where k.user_id = p_user and k.service = p_service;
$$;
create or replace function public.edge_user_role(p_user uuid) returns text
language sql stable security definer set search_path = public as $$
  select case when status = 'active' then role::text end from profiles where id = p_user;
$$;
revoke execute on function public.edge_store_suburbs(text, jsonb), public.edge_add_usage(text, numeric, text), public.edge_usage_today(text, text),
  public.edge_user_key(uuid, text), public.edge_user_role(uuid) from public, anon, authenticated;
grant execute on function public.edge_store_suburbs(text, jsonb), public.edge_add_usage(text, numeric, text), public.edge_usage_today(text, text),
  public.edge_user_key(uuid, text), public.edge_user_role(uuid) to service_role;
grant select, insert, update on public.linz_suburb_index to service_role;
