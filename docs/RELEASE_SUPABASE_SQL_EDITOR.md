# BrewTracker Pro: Supabase release sequence

This document is the production release runbook for the Operational Excellence
features. Run it in the **production project's** Supabase SQL Editor only after
Netlify has finished building commit `1d6ec49` (or a later reviewed commit).

It does not delete production brew history. The reset/restore routines included
in the application are never invoked by these migration scripts.

## Important prerequisites

- Take a Supabase database backup first (Dashboard → Database → Backups, or a
  `supabase db dump` performed by an administrator).
- Keep the existing BrewTracker tab closed while the SQL is running. The old
  frontend must not write during the schema upgrade.
- Run each file **once, in the exact order below**. Do not use alphabetical
  ordering: there are two files with the `202611240005` prefix.
- Stop at the first SQL error. Do not continue with later files.

## 1. Preflight (read-only)

Run this query and save the results with the deployment notes:

```sql
select
  (select count(*) from public.breweries) as breweries,
  (select count(*) from public.operators) as operators,
  (select count(*) from public.batches) as batches,
  (select count(*) from public.measurements) as measurements,
  (select count(*) from public.packaging_runs) as packaging_runs;

select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name in ('breweries', 'operators', 'fermenters', 'batches', 'measurements', 'process_actions', 'packaging_runs')
order by table_name;
```

The second result must include all seven table names. If it does not, this is
not the expected BrewTracker database; stop.

## 2. Migration order

In SQL Editor, open a new query, paste the **whole content** of one listed file,
run it, and confirm success before moving to the next file:

1. `supabase/migrations/202611230003_operator_sessions.sql`
2. `supabase/migrations/202611240001_audit_soft_delete_versions.sql`
3. `supabase/migrations/202611240002_work_items.sql`
4. `supabase/migrations/202611240003_measurement_anomalies.sql`
5. `supabase/migrations/202611240004_vessel_cleaning_cycles.sql`
6. `supabase/migrations/202611240005_fermentation_analysis_and_carbonation.sql`
7. `supabase/migrations/202611240005_volume_loss_ledger.sql`
8. `supabase/migrations/202611240006_backup_exports.sql`
9. `supabase/migrations/202611240007_restore_to_empty_test_brewery.sql`

The application previously deployed the schema up to and including
`202611230002_push_subscriptions.sql`; do **not** rerun older migrations unless
the preflight establishes that this is a fresh, empty project.

### About retries

Some migrations are deliberately additive/idempotent, but this is not a license
to rerun a partially failed release. A failure can leave an `ALTER TABLE` or a
function change applied. Record the file and error, then inspect the database
before retrying it. Never run later files to "get past" an error.

## 3. Postflight smoke queries (read-only)

```sql
select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name in (
    'operator_sessions', 'operator_auth_attempts', 'audit_log',
    'work_items', 'work_item_events', 'work_notification_deliveries',
    'vessel_cleaning_cycles', 'vessel_cleaning_events', 'volume_events',
    'batch_carbonation_advisories', 'backup_exports',
    'backup_restore_drills', 'backup_restore_imports'
  )
order by table_name;

select routine_name
from information_schema.routines
where routine_schema = 'public'
  and routine_name in (
    'create_operator_session', 'sync_operator_event_v4',
    'sync_operator_work_event_v4', 'complete_vessel_cleaning',
    'record_backup_export', 'restore_backup_to_empty_test_brewery'
  )
order by routine_name;

select column_name
from information_schema.columns
where table_schema = 'public' and table_name = 'breweries'
  and column_name = 'is_restore_test_target';
```

All listed tables, routines, and `is_restore_test_target` must appear. Then
open the deployed app, sign in, choose an operator, and verify that no legacy
data is missing. Do not create a real batch merely for this smoke test.

## 4. Netlify release and live smoke test

After SQL succeeds, deploy the current `main` branch in Netlify. Then verify:

1. operator PIN unlock works;
2. an existing batch opens and its measurement history is visible;
3. a free vessel visibly shows its actual state (`gatava`, `tīra`, or `netīra`);
4. **Darbi** opens without accepting a task automatically;
5. **Iestatījumi → Analīze** loads without errors;
6. **Rezerves kopija** produces a JSON download and shows a checksum.

Use a temporary, clearly marked test entry only if a live write smoke test is
needed; remove it using the app's recovery flow, not direct SQL.

## 5. Restore drill — never in production

The restore implementation is intentionally restricted to a second, empty
Supabase test project/brewery. In that test project only, after creating its
brewery, have an administrator set:

```sql
update public.breweries
set is_restore_test_target = true
where id = '<TEST_BREWERY_UUID>';
```

The target must be empty and its UUID must differ from the export's source
brewery. The UI also requires the exact confirmation `ATJAUNOT TESTĀ`.
There is no production merge or replacement path. A successful drill records a
provenance row in `public.backup_restore_imports`.

## Static release check performed locally

The release sequence was checked for dependencies by reading the migration
definitions and their created/replaced functions. It has **not** been compiled
against a disposable Supabase instance because this checkout has no linked
project and Docker was unavailable. The test-project restore drill above is a
required release verification, not optional evidence.
