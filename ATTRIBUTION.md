# Attribution

This repository's **code** is licensed under Apache-2.0 (`LICENSE`).
Its **data**, including the demo data in `demo/data/`, exported datasets and validation labels, is licensed under **CC BY 4.0** (`LICENSE-DATA`).

The data is derived from the sources below, each licensed under Creative Commons Attribution 4.0 International (CC BY 4.0). Anyone reusing the data must keep these credits.

| Source | Data used | Credit |
|---|---|---|
| Toitū Te Whenua Land Information New Zealand (LINZ) | NZ Suburbs and Localities (layer 113764), NZ Primary Parcels (50772), NZ Property Titles (50804), NZ Building Outlines (101290) | "Sourced from the LINZ Data Service and licensed for reuse under CC BY 4.0." |
| LINZ aerial imagery (s3://nz-imagery) | Taupō 0.075m Urban Aerial Photos (2023); Tauranga 0.1m Urban Aerial Photos (2025), RGB + near-infrared | "Sourced from LINZ and licensed for reuse under CC BY 4.0." The supplier of each survey holds its copyright; see the LINZ imagery survey index. |
| Stats NZ (Tatauranga Aotearoa) | 2013, 2018 and 2023 Census tables (Aotearoa Data Explorer: CEN23_HOU_020, CEN23_FHH_038, CEN23_HOU_001, CEN23_HOU_018); Statistical Area 2 2023 boundaries (Datafinder layer 111206); regional council 2025 outlines | "Stats NZ and licensed by Stats NZ for reuse under CC BY 4.0." |
| Open-Meteo | Historical weather (daily rain, temperature, FAO ET0), best-match ERA5 / ERA5-Land | "Weather data by Open-Meteo.com (CC BY 4.0)", based on Copernicus Climate Change Service ERA5 reanalysis. Zippenfenig, P. (2023). Open-Meteo.com Weather API. Zenodo. https://doi.org/10.5281/ZENODO.7970649 |
| Water service providers | Published water and wastewater charges (Taupō District Council, Tauranga City Council) | Figures as published by each provider; source links are given in the data. |

**Method reference:** Ghavidelfar, S., Shamseldin, A. Y., & Melville, B. W. (2018). Evaluating spatial and seasonal determinants of residential water demand across different housing types through data integration. *Water International*, 43(7), 926–942. https://doi.org/10.1080/02508060.2018.1490878

**Notes**
- Open-Meteo's free API tier is for non-commercial use. Commercial deployments need an Open-Meteo API key.
- Derived pool and garden metrics are published only as suburb or SA2 aggregates (see `docs/SPEC.md` section 10).

Derived data © explore-nz-suburb-water contributors, licensed CC BY 4.0.
