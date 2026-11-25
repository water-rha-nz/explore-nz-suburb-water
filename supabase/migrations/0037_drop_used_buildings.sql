-- Keep the database within the free plan (docs/SPEC.md section 31). LINZ building outlines are only needed while a region's
-- imagery is analysed (roof masks); roof areas per section are kept in section_imagery. Once every imagery tile of a region is
-- processed, its outlines are dropped (outlines also touching a region still in progress are kept). Re-running imagery for such
-- a region fetches the outlines it needs from LINZ per tile, in memory. A nightly compaction returns the freed space.
set local statement_timeout = '20min';
alter table public.regions add column if not exists buildings_dropped_at timestamptz;

create or replace function public.drop_region_buildings(p_region text) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare n int;
begin
  if not exists (select 1 from imagery_tiles where region_id = p_region)
     or exists (select 1 from imagery_tiles where region_id = p_region and processed_at is null) then return 0; end if;
  delete from buildings b
  where exists (select 1 from sections s where s.region_id = p_region and s.geom && b.geom and st_intersects(s.geom, b.geom))
    and not exists (select 1 from sections s2 join regions r on r.id = s2.region_id
                    where s2.region_id <> p_region and r.buildings_dropped_at is null and s2.geom && b.geom and st_intersects(s2.geom, b.geom));
  get diagnostics n = row_count;
  update regions set buildings_dropped_at = now() where id = p_region;
  return n;
end $$;
revoke all on function public.drop_region_buildings(text) from public, anon, authenticated;
grant execute on function public.drop_region_buildings(text) to worker;

-- regions whose imagery is already fully processed
select public.drop_region_buildings(r.id) from public.regions r
where exists (select 1 from public.imagery_tiles t where t.region_id = r.id)
  and not exists (select 1 from public.imagery_tiles t where t.region_id = r.id and t.processed_at is null);

-- compaction: deleted rows only become reusable space; VACUUM FULL gives it back (nightly 03:30 NZDT, and once shortly after this
-- migration). It briefly locks the table, so it runs when the worker is quiet.
create extension if not exists pg_cron;
select cron.schedule('nzsw-compact', '30 14 * * *', 'vacuum (full, analyze) public.buildings');
select cron.schedule('nzsw-compact-sections', '45 14 * * *', 'vacuum (full, analyze) public.sections');
select cron.schedule('nzsw-compact-soon', to_char((now() at time zone 'utc') + interval '6 minutes', 'MI HH24 DD MM') || ' *', 'vacuum (full, analyze) public.buildings');
