-- Down: 20261019153038_assist_types_long_short
-- Restores assist types without long/short.
-- Fails if rows already use long or short.

alter table public.shots drop constraint if exists shots_assist_type_check;
alter table public.shots
  add constraint shots_assist_type_check
  check (
    assist_type is null
    or assist_type in ('pass', 'gap', 'cross', 'rebound', 'over_the_top')
  );

alter table public.shots drop constraint if exists shots_second_assist_type_check;
alter table public.shots
  add constraint shots_second_assist_type_check
  check (
    second_assist_type is null
    or second_assist_type in ('pass', 'gap', 'cross', 'rebound', 'over_the_top')
  );
