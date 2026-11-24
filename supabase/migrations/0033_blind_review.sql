-- Blind second review of labelling chips (docs/SPEC.md section 29). The worker renders each labelling item's chip as a plain JPEG
-- (no georeferencing or metadata) under a random token. The review-chips Edge Function, opened by a single-purpose review key,
-- serves only token, task and image, and records the reviewer's label. Nothing here is readable by app users directly: only the
-- aggregated counts appear in validation_tally.
create table if not exists public.review_chips (
  token uuid primary key default gen_random_uuid(),
  item_id bigint not null unique references public.validation_items on delete cascade,
  task text not null check (task in ('pool', 'garden')),
  jpeg bytea not null,
  created_at timestamptz default now()
);
create table if not exists public.review_labels (
  token uuid not null references public.review_chips on delete cascade,
  reviewer text not null,
  label text not null check (label in ('pool', 'not_pool', 'water', 'unknown', 'over', 'about_right', 'under')),
  labelled_at timestamptz default now(),
  primary key (token, reviewer)
);
alter table public.review_chips enable row level security;
alter table public.review_labels enable row level security;
revoke all on public.review_chips, public.review_labels from anon, authenticated;
grant select, insert on public.review_chips to worker;
create policy "worker rw" on public.review_chips for all to worker using (true) with check (true);

-- the next unlabelled chips for a reviewer: token, task, base64 JPEG only (optionally one region or task)
create or replace function public.review_next(p_reviewer text, p_n int default 10, p_task text default null, p_region text default null)
returns table (token uuid, task text, jpeg_b64 text) language sql stable security definer set search_path = public as $$
  select c.token, c.task, encode(c.jpeg, 'base64') from review_chips c join validation_items v on v.id = c.item_id
  where (p_task is null or c.task = p_task) and (p_region is null or v.region_id = p_region)
    and not exists (select 1 from review_labels l where l.token = c.token and l.reviewer = p_reviewer)
  order by c.token limit least(greatest(coalesce(p_n, 10), 1), 20);
$$;
create or replace function public.review_label(p_token uuid, p_reviewer text, p_label text) returns text
language plpgsql security definer set search_path = public as $$
declare t text;
begin
  select task into t from review_chips where token = p_token;
  if t is null then return 'unknown token'; end if;
  if (t = 'pool' and p_label not in ('pool', 'not_pool', 'water', 'unknown')) or (t = 'garden' and p_label not in ('over', 'about_right', 'under', 'unknown')) then
    return 'label not valid for a ' || t || ' chip'; end if;
  insert into review_labels (token, reviewer, label) values (p_token, p_reviewer, p_label)
    on conflict (token, reviewer) do update set label = excluded.label, labelled_at = now();
  return 'ok';
end $$;
create or replace function public.review_left(p_reviewer text, p_region text default null) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('chips', count(*), 'labelled', count(l.token)) from review_chips c join validation_items v on v.id = c.item_id
  left join review_labels l on l.token = c.token and l.reviewer = p_reviewer where p_region is null or v.region_id = p_region;
$$;
revoke all on function public.review_next(text, int, text, text), public.review_label(uuid, text, text), public.review_left(text, text) from public, anon, authenticated;
grant execute on function public.review_next(text, int, text, text), public.review_label(uuid, text, text), public.review_left(text, text) to service_role;

-- validation counts now include the blind second review (aggregates only)
create or replace function public.validation_tally(p_region text) returns jsonb
language sql stable security definer set search_path = public as $$
  select case when public.has_role('viewer') and public.region_visible(p_region) then jsonb_build_object(
    'items', coalesce((select jsonb_object_agg(k, n) from (select task || ':' || coalesce(tool_verdict, '') k, count(*) n
                         from validation_items where region_id = p_region group by 1) a), '{}'::jsonb),
    'labels', coalesce((select jsonb_object_agg(k, n) from (select v.task || ':' || coalesce(v.tool_verdict, '') || ':' || l.label k, count(*) n
                         from validation_items v join validation_labels l on l.item_id = v.id where v.region_id = p_region group by 1) b), '{}'::jsonb),
    'second', coalesce((select jsonb_object_agg(k, n) from (select v.task || ':' || coalesce(v.tool_verdict, '') || ':' || l.label k, count(*) n
                         from validation_items v join review_chips c on c.item_id = v.id join review_labels l on l.token = c.token
                         where v.region_id = p_region group by 1) d), '{}'::jsonb),
    'chips', (select count(*) from review_chips c join validation_items v on v.id = c.item_id where v.region_id = p_region))
  end;
$$;
notify pgrst, 'reload schema';
