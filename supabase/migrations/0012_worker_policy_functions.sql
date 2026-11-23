-- viewer policies call has_role()/region_visible(); the worker must be able to evaluate them (they return false for it:
-- the worker has no signed-in user). Its access still comes only from its own 'worker rw' policies.
grant execute on function public.has_role(public.app_role) to worker;
grant execute on function public.region_visible(text) to worker;
