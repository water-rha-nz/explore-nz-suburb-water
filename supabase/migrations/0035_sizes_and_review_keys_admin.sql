-- (1) Database size report: per-table sizes and row counts only (no data), for admins (Admin page) and the worker's public log.
-- (2) Review keys managed by admins: list (hash prefix only), add a key's SHA-256 (the key itself is made and shown once in the
--     admin's browser, never stored), revoke.
create or replace function public.db_sizes() returns jsonb
language sql stable security definer set search_path = public, pg_catalog as $$
  select case when public.has_role('admin') or current_user = 'worker' then jsonb_build_object(
    'database_bytes', pg_database_size(current_database()),
    'schemas', (select jsonb_object_agg(nspname, b) from (select n.nspname, sum(pg_total_relation_size(c.oid)) b from pg_class c join pg_namespace n on n.oid = c.relnamespace
                 where c.relkind in ('r', 'm') group by 1) s),
    'tables', (select jsonb_agg(t order by t.total desc) from (select c.relname as name, pg_total_relation_size(c.oid) total, pg_relation_size(c.oid) heap,
                 pg_indexes_size(c.oid) idx, coalesce(st.n_live_tup, 0) live_rows, coalesce(st.n_dead_tup, 0) dead_rows
                 from pg_class c join pg_namespace n on n.oid = c.relnamespace left join pg_stat_user_tables st on st.relid = c.oid
                 where n.nspname = 'public' and c.relkind in ('r', 'm') order by 2 desc limit 30) t))
  end;
$$;
revoke all on function public.db_sizes() from public, anon;
grant execute on function public.db_sizes() to authenticated, worker;

create or replace function public.admin_review_keys() returns table (hash_prefix text, label text, created_at timestamptz, revoked boolean)
language sql stable security definer set search_path = public as $$
  select left(sha256, 8), label, created_at, revoked from review_keys where public.has_role('admin') order by created_at;
$$;
create or replace function public.admin_add_review_key(p_sha256 text, p_label text) returns text
language plpgsql security definer set search_path = public as $$
begin
  if not public.has_role('admin') then raise exception 'admin only'; end if;
  if p_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'not a SHA-256 hash'; end if;
  insert into review_keys (sha256, label) values (p_sha256, left(coalesce(nullif(trim(p_label), ''), 'review key'), 60)) on conflict (sha256) do nothing;
  return left(p_sha256, 8);
end $$;
create or replace function public.admin_revoke_review_key(p_prefix text, p_revoked boolean default true) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not public.has_role('admin') then raise exception 'admin only'; end if;
  update review_keys set revoked = p_revoked where left(sha256, 8) = p_prefix; get diagnostics n = row_count; return n;
end $$;
revoke all on function public.admin_review_keys(), public.admin_add_review_key(text, text), public.admin_revoke_review_key(text, boolean) from public, anon;
grant execute on function public.admin_review_keys(), public.admin_add_review_key(text, text), public.admin_revoke_review_key(text, boolean) to authenticated;
notify pgrst, 'reload schema';
