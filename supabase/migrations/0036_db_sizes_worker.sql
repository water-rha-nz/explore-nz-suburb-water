-- db_sizes() checked current_user, which inside a security definer function is the owner, so the worker got nothing. The worker
-- gets its own function; being allowed to execute it is the check.
create or replace function public.db_sizes_worker() returns jsonb
language sql stable security definer set search_path = public, pg_catalog as $$
  select jsonb_build_object(
    'database_bytes', pg_database_size(current_database()),
    'schemas', (select jsonb_object_agg(nspname, b) from (select n.nspname, sum(pg_total_relation_size(c.oid)) b from pg_class c join pg_namespace n on n.oid = c.relnamespace
                 where c.relkind in ('r', 'm') group by 1) s),
    'tables', (select jsonb_agg(t order by t.total desc) from (select c.relname as name, pg_total_relation_size(c.oid) total, pg_relation_size(c.oid) heap,
                 pg_indexes_size(c.oid) idx, coalesce(st.n_live_tup, 0) live_rows, coalesce(st.n_dead_tup, 0) dead_rows
                 from pg_class c join pg_namespace n on n.oid = c.relnamespace left join pg_stat_user_tables st on st.relid = c.oid
                 where n.nspname = 'public' and c.relkind in ('r', 'm') order by 2 desc limit 30) t));
$$;
revoke all on function public.db_sizes_worker() from public, anon, authenticated;
grant execute on function public.db_sizes_worker() to worker;
