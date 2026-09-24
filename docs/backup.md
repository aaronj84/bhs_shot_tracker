# Database backups (PROD)

Logical dumps of the remote Postgres database: roles, schema, table data, and `supabase_migrations` history. The live site is a **public** GitHub repo, so CI never uploads a plaintext dump.

## On demand (laptop)

Docker must be running (`supabase db dump` uses a container). You must be logged in (`supabase login`) or have `SUPABASE_ACCESS_TOKEN`.

```bash
export SUPABASE_DB_PASSWORD_PROD='your-prod-db-password'
./scripts/backup-db.sh --env prod
# or: npm run backup:prod
```

Writes `backups/bhs-shot-tracker-prod-<UTC>.tar.gz` (gitignored). Optional `--encrypt` if you want the same AES archive CI produces.

## On demand (GitHub)

Actions → **Backup PROD** → **Run workflow**. Download the `prod-db-backup-…` artifact (`.tar.gz.enc`).

## Automatic

| When | What |
| --- | --- |
| PR targeting `main` | Encrypted PROD dump, uploaded as a workflow artifact (90 days) |
| Merge to `main` that applies migrations | Same dump **again**, then `npm run db:up` to PROD |

That second dump is the “old database before the new schema” snapshot. If the backup job fails, migrations do not run.

Optional: protect `main` and require the **Backup PROD** check so a PR cannot merge without a successful dump.

## Decrypt a CI artifact

Passphrase is `BACKUP_ENCRYPTION_KEY` if you set that secret; otherwise the PROD database password.

```bash
export BACKUP_ENCRYPTION_KEY='…'   # or SUPABASE_DB_PASSWORD_PROD
./scripts/backup-db.sh --decrypt ~/Downloads/bhs-shot-tracker-prod-YYYYMMDD-HHMMSSZ.tar.gz.enc
tar -tzf backups/bhs-shot-tracker-prod-YYYYMMDD-HHMMSSZ.tar.gz   # or wherever the .tar.gz landed
```

## Restore

Prefer restoring into a **new** Supabase project or empty database, not live PROD, until you have verified the dump.

1. Get a session-pooler (port **5432**) connection string from the target project’s **Connect** dialog. Percent-encode the password.
2. Unpack the archive (`MANIFEST.txt` repeats these commands).
3. Restore:

```bash
psql --single-transaction --variable ON_ERROR_STOP=1 \
  --file roles.sql \
  --file schema.sql \
  --command 'SET session_replication_role = replica' \
  --file data.sql \
  --dbname "$SUPABASE_DB_URL"

psql --single-transaction --variable ON_ERROR_STOP=1 \
  --file history_schema.sql \
  --file history_data.sql \
  --dbname "$SUPABASE_DB_URL"
```

If `roles.sql` errors on a hosted project (reserved roles), restore schema + data only, then the history files.

Supabase dashboard **PITR / daily backups** (paid) are a separate safety net; this archive is the one you control.

## Secrets

| Secret | Required |
| --- | --- |
| `SUPABASE_ACCESS_TOKEN` | Yes (already used for migrate) |
| `SUPABASE_PROJECT_REF_PROD` | Yes (defaults in the script if unset locally) |
| `SUPABASE_DB_PASSWORD_PROD` | Yes |
| `BACKUP_ENCRYPTION_KEY` | Optional; CI falls back to the DB password |
