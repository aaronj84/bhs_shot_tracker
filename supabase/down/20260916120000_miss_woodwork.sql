-- Down: 20260916120000_miss_woodwork
-- Restores miss_direction to the pre-woodwork set.
-- Fails if rows already use crossbar/post.

alter table public.shots drop constraint if exists shots_miss_direction_check;
alter table public.shots
  add constraint shots_miss_direction_check
  check (
    miss_direction is null
    or miss_direction in ('over', 'short', 'wide-left', 'wide-right')
  );
