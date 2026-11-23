# Worker (Python)

This is the container that runs everything heavy or keyed: connectors (driven by `index/source_index.json`), imagery (pools and vegetation), census metrics, climate, aggregation, exports and validation packs. The design is in `docs/SPEC.md` section 17.

**Status:** the scaffold is in place: `Dockerfile` and pinned `requirements.txt`, matching the pilot. The `nzsw/` package is milestone M3–M4. It's a port of the pilot scripts (`connectors/*.py`, `detect.py`, `aggregate.py`, `valpack.py`) behind `nzsw.cli`:

```
nzsw run --ta "Taupo District" --steps linz,census,climate,imagery,aggregate   # one region
nzsw worker                                                                    # claim and run queued jobs
```

**Environment** (names in `.env.example`): `SUPABASE_DB_URL` (pooler connection for the `worker` role), `SUPABASE_URL`, `SUPABASE_STORAGE_KEY`, `LINZ_API_KEY`, `STATSNZ_ADE_KEY`, `STATSNZ_DATAFINDER_KEY`.

**Hosting:** GitHub Actions first (`docs/examples/worker.yml`), then Cloud Run Jobs for national runs.
