-- Stable secret token per itinerary for calendar subscribe feeds
-- (GET /functions/v1/club-itinerary-ics/<token>.ics). Calendar apps use the
-- URL as the only credential — no JWT.

alter table public.club_itineraries
  add column if not exists feed_token text;

update public.club_itineraries
set feed_token = encode(gen_random_bytes(24), 'hex')
where feed_token is null or feed_token = '';

alter table public.club_itineraries
  alter column feed_token set default encode(gen_random_bytes(24), 'hex'),
  alter column feed_token set not null;

create unique index if not exists club_itineraries_feed_token_uidx
  on public.club_itineraries (feed_token);

comment on column public.club_itineraries.feed_token is
  '48-hex secret for club-itinerary-ics subscribe URL; rotate to revoke.';
