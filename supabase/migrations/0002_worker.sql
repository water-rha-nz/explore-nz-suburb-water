-- Worker support (docs/SPEC.md section 17.3): run log, atomic job claim, least-privilege DB role.

-- job states for usage limits (SPEC section 20): scheduled (waiting for budget), paused_quota (throttled / budget used)
alter table jobs drop constraint if exists jobs_status_check;
alter table jobs add constraint jobs_status_check check (status in ('queued', 'scheduled', 'running', 'paused_quota', 'done', 'failed'));
alter table jobs add column if not exists run_part int default 1, add column if not exists not_before timestamptz, add column if not exists reason text;

-- per-service usage ledger (weighted cost per UTC day/hour), read by preflight and the limits client
create table api_usage (
  service text not null, period text not null check (period in ('day', 'hour')), bucket text not null,
  cost numeric not null default 0, bytes bigint not null default 0, primary key (service, period, bucket)
);
alter table api_usage enable row level security;
create policy "editors read usage" on api_usage for select using (has_role('editor'));

create table job_runs (
  id bigserial primary key, job_id bigint references jobs on delete cascade, step text, status text,
  started_at timestamptz default now(), finished_at timestamptz, counts jsonb, log text
);
alter table job_runs enable row level security;
create policy "editors read runs" on job_runs for select using (has_role('editor'));

-- claim the oldest queued job; safe with several workers
create or replace function claim_job() returns setof jobs language sql as $$
  update jobs set status = 'running'
  where id = (select id from jobs where status in ('queued', 'scheduled', 'paused_quota') and (not_before is null or not_before <= now())
              order by created_at for update skip locked limit 1)
  returning *;
$$;

-- least-privilege role for the worker (set its password in the dashboard; connect via the pooler)
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'worker') then create role worker login noinherit; end if;
end $$;
grant usage on schema public to worker;
grant select, insert, update on regions, suburbs, providers, sections, titles, buildings, water_rates, imagery_captures,
  section_imagery, pool_candidates, validation_items, sa2, census_values, census_metrics, climate_cells, suburb_climate_cell,
  climate_daily, jobs, job_runs, exports, api_usage to worker;
grant usage on all sequences in schema public to worker;
grant execute on function claim_job() to worker;
-- RLS stays on: give the worker role explicit policies on the tables it writes (no BYPASSRLS, no service-role key)
do $$
declare t text;
begin
  foreach t in array array['regions','suburbs','providers','sections','titles','buildings','water_rates','imagery_captures',
                           'section_imagery','pool_candidates','validation_items','sa2','census_values','census_metrics',
                           'climate_cells','suburb_climate_cell','climate_daily','jobs','job_runs','exports','api_usage'] loop
    execute format('create policy "worker rw" on %I for all to worker using (true) with check (true)', t);
  end loop;
end $$;
