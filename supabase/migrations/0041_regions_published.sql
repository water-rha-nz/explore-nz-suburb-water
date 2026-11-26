-- Regions whose suburb metrics have been published count as prepared (docs/SPEC.md section 30): the worker now sets
-- regions.status = 'published' when it publishes a region; this marks the regions already published before that change.
update public.regions r set status = 'published'
where status is distinct from 'published'
  and exists (select 1 from public.suburb_metrics m where m.region_id = r.id and coalesce(m.sections, 0) > 0);
