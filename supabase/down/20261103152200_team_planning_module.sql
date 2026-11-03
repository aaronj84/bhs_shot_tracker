-- Down: 20261103152200_team_planning_module

alter table public.teams drop constraint if exists teams_modules_is_array;
alter table public.teams drop column if exists modules;
