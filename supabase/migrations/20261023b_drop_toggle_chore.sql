-- After the new app (huis_set_chore) is deployed: remove the old toggle RPC (accepted non-strict booleans, no ordering guard)
drop function if exists public.huis_toggle_chore(bigint, text, boolean);
