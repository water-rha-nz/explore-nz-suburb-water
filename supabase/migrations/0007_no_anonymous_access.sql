-- Only signed-in users may use the API. RLS already filters every table; this also removes the anonymous
-- role's privileges so signed-out requests are refused before any policy runs.
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke all on all functions in schema public from anon;
alter default privileges for role postgres in schema public revoke all on tables from anon;
alter default privileges for role postgres in schema public revoke all on sequences from anon;
alter default privileges for role postgres in schema public revoke all on functions from anon;

-- every table in public must have RLS enabled (fails the migration if one was missed)
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' and not rowsecurity loop
    raise exception 'table public.% has row level security disabled', t;
  end loop;
end $$;
