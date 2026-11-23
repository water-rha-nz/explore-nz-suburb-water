-- Privacy (docs/SPEC.md section 26): users see only their own configurations, batches, jobs, runs, labels, exports and
-- key usage (plus shared project items); admins see everything. "created_by" columns are not readable by users.
-- Saved configurations never keep the raw contents of uploaded files, only the resulting suburb names per TA.

alter table public.batch_configs drop column if exists files;
alter table public.batch_configs add column if not exists scope_by_ta jsonb not null default '{}'::jsonb;   -- {"021": ["Taupō", ...]}

drop policy if exists "editors read configs" on public.batch_configs;
create policy "own configs" on public.batch_configs for select to authenticated using (created_by = (select auth.uid()) or public.has_role('admin'));

drop policy if exists "editors batches" on public.batches;
create policy "own batches" on public.batches for select to authenticated using (created_by = (select auth.uid()) or public.has_role('admin'));
create policy "editors create batches" on public.batches for insert to authenticated with check (public.has_role('editor') and created_by = (select auth.uid()));
create policy "own batches update" on public.batches for update to authenticated using (created_by = (select auth.uid()) or public.has_role('admin'));

drop policy if exists "editors jobs" on public.jobs;
create policy "own or project jobs" on public.jobs for select to authenticated
  using (public.has_role('editor') and (created_by = (select auth.uid()) or created_by is null) or public.has_role('admin'));
create policy "editors create jobs" on public.jobs for insert to authenticated with check (public.has_role('editor') and created_by = (select auth.uid()));
create policy "own jobs update" on public.jobs for update to authenticated using (created_by = (select auth.uid()) or public.has_role('admin'));

drop policy if exists "editors read runs" on public.job_runs;
create policy "runs of visible jobs" on public.job_runs for select to authenticated using (exists (select 1 from public.jobs j where j.id = job_runs.job_id));

drop policy if exists "own labels or editor" on public.validation_labels;
create policy "own labels or admin" on public.validation_labels for select to authenticated using (user_id = (select auth.uid()) or public.has_role('admin'));

drop policy if exists "own or editor exports" on public.exports;
create policy "own or admin exports" on public.exports for select to authenticated using (created_by = (select auth.uid()) or public.has_role('admin'));

drop policy if exists "editors read usage" on public.api_usage;
create policy "own or project usage" on public.api_usage for select to authenticated
  using (public.has_role('editor') and key_owner in ('project', (select auth.uid())::text) or public.has_role('admin'));

-- created_by is not readable by users (admins use the SQL editor / audit log)
revoke select on public.regions, public.batches, public.jobs, public.batch_configs, public.exports from authenticated;
grant select (id, name, territorial_authorities, suburb_names, imagery_captures, status, created_at, ta_code, scope, batch_id, prvdr) on public.regions to authenticated;
grant select (id, name, ta_codes, keep_mode, status, created_at) on public.batches to authenticated;
grant select (id, type, region_id, params, status, log, counts, created_at, finished_at, run_part, not_before, reason, batch_id) on public.jobs to authenticated;
grant select (id, name, ta_codes, keep_mode, prvdr_by_ta, scope_by_ta, created_at, updated_at) on public.batch_configs to authenticated;
grant select (id, region_id, as_of, format, storage_path, checksum) on public.exports to authenticated;

-- the rates setting must not carry who changed it
update public.app_settings set value = (select coalesce(jsonb_object_agg(k, v - 'reason'), '{}'::jsonb) from jsonb_each(value) as e(k, v)) where key = 'rates';
