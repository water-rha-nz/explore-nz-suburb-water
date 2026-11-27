-- 'partial': suburb metrics published early (after LINZ) while imagery, census or climate are still being prepared; editors can
-- explore it (viewers see published regions only, via region_visible). docs/SPEC.md section 39.
alter table public.regions drop constraint if exists regions_status_check;
alter table public.regions add constraint regions_status_check check (status in ('draft', 'processing', 'partial', 'published'));
