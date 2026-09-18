-- Down: 20260831100002_explore
-- Removes the Explore RPC and schema wrappers.

drop function if exists public.explore_readonly(text);
drop schema if exists explore cascade;
