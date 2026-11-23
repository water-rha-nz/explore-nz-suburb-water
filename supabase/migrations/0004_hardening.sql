-- Hardening after the Supabase security/performance advisors (run on the empty database, 2026-11-23).

-- 1. Extensions out of the public (API-exposed) schema. PostGIS can't be relocated, so drop and recreate it
--    in `extensions` and re-add the geometry columns (all tables are still empty).
drop view if exists public.v_suburb_pools;
drop extension if exists postgis cascade;           -- drops the geom columns and their GiST indexes
create extension postgis schema extensions;
drop extension if exists pg_net;
create extension pg_net schema extensions;

alter table public.suburbs        add column geom extensions.geometry(MultiPolygon, 2193) not null;
alter table public.sections       add column geom extensions.geometry(MultiPolygon, 2193) not null;
alter table public.buildings      add column geom extensions.geometry(Polygon, 2193) not null;
alter table public.sa2            add column geom extensions.geometry(MultiPolygon, 2193);
alter table public.pool_candidates add column geom extensions.geometry(Point, 2193);
create index on public.suburbs   using gist (geom);
create index on public.sections  using gist (geom);
create index on public.buildings using gist (geom);
create index on public.sa2       using gist (geom);

create view public.v_suburb_pools with (security_invoker = true) as
select s.suburb_id as linz_id, c.id as capture_id,
       count(*) filter (where exists (select 1 from public.pool_candidates p where p.section_id = s.parcel_id and p.capture_id = c.id and p.tool_pool)) * 100.0
         / nullif(count(*), 0) as perc_pool,
       percentile_cont(0.5) within group (order by si.veg_m2) as gard_size,
       percentile_cont(0.5) within group (order by s.polygon_m2) as lot_size,
       percentile_cont(0.5) within group (order by si.building_m2) as footprint
from public.sections s
join public.section_imagery si on si.section_id = s.parcel_id
join public.imagery_captures c on c.id = si.capture_id
group by s.suburb_id, c.id;

-- 2. Functions: pin search_path; trigger functions are not callable through the API
alter function public.claim_job() set search_path = public;
revoke execute on function public.audit() from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
-- has_role is used inside RLS policies, so signed-in users must be able to execute it (it only reports
-- the caller's own role). Signed-out users get nothing: the app requires sign-in.
revoke execute on function public.has_role(public.app_role) from public, anon;
grant execute on function public.has_role(public.app_role) to authenticated;
revoke execute on function public.claim_job() from public, anon, authenticated;
grant execute on function public.claim_job() to worker;

-- 3. Evaluate auth.uid() once per query, not per row
drop policy "own profile" on public.profiles;
create policy "own profile" on public.profiles for select using (id = (select auth.uid()) or public.has_role('admin'));
drop policy "own labels or editor" on public.validation_labels;
create policy "own labels or editor" on public.validation_labels for select using (user_id = (select auth.uid()) or public.has_role('editor'));
drop policy "label own" on public.validation_labels;
create policy "label own" on public.validation_labels for insert with check (public.has_role('labeller') and user_id = (select auth.uid()));
drop policy "relabel own" on public.validation_labels;
create policy "relabel own" on public.validation_labels for update using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy "unlabel own" on public.validation_labels;
create policy "unlabel own" on public.validation_labels for delete using (user_id = (select auth.uid()));
drop policy "own or editor exports" on public.exports;
create policy "own or editor exports" on public.exports for select using (created_by = (select auth.uid()) or public.has_role('editor'));
drop policy "own or editor exports" on storage.objects;
create policy "own or editor exports" on storage.objects for select
  using (bucket_id = 'exports' and (owner = (select auth.uid()) or public.has_role('editor')));
