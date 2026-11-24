-- Labelling items for every prepared region (docs/SPEC.md section 28). The worker samples accepted and rejected pool candidates
-- and garden sections after imagery; each item carries its NZTM centre, section outline and the public LINZ tile it lies in, so
-- the app cuts the image chip in the browser from the public tile (no private chip uploads needed).
alter table public.validation_items
  add column if not exists region_id text references public.regions on delete cascade,
  add column if not exists x double precision,
  add column if not exists y double precision,
  add column if not exists cog_url text,
  add column if not exists outline jsonb;
create index if not exists validation_items_region on public.validation_items (region_id);

-- labelling progress and quality for a region, aggregated over all labellers (counts only: no per-person rows)
create or replace function public.validation_tally(p_region text) returns jsonb
language sql stable security definer set search_path = public as $$
  select case when public.has_role('viewer') and public.region_visible(p_region) then jsonb_build_object(
    'items', coalesce((select jsonb_object_agg(k, n) from (select task || ':' || coalesce(tool_verdict, '') k, count(*) n
                         from validation_items where region_id = p_region group by 1) a), '{}'::jsonb),
    'labels', coalesce((select jsonb_object_agg(k, n) from (select v.task || ':' || coalesce(v.tool_verdict, '') || ':' || l.label k, count(*) n
                         from validation_items v join validation_labels l on l.item_id = v.id where v.region_id = p_region group by 1) b), '{}'::jsonb))
  end;
$$;
revoke all on function public.validation_tally(text) from public, anon;
grant execute on function public.validation_tally(text) to authenticated;
notify pgrst, 'reload schema';
