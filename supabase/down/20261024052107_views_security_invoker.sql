-- Revert views to default owner-privilege evaluation.

do $$
declare
  r record;
begin
  for r in
    select format('%I.%I', n.nspname, c.relname) as fqname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where c.relkind = 'v'
      and n.nspname = 'public'
      and c.relname in (
        'v_our_games',
        'v_our_shots',
        'v_our_shots_official',
        'v_brighton_games',
        'v_brighton_shots',
        'v_brighton_shots_official',
        'v_club_game_brighton',
        'mp_brighton_results'
      )
  loop
    execute format('alter view %s set (security_invoker = false)', r.fqname);
  end loop;
end;
$$;
