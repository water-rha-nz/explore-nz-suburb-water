-- Batch preparation of selected regions (docs/SPEC.md section 22): TA outlines for the selection map,
-- imagery tile index, batches of single-region jobs, and per-region suburb scope from the user's lists.

create table public.territorial_authorities (
  code text primary key, name text not null, name_ascii text not null, regional_council text,
  prvdrs text[], sa2_count int, run_parts int, geom extensions.geometry(MultiPolygon, 2193)
);
alter table public.territorial_authorities enable row level security;
create policy "viewers read" on public.territorial_authorities for select to authenticated using (public.has_role('viewer'));
create policy "worker rw" on public.territorial_authorities for all to worker using (true) with check (true);
grant select, insert, update on public.territorial_authorities to worker;

create table public.imagery_tiles (
  capture_id text references public.imagery_captures, tile_id text, region_id text references public.regions on delete cascade,
  cog_url text not null, stac_url text, geom extensions.geometry(Polygon, 2193), processed_at timestamptz,
  primary key (capture_id, tile_id, region_id)
);
alter table public.imagery_tiles enable row level security;
create policy "viewers read" on public.imagery_tiles for select to authenticated using (public.has_role('viewer') and public.region_visible(region_id));
create policy "worker rw" on public.imagery_tiles for all to worker using (true) with check (true);
grant select, insert, update, delete on public.imagery_tiles to worker;

create table public.batches (
  id bigserial primary key, name text, ta_codes text[] not null, keep_mode text default 'any' check (keep_mode in ('any', 'both')),
  status text default 'queued', created_by uuid default auth.uid(), created_at timestamptz default now()
);
alter table public.batches enable row level security;
create policy "editors batches" on public.batches for all to authenticated using (public.has_role('editor')) with check (public.has_role('editor'));
create policy "worker rw" on public.batches for all to worker using (true) with check (true);
grant select, update on public.batches to worker;

alter table public.jobs add column if not exists batch_id bigint references public.batches on delete set null;
-- scope: LINZ suburb names a region is limited to (null = whole TA), from nz_suburb_map / _ref / _provider
alter table public.regions add column if not exists ta_code text, add column if not exists scope text[], add column if not exists batch_id bigint references public.batches on delete set null;

-- regions in draft (being prepared) are visible to editors only, as before; viewers see published ones
create or replace function public.ta_outlines(p_tol float default 400)
returns jsonb language sql stable security invoker set search_path = public, extensions as $$
  select coalesce(jsonb_agg(jsonb_build_object('code', code, 'name', name, 'rc', regional_council, 'prvdrs', prvdrs,
           'sa2', sa2_count, 'parts', run_parts,
           'geom', st_asgeojson(st_multi(st_simplifypreservetopology(geom, p_tol)), 0)::jsonb) order by code), '[]'::jsonb)
  from territorial_authorities;
$$;
revoke execute on function public.ta_outlines(float) from public, anon;
grant execute on function public.ta_outlines(float) to authenticated;
revoke all on public.territorial_authorities, public.imagery_tiles, public.batches from anon;
