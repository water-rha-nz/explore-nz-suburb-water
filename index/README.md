# Source index

`source_index.json` lists, for every territorial authority (TA) that has a water provider in the reference builder's water-rates table (67 TAs, 64 providers), **every API request needed to prepare that region**. They're stored as **templates**: generating the index calls no data API. The back-end worker (`docs/SPEC.md` section 17) resolves the placeholders and runs the requests when an editor queues a region.

| File | Contents |
|---|---|
| `source_index.json` | `meta` (layers, tables, run order, keys) and `regions[]`: TA, Stats NZ TA code, regional council, imagery folders, PRVDR, charging type, SA2 codes, `requests[]` |
| `regions.csv` | one row per TA: provider, region, SA2 count, imagery folders, number of requests |

Each request has `step`, `service`, `method`, `url`, `params` / `headers`, `auth`, `depends_on`, `paging` and `output`.

**Run order per TA**
1. `linz.suburbs`: LINZ suburbs filtered by TA name. This yields `{bbox_wgs84}` and the suburb points `{lat_list}` / `{lon_list}`.
2. `linz.parcels|titles|buildings|addresses`: by bbox, paged with `count` / `startIndex`, then clipped to the suburbs.
3. `statsnz.sa2[n]`: Datafinder SA2 2023 boundaries, in chunks of 150 SA2 codes.
4. `statsnz.ade.<DATAFLOW>[n]`: census tables for those SA2s, 2013 / 2018 / 2023, in chunks of 150.
5. `imagery.list[<folder>]` → `imagery.items`: pick the newest urban capture with an `rgbnir` band, then list its STAC items. Tiles intersecting buildings become a worker imagery job.
6. `climate.daily`: Open-Meteo archive per suburb point, at most 100 points per call, deduplicated by grid cell.
7. `water_rates.source`: provider pages for an editor to review. These aren't machine-parsed.

**Limits:** each TA has `run_parts`, contiguous SA2 groups of at most 80, with a heuristic cost estimate per part (`estimate.calls` per service). Only Auckland (8 parts), Christchurch (3) and Wellington City (2) need more than one part. Budgets, pacing and throttling are in `meta.limits` and `backend/nzsw/limits.py` (SPEC section 20). The index never implies a national run: parts are queued one at a time.

**Secrets:** `{LINZ_API_KEY}`, `{STATSNZ_DATAFINDER_KEY}` and `{STATSNZ_ADE_KEY}` are placeholders. They're filled from Supabase / worker secrets at run time and never written to the index, logs or exports.

**Regenerate** (needs the census geography code list, which is reference metadata; one call):
```bash
curl -H "Ocp-Apim-Subscription-Key: $STATSNZ_ADE_KEY" \
  https://api.data.stats.govt.nz/rest/codelist/STATSNZ/CL_CEN23_GEO_013/latest -o CL_CEN23_GEO_013.xml
python3 tools/build_source_index.py --lookup path/to/suburb_lookup.html --geo CL_CEN23_GEO_013.xml
```

**Caveats**
- The NZ Addresses layer ID (105689) should be verified before its first run.
- TAs crossing regional council boundaries search several imagery folders (Taupō, Rotorua, Waitomo, Rangitīkei, Tararua, Waitaki, Stratford).
- The Chatham Islands imagery folder name is unverified.
- `Hutt City` is matched to Stats NZ's `Lower Hutt City`, and the LINZ filter accepts both spellings.
- In the pilot, every SA2 the Taupō and Tauranga runs fetched appears in this index.
