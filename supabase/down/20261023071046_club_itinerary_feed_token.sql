drop index if exists public.club_itineraries_feed_token_uidx;

alter table public.club_itineraries
  drop column if exists feed_token;
