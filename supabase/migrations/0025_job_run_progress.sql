-- Live feedback while a step runs: the worker writes a progress fraction, its latest log lines and a heartbeat every few
-- seconds (docs/SPEC.md section 17); the app's progress panel shows them.
alter table public.job_runs add column if not exists progress real;
alter table public.job_runs add column if not exists detail text;
alter table public.job_runs add column if not exists updated_at timestamptz;
