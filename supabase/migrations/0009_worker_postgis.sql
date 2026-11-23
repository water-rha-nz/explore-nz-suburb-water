-- the worker writes geometries: it needs the PostGIS functions in the extensions schema
grant usage on schema extensions to worker;
