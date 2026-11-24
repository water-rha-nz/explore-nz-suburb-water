-- Spatial index for imagery coverage checks (each residential section probes the region's tiles).
create index if not exists imagery_tiles_geom_idx on public.imagery_tiles using gist (geom);
create index if not exists imagery_tiles_region_idx on public.imagery_tiles (region_id);
