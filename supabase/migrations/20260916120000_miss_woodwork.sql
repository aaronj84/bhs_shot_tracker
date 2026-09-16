-- Allow woodwork miss directions on shots.

alter table public.shots drop constraint if exists shots_miss_direction_check;
alter table public.shots
  add constraint shots_miss_direction_check
  check (
    miss_direction is null
    or miss_direction in ('over', 'short', 'wide-left', 'wide-right', 'crossbar', 'post')
  );
