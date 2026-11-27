-- A provider's full tariff, where it publishes one (docs/SPEC.md section 36): e.g. Tiaki Wai's 2026/27 calculator parameters per city
-- (fixed, per $ of capital value, per m3, per SUIP, per pan). The app's billing estimator uses it.
alter table public.water_rates add column if not exists tariff jsonb;
notify pgrst, 'reload schema';
