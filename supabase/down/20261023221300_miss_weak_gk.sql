-- Down: 20261023221300_miss_weak_gk
-- Restores miss_direction to the pre-weak-gk set.
-- Fails if rows already use weak-gk.

alter table public.shots drop constraint if exists shots_miss_direction_check;
alter table public.shots
  add constraint shots_miss_direction_check
  check (
    miss_direction is null
    or miss_direction in ('over', 'short', 'wide-left', 'wide-right', 'crossbar', 'post')
  );
