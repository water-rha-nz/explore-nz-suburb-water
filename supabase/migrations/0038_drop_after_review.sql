-- Building outlines are dropped only after the region's blind review is complete (docs/SPEC.md section 31): every review chip of
-- the region labelled by the second reviewer, and at least one chip. A nightly job drops outlines of regions that become eligible.
create or replace function public.drop_region_buildings(p_region text) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare n int;
begin
  if not exists (select 1 from imagery_tiles where region_id = p_region)
     or exists (select 1 from imagery_tiles where region_id = p_region and processed_at is null)
     or exists (select 1 from regions where id = p_region and buildings_dropped_at is not null) then return 0; end if;
  -- the blind review must be complete
  if not exists (select 1 from review_chips c join validation_items v on v.id = c.item_id where v.region_id = p_region)
     or exists (select 1 from review_chips c join validation_items v on v.id = c.item_id where v.region_id = p_region
                and not exists (select 1 from review_labels l where l.token = c.token and l.reviewer = 'second-reviewer')) then return 0; end if;
  delete from buildings b
  where exists (select 1 from sections s where s.region_id = p_region and s.geom && b.geom and st_intersects(s.geom, b.geom))
    and not exists (select 1 from sections s2 join regions r on r.id = s2.region_id
                    where s2.region_id <> p_region and r.buildings_dropped_at is null and s2.geom && b.geom and st_intersects(s2.geom, b.geom));
  get diagnostics n = row_count;
  update regions set buildings_dropped_at = now() where id = p_region;
  return n;
end $$;
select cron.schedule('nzsw-drop-reviewed', '15 14 * * *', 'select public.drop_region_buildings(id) from public.regions');
