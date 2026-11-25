-- Learned pool check (docs/SPEC.md section 32). Review labels (labellers and the blind second reviewer) train a small per-capture
-- classifier in the worker (logistic regression on the measured candidate features). It scores every candidate (p_model); when it
-- beats the fixed rules on held-back labels its verdict (model_pool) replaces tool_pool in the published counts and the map.
-- Candidates it is least sure about are added as extra review items (tool_verdict 'uncertain', left out of precision/recall).
alter table public.pool_candidates add column if not exists p_model real, add column if not exists model_pool boolean;
create table if not exists public.pool_models (
  capture_id text primary key references public.imagery_captures on delete cascade,
  trained_at timestamptz default now(), n_train int, n_test int, applied boolean, coef jsonb, metrics jsonb);
alter table public.pool_models enable row level security;
create policy "viewers read" on public.pool_models for select to authenticated using (public.has_role('viewer'));
create policy "worker rw" on public.pool_models for all to worker using (true) with check (true);
grant select on public.pool_models to authenticated;
grant select, insert, update on public.pool_models to worker;
-- the worker reads labels to train (item and label only; who labelled is never read)
grant select (item_id, label) on public.validation_labels to worker;
create policy "worker reads labels" on public.validation_labels for select to worker using (true);
grant select on public.review_labels to worker;
create policy "worker reads review labels" on public.review_labels for select to worker using (true);
-- after a blind-review round of a region is complete, queue a retrain (model, then publish) unless a job is already waiting
create or replace function public.review_label(p_token uuid, p_reviewer text, p_label text) returns text
language plpgsql security definer set search_path = public as $$
declare t text; reg text;
begin
  select c.task, v.region_id into t, reg from review_chips c join validation_items v on v.id = c.item_id where c.token = p_token;
  if t is null then return 'unknown token'; end if;
  if (t = 'pool' and p_label not in ('pool', 'not_pool', 'water', 'unknown')) or (t = 'garden' and p_label not in ('over', 'about_right', 'under', 'unknown')) then
    return 'label not valid for a ' || t || ' chip'; end if;
  insert into review_labels (token, reviewer, label) values (p_token, p_reviewer, p_label)
    on conflict (token, reviewer) do update set label = excluded.label, labelled_at = now();
  if reg is not null
     and not exists (select 1 from review_chips c join validation_items v on v.id = c.item_id where v.region_id = reg
                     and not exists (select 1 from review_labels l where l.token = c.token and l.reviewer = p_reviewer))
     and not exists (select 1 from jobs where region_id = reg and status in ('queued', 'scheduled', 'running', 'paused_quota')) then
    insert into jobs (type, region_id, params, status) values ('retrain', reg, '{"steps": ["model", "publish"]}'::jsonb, 'queued');
    return 'ok; round complete: retrain queued';
  end if;
  return 'ok';
end $$;
create or replace function public.map_items(p_region text, p_x0 float, p_y0 float, p_x1 float, p_y1 float) returns jsonb
language sql stable security invoker set search_path = public, extensions as $$
  with box as (select st_makeenvelope(p_x0, p_y0, p_x1, p_y1, 2193) g
               where (p_x1 - p_x0) * (p_y1 - p_y0) <= 9e6),
  pools as (select p.id, st_x(p.geom) x, st_y(p.geom) y, round(p.area_m2) area
            from pool_candidates p join sections s on s.parcel_id = p.section_id, box
            where coalesce(p.model_pool, p.tool_pool) and s.region_id = p_region and p.geom && box.g limit 600),
  greens as (select st_x(st_pointonsurface(s.geom)) x, st_y(st_pointonsurface(s.geom)) y, round(max(si.veg_m2)) veg
             from sections s join section_imagery si on si.section_id = s.parcel_id, box
             where s.region_id = p_region and s.geom && box.g and si.veg_m2 > 0 group by s.parcel_id, s.geom limit 1500),
  chips as (select v.id, v.task, v.chip_path, v.tool_verdict,
                   st_x(coalesce(c.geom, st_pointonsurface(s.geom))) x, st_y(coalesce(c.geom, st_pointonsurface(s.geom))) y
            from validation_items v left join pool_candidates c on c.id = v.candidate_id left join sections s on s.parcel_id = v.section_id, box
            where v.chip_path is not null and coalesce(c.geom, st_pointonsurface(s.geom)) && box.g limit 150)
  select jsonb_build_object('pools', coalesce((select jsonb_agg(pools) from pools), '[]'::jsonb),
                            'greens', coalesce((select jsonb_agg(greens) from greens), '[]'::jsonb),
                            'chips', coalesce((select jsonb_agg(chips) from chips), '[]'::jsonb));
$$;

notify pgrst, 'reload schema';
