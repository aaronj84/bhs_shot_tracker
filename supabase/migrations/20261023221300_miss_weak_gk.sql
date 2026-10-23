-- Allow weak-to-goalkeeper as a miss direction (distinct from on-frame chances).

alter table public.shots drop constraint if exists shots_miss_direction_check;
alter table public.shots
  add constraint shots_miss_direction_check
  check (
    miss_direction is null
    or miss_direction in (
      'over',
      'short',
      'wide-left',
      'wide-right',
      'crossbar',
      'post',
      'weak-gk'
    )
  );
