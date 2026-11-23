# explore-nz-suburb-water

Explore NZ Suburb Water prepares suburb-level metadata for residential water-demand analysis anywhere in New Zealand. It assembles the explanatory variables of Ghavidelfar et al. (2018), except water consumption:
- sections, roofs, gardens and pools from LINZ data and aerial imagery;
- household size, income, bedrooms, tenure and dwelling type from the Stats NZ census;
- daily climate from Open-Meteo;
- water charges.

Results export in the formats of the original `suburb_lookup.html` reference builder, plus a panel for modelling.

**The app does not store or process water consumption.** Join your own consumption data to the exports using `M_SUBURB`, `PRVDR` or SA2 code.

## Status
- **Specification:** [`docs/SPEC.md`](docs/SPEC.md), covering architecture, data model, workflows, exports, Supabase project and Google sign-in setup, and milestones.
- **Database:** a draft migration is in [`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql). No Supabase project exists yet (SPEC section 12).
- **Source index:** [`index/`](index/) has, for all 67 TAs served by the 64 water providers, every API request needed to prepare that region (1,002 templates; nothing executed). Regenerate with `tools/build_source_index.py`.
- **Back-end:** a Python worker ([`backend/`](backend/), SPEC section 17). Hosted on GitHub Actions ([`docs/examples/worker.yml`](docs/examples/worker.yml)), one region per run.
- **Usage limits:** the app runs on the free keys of every service, one region at a time. There are no national runs. Budgets, pacing and throttling (Retry-After, backoff, circuit breaker) are enforced by [`backend/nzsw/limits.py`](backend/nzsw/limits.py) (SPEC section 20).
- **Validation pack:** labellers export flagged imagery tiles plus an outcome template and schema, and import completed outcome files (SPEC section 19).
- **Static demo:** [`demo/`](demo/) exemplifies the full spec without the stack, using the Taupō and Tauranga pilot data. Sign-in and roles are simulated, and exports are generated in the browser.
  - Live: https://water-rha-nz.github.io/explore-nz-suburb-water/.
  - Locally: `python3 -m http.server -d demo 8000`, then open http://localhost:8000.

## Pilot results (Taupō 2023 and Tauranga 2025 imagery)
- **Pools:** 97–100% precision on validated chips. Estimated recall is 77% (Taupō) and 80% (Tauranga), so pool counts are a lower bound. Tauranga's deep-blue pools need the colour rule recalibrated.
- **Gardens:** the labeller rated all 90 sampled sections "about right".
- **Section area:** LINZ parcel polygons match legal survey areas within 1% for 98–99.5% of sections.

## Licences
- Code: **Apache-2.0** ([`LICENSE`](LICENSE)).
- Data, exports and labels: **CC BY 4.0** ([`LICENSE-DATA`](LICENSE-DATA)).
- Source credits are in [`ATTRIBUTION.md`](ATTRIBUTION.md): LINZ, Stats NZ, Open-Meteo / Copernicus.
