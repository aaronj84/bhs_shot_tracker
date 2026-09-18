-- Down: 20260918120000_assist_types_rebound_over_top
-- Restores assist types to pass/gap/cross.
-- Fails if rows already use rebound or over_the_top.

alter table public.shots drop constraint if exists shots_assist_type_check;
alter table public.shots
  add constraint shots_assist_type_check
  check (assist_type is null or assist_type in ('pass', 'gap', 'cross'));

alter table public.shots drop constraint if exists shots_second_assist_type_check;
alter table public.shots
  add constraint shots_second_assist_type_check
  check (
    second_assist_type is null
    or second_assist_type in ('pass', 'gap', 'cross')
  );
