-- Down: 20261007160100_schedule_worker_cron
-- Stops the per-minute schedule worker job. Leaves pg_cron / pg_net installed.

select cron.unschedule(jobid) from cron.job where jobname = 'schedule-worker';
