# BrewTracker Pro — Operational Excellence Implementation Plan

## Primary goal

Operators can see who owns every brewery task, safely detect abnormal measurements, keep every vessel demonstrably clean, quantify where beer is lost, compare each beer against its normal fermentation behavior, and recover data after mistakes—without making the mobile workflow slower or ambiguous.

## Product decisions fixed by this plan

- Opening a notification **does not** accept a task. After operator PIN unlock, the operator explicitly taps **Pieņemt**; completion is a separate **Izpildīts** action.
- Task states are `todo`, `accepted`, `completed`, `postponed`, and `skipped`. Postponing and skipping require a reason; postponing also requires a new due time.
- Web Push remains for today/overdue work. The in-app **Darbi** timeline shows informational work three days ahead and all later predicted work.
- A free tank has two primary UI states: **Brīva · netīra** and **Brīva · tīra**. Cleaning history records `S` (sārms), `A` (akmensskābe), and `D` (dezinfekcija).
- Normal cleaning requires `S + D`; `A` may be omitted at most twice, so the third completed cleaning since the last acid cycle requires `S + A + D`. This is enforced server-side and remains configurable if the brewery SOP changes.
- Measurements outside hard physical/database limits remain rejected. Plausible but suspicious measurements require a warning confirmation and recorded reason.
- All canonical volumes are stored in liters. “Tonnas” remain a display convenience and are never silently equated to liters in calculations.
- Carbonation/manometer output is advisory and fail-closed: no pressure target appears until vessel limits, pressure basis, current CO₂, temperature, headspace, and expected terminal fermentation are known.
- Brewery operating baseline: a fully closed valve is observed to reach 2 bar and the vessels are operated as capable of 2 bar. Treat 2 bar as a configured operational ceiling, not certified MAWP evidence; a lower vessel/PRV/device limit always wins.
- The centrifuge liter counter records gross throughput, including beer/product and liquid discarded during discharge/solids cleaning. It is not a direct reading of beer received in Dzidra.
- Initial estimated residues: approximately 150 L remains in the boil kettle after each 2 t brew. Until measured values replace the estimate, use 300 L total kettle residue for a 4 t batch (two 2 t brews) and 600 L for an 8 t batch (four 2 t brews). Fermenter estimates remain 200 L in a 4 t fermenter and 350 L in an 8 t fermenter.
- Routine deletion becomes reversible soft deletion. Permanent purge is separate and requires a current export/backup.
- Monday backup is a persisted maintenance task. The browser cannot silently download a file; an operator explicitly downloads and acknowledges it.

## Phase 0 — Documentation discovery and allowed APIs

**How this serves the primary goal:** Every safety, identity, notification, and backup decision uses documented platform and brewing behavior instead of invented APIs or unsafe assumptions.

### Documentation and repository patterns to follow

- Supabase RLS: https://supabase.com/docs/guides/database/postgres/row-level-security
  - Enable RLS on every exposed table.
  - Prefer per-operation policies and indexes on policy columns.
  - Use secured `security definer` RPCs with `set search_path = ''`, schema-qualified objects, and explicit revoke/grant.
- Existing secure RPC patterns:
  - `supabase/migrations/202611230002_push_subscriptions.sql` — `register_push_subscription()`.
  - `supabase/migrations/202609150004_brite_tank_and_packaging.sql` — `finish_packaging_run()`.
  - `supabase/migrations/202609150002_operator_pin_functions.sql` — operator verification.
- Netlify Scheduled Functions: https://docs.netlify.com/build/functions/scheduled-functions/
  - `export const config = { schedule: "0 * * * *" }`.
  - Cron is UTC; continue making Riga-time decisions inside the handler.
  - Persist idempotency; do not rely on function memory.
- PWA Push and badge APIs:
  - https://developer.mozilla.org/en-US/docs/Web/API/Push_API
  - https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/How_to/Display_badge_on_app_icon
  - Use `navigator.setAppBadge(count)` only as progressive enhancement.
- Supabase backup behavior: https://supabase.com/docs/guides/platform/backups
  - Keep operator-readable exports separate from disaster-recovery dumps.
  - A data-bearing CLI dump requires `supabase db dump --remote=<project-ref> --data-only -f <file>`.
- Brewing/carbonation sources:
  - Brewers Association over-pressure guidance: https://www.brewersassociation.org/educational-publications/preventing-package-over-pressurization/
  - Pressure-rated vessel FAQ: https://www.brewersassociation.org/brewing-industry-updates/brewery-pressure-rated-vessels-faq/
  - Hop creep guidance: https://www.brewersassociation.org/educational-publications/hop-creep-technical-brief/
  - ASBC fermentation tracking templates: https://www.asbcnet.org/methods/tools/extras

### Allowed APIs and existing copy points

- Pure task logic: `src/domain.js` `getDailyTasks()` and `buildWorkTimeline()`.
- Measurement validators: `src/domain.js` `validateGravity()`, `validatePh()`, `validateTemperature()`, `validatePressure()`.
- Mobile forms/dialogs: `src/main.js` `submitMeasurement()`, `actionDialog()`, `filterToBriteDialog()`, `finishPackagingDialog()`.
- Tank cards: `src/main.js` `dashboard()` and `tankCard()`.
- Offline mapping: `src/store.js` and `src/sync.js` `fetchRemoteState()`/`syncEvent()`.
- Existing tables and brewery-scoped policies: `supabase/migrations/202609150001_initial_schema.sql`.
- Packaging and centrifuge fields: migrations `202609150004` and `202609150005`.
- Domain test fixture style: `tests/domain.test.js` and `tests/push-tasks.test.js`.

### Phase 0 verification checklist

- [ ] Confirm actual Supabase/Netlify plan limits before promising automatic backup retention.
- [ ] Photograph/read each vessel nameplate and PRV setting. The brewery reports 2 bar operation/full closure; certified MAWP and the exact gauge-vs-absolute basis remain to be confirmed.
- [x] Define the centrifuge counter: gross cumulative throughput including discharge/cleaning losses, not product output.
- [ ] Confirm whether `S + D` is always mandatory and whether Dzidra follows the same acid rule.
- [ ] Confirm whether kettle/tank readings are hot liters, cold liters, mass-derived tons, or estimates.

### Anti-pattern guards

- Do not treat notification opening as acceptance.
- Do not trust a browser-provided `operator_id` as proof of the PIN-selected person.
- Do not use a generic carbonation table as an operational pressure command.
- Do not assume free-tier dashboard backups are sufficient or restorable for this project.

## Phase 1 — Trusted operator session, audit, and reversible data foundation

Implementation status (2026-11-24): operator sessions and session-attributed synchronization are committed. Audit triggers, reversible batch trash/restore, and optimistic row versions are implemented locally in migration `202611240001_audit_soft_delete_versions.sql`; production migration and live conflict/restore verification remain pending before deployment.

**How this serves the primary goal:** Every acceptance, override, cleaning, deletion, and restoration is attributable to a real PIN-unlocked operator and recoverable after mistakes.

### What to implement

1. Add a short-lived `operator_sessions` model. A successful PIN verification returns an opaque token; store only its hash server-side, bind it to brewery/operator, and expire it after the work shift (recommended 12 hours).
2. Store the opaque session token in `sessionStorage`, never local storage. All new state-changing RPCs validate the token and derive the operator server-side.
3. Activate database audit history with row triggers for batches, measurements, process actions, packaging runs, tasks, cleanings, and volume events. Store `OLD`/`NEW`, operator, reason, and timestamp.
4. Add `deleted_at`, `deleted_by`, and `delete_reason` to operational entities. Replace ordinary hard delete with audited trash/restore RPCs.
5. Update uniqueness/index rules to ignore deleted records where appropriate. Keep permanent purge as a separate admin workflow.
6. Add optimistic `version` columns to mutable task/vessel records for conflict detection.

### Documentation references

- Copy the secured RPC structure from `register_push_subscription()` and `finish_packaging_run()`.
- Copy brewery-scoped policy structure from `202609150001_initial_schema.sql`, but use separate policies per operation.
- Use PostgreSQL row triggers with `OLD` and `NEW`; do not depend on frontend logging.

### Verification checklist

- [ ] A forged operator ID cannot accept or complete a task without a valid operator-session token.
- [ ] Expired operator sessions force PIN unlock.
- [ ] Every create/edit/soft-delete/restore produces an audit event.
- [ ] Soft-deleted rows disappear from normal UI and can be restored.
- [ ] Two devices editing the same version receive a conflict instead of silent last-write-wins.
- [ ] Add Supabase RLS tests under `supabase/tests/` and run `supabase test db` when the CLI project is linked.

### Anti-pattern guards

- Never store PINs or session tokens in audit JSON.
- Never let frontend-only audit records be the source of truth.
- Never physically delete routine mistakes.

## Phase 2 — Persisted work ownership, two-step completion, and escalation

**How this serves the primary goal:** Operators always know what is due, who owns it, and whether it was actually performed—without accidental acceptance from merely opening a notification.

### What to implement

1. Add `work_items`:
   - brewery, batch, type, due time, severity, status, owner, accepted/completed timestamps, postponed time, skip reason, source, source action, and version.
2. Add append-only `work_item_events` for `created`, `accepted`, `completed`, `postponed`, `skipped`, and `reopened` transitions.
3. Add an idempotent unique occurrence key so scheduled generation cannot duplicate the same task.
4. Create atomic RPCs:
   - `accept_work_item(session_token, work_item_id)` — compare-and-set `todo → accepted`.
   - `complete_work_item(...)` — links the real measurement/process action when applicable.
   - `postpone_work_item(...)` — requires new due time and reason.
   - `skip_work_item(...)` — requires reason.
5. Keep process actions as brewing facts. Work-item state must not replace `process_actions`.
6. Replace transient UI-only tasks gradually with persisted work items as the single source for the Darbi page and push sender.
7. Mobile card interaction:
   - First check/button: **Pieņemt**.
   - Second check/button: **Izpildīts**, opening the required measurement/action form.
   - Show `Pieņēma: Guntars 08:15` and `Izpildīja: Roberts 09:05`.
8. Escalation levels:
   - `info`: due within three days; in-app only.
   - `today`: due today; in-app + daily push.
   - `overdue`: due time passed and not completed/skipped; red UI + daily push until resolved.
9. Opening the push only navigates to the work item. It never changes state.
10. Persist notification deliveries with uniqueness on task, level, date, and subscription to prevent repeats.
11. Update app badge to unresolved today/overdue count where supported.

### Documentation references

- Derivation logic to migrate: `src/domain.js` `getDailyTasks()`/`buildWorkTimeline()`.
- Scheduled sender pattern: `netlify/functions/send-brew-alerts.mjs`.
- Push click behavior: `public/sw.js`.
- Netlify schedule/manual testing: official Scheduled Functions documentation from Phase 0.

### Verification checklist

- [x] Two operators attempting to accept simultaneously produce one owner, not two (row lock + version compare-and-set).
- [x] Push opening leaves status unchanged.
- [x] Completion records both accepting and completing operators.
- [x] Postpone/skip cannot save without a reason.
- [x] Info appears three days ahead but is not pushed.
- [x] Today and overdue notifications are sent at most once per configured notification day/device.
- [x] 8 t two-cycle filtering creates separate occurrence keys.
- [x] Offline task claims fail closed; a device cannot overwrite a newer server-side claim.

### Anti-pattern guards

- Do not auto-complete a task when the operator only opens its detail.
- Do not overwrite task state without an event record.
- Do not run hourly push without persisted delivery idempotency.

## Phase 3 — Measurement anomaly detection and confirmed overrides

**How this serves the primary goal:** Typing mistakes and unusual process changes are caught before they contaminate history or trigger the wrong brewery action.

### What to implement

1. Add a pure `detectMeasurementWarnings(draft, previous, recent, profile)` function returning codes, severity, Latvian explanation, and deltas.
2. Run all hard validation and warning detection before mutating a process action or offline queue. Refactor `submitMeasurement()` so the draft is atomic.
3. Initial configurable rules:
   - gravity increased more than 3 points from the preceding measurement;
   - pH outside 0–14 remains rejected; input such as `47` offers “Vai domāji 4.7?”;
   - temperature delta ≥5 °C warns and ≥10 °C is critical;
   - pressure outside vessel/profile operating band warns; above certified limit is rejected;
   - exact duplicate values within 15 minutes warn;
   - timestamp earlier than the latest record or materially in the future warns.
4. Warning modal shows previous/new values and requires **Labot** or **Tomēr saglabāt**. Critical overrides require a short reason.
5. Store warning codes, confirmed operator, confirmation timestamp, and reason with the measurement.
6. Show warning badges in measurement history and analytics; never hide overridden anomalies.
7. Add brewery settings for warning thresholds after the initial safe defaults are proven.

### Documentation references

- Extend validators in `src/domain.js:63-97` without weakening their hard limits.
- Refactor `src/main.js` `submitMeasurement()` before reusing dialog patterns.
- Extend measurement mapping in `src/sync.js` and migration constraints.

### Verification checklist

- [x] `1018 → 1040`, `pH 47`, +10 °C, excessive pressure, duplicate, old timestamp, and future timestamp each follow the correct path.
- [x] Canceling the warning creates neither measurement nor process action.
- [x] Confirmed override syncs offline/online exactly once and is auditable.
- [x] Missing optional values are not treated as zero.

### Anti-pattern guards

- Do not weaken database constraints to accommodate warnings.
- Do not silently “correct” user data.
- Do not save the associated action before warning confirmation.

## Phase 4 — Vessel dirty/clean lifecycle and S/A/D chemistry history

**How this serves the primary goal:** A vessel shown as available is demonstrably ready for beer, while cleaning chemistry and the mandatory acid cadence are simple to see and impossible to bypass accidentally.

### What to implement

1. Add current fermenter fields: `cleanliness_status`, `cleaned_at`, `cleaned_by`, `cleaning_version`.
2. Add `vessel_cleaning_cycles` with vessel, related batch, started/completed times/operators, `used_alkali`, `used_acid`, `used_disinfectant`, note, and status.
3. Separate vessel release from batch completion:
   - after the final planned filtering cycle, set `fermenter_released_at` and atomically mark the vessel dirty; do not wait for filtered volume to equal nominal batch volume because the expected fermenter heel is about 200 L (4 t) or 350 L (8 t);
   - allow the batch to continue in Dzidra/pildīšana;
   - replace the current active-batch uniqueness rule with a rule based on unreleased vessel assignment.
4. Free vessel card states:
   - red/brown **Brīva · netīra** with no “new batch” shortcut;
   - green **Brīva · tīra · S D** or **S A D** with the new-batch shortcut.
5. Tapping the clean toggle opens a short dialog; it is not a blind toggle. Capture chemicals, operator, and optional problem note.
6. Server-side completion RPC enforces:
   - `S + D` for clean state;
   - after two cycles without `A`, the third requires `S + A + D`;
   - active/occupied vessels cannot be toggled.
7. Starting a new batch is blocked in both UI and DB trigger unless the vessel is clean.
8. Decide and configure whether Dzidra uses the same rule; do not silently assume.

Decision: Dzidra uses the same S/D requirement and third-wash acid cadence as
fermentation vessels. Existing empty vessels are migrated as visibly labelled
`legacy_ready` so deployment does not invent a cleaning record or unexpectedly
stop brewing; their first status change starts the auditable cleaning history.
The UI labels this state **Brīva · gatava (pārnests statuss)**, never “tīra”.

### Documentation references

- Extend `fermenters` from migrations `202609150001` and `202609150004`.
- Extend `validate_batch_fermenter()` in `202609150004`.
- Place UI on `src/main.js` `tankCard()`.
- Reuse secured completion RPC style from `finish_packaging_run()`.

### Verification checklist

- [x] Final filter release marks the correct fermenter dirty even while Dzidra awaits packaging.
- [x] First 4 t cycle from an 8 t tank does not release or dirty the vessel.
- [x] Second cycle releases and dirties it exactly once.
- [x] Dirty vessel cannot receive a batch.
- [x] Clean dialog records S/A/D, operator, time, and note.
- [x] Third cleaning without acid is rejected until A is selected.
- [x] Toggle is absent while occupied.

### Anti-pattern guards

- Do not equate “no active batch” with “clean”.
- Do not store only the latest toggle; preserve cleaning history.
- Do not enforce the acid rule only in JavaScript.

## Phase 5 — Stage-by-stage beer volume and loss ledger

**How this serves the primary goal:** The brewery can identify whether beer was lost in the kettle, tank/yeast sediment, centrifuge, or packaging instead of blaming one combined unexplained difference.

### What to implement

1. [x] Add `volume_events` with batch, packaging cycle, stage, liters, timestamp, operator, source/device, measured/estimated flag, and note.
2. Minimum boundary stages:
   - post-boil kettle volume;
   - volume into fermenter;
   - pre-filter tank volume / sent to centrifuge;
   - centrifuge gross-throughput counter (includes discharge/cleaning liquid);
   - volume received in Dzidra;
   - packaged volume;
   - explicit kettle residue, tank/yeast residue, centrifuge reject where measured.
3. [x] Integrate fields into filtering, packaging dialogs, batch detail, and history without requiring unknown historical values.
4. Preserve raw values and derive only when both stage boundaries exist:
   - kettle loss;
   - fermentation/tank-bottom loss;
   - centrifuge loss;
   - packaging loss;
   - total yield and loss percentage.
5. Compute each 8 t filtering cycle independently, then aggregate; never subtract the same source volume twice.
6. [x] Add a loss-analysis view by beer. Operator comparison is intentionally not shown.
7. Seed editable estimated residue defaults:
   - boil kettle: 150 L after each 2 t brew/kettle cycle (fallback totals: 300 L for 4 t and 600 L for 8 t);
   - 4 t fermenter heel/yeast: 200 L;
   - 8 t fermenter heel/yeast: 350 L.
   Every derived result labels estimated versus measured inputs. A measured value overrides the default without deleting the estimate history.
8. Calculate vessel headspace from configured vessel nominal volume minus actual transferred beer volume. Prefer measured transfer/fill volume; fall back to brewed volume minus applicable estimated kettle residue and mark the result estimated.
9. Because the centrifuge counter includes discharge, derive product received only from an independent Dzidra-received reading. If available: `gross centrifuge throughput − Dzidra received = discharge/cleaning and other centrifuge-system difference`; do not label the entire difference as beer loss without confirming cleaning/water contributions.

### Documentation references

- Extend packaging patterns in migrations `202609150004`/`202609150005`.
- Extend `filterToBriteDialog()` and `finishPackagingDialog()`.
- Add new sync mapping branches in `src/sync.js`; current code handles only batch, measurement, action, and packaging run.

### Verification checklist

- [x] No loss is calculated when either boundary is missing.
- [ ] Hot and cold liters are not directly subtracted without an explicit correction policy.
- [ ] Historical unknowns remain null, never zero.
- [x] Estimated 150/200/350 L defaults are visibly labeled and never presented as measurements.
- [x] Centrifuge gross throughput is never displayed as Dzidra product volume.
- [x] Two-cycle 8 t totals are calculated as the sum of cycle inputs.
- [x] Derived stage differences use their own measured boundaries; centrifuge gross difference is clearly a system difference, not confirmed beer loss.

### Anti-pattern guards

- Do not use “tonnas” as an implicit liter conversion.
- Do not assume what the centrifuge meter measures.
- Do not rank operators by unnormalized raw losses.

## Phase 6 — Same-beer analytics, control bands, and safe carbonation advisory

**How this serves the primary goal:** The newest batch can be compared with a trustworthy normal process, while carbonation guidance remains useful without creating a vessel over-pressure hazard.

### What to implement

1. Add nullable daily-measurement `co2_vol`, measurement method/device, and data-quality flag.
2. Version beer process profiles. Compare only the same canonical beer, profile version, volume class, yeast/process regime unless the operator explicitly broadens the comparison.
3. Align curves by elapsed time since wort entered the fermenter. Keep raw points immutable; generate a separate interpolated display series.
4. For gravity, pH, temperature, pressure, and CO₂ show:
   - newest batch highlighted;
   - previous four comparable batches;
   - all-history mean/median;
   - sample count and missingness;
   - provisional percentile/control band when at least five comparable batches exist.
5. Calculate:
   - gravity points/day;
   - pH change/day;
   - apparent attenuation: `(OG points − current points) / (OG points − 1000) × 100`;
   - predicted FG date from current slope plus same-beer history;
   - first day the newest batch materially leaves its normal band.
6. Use descriptive comparison at 2–4 batches, provisional bands at 5–9, and stronger baseline language only after more data. Never call a sparse estimate “normal quality”.
7. Carbonation advisory prerequisites per vessel/batch:
   - current measured dissolved CO₂, date, and method;
   - beer temperature and gravity;
   - validated expected terminal gravity or forced-fermentation result;
   - target CO₂;
   - actual beer volume and vessel total volume/headspace;
   - vessel MAWP/working pressure, PRV setting, spunding range;
   - gauge vs absolute pressure, site altitude, Dry Hop/hop-creep state.
   - configured operational ceiling of 2 bar from brewery practice, plus separately verified certified MAWP/PRV/device limits.
8. Carbonation calculations:
   - display CO₂ deficit and residual-fermentation estimate with assumptions;
   - use Brewers Association reference assumptions only in a tested advisory module;
   - cap/suppress output above configured vessel/hardware limits;
   - never recommend above 2 bar even if another input is missing or higher; once certified values are recorded, use the lowest of 2 bar, MAWP-derived operating limit, PRV limit, and spunding-device limit;
   - wording: **Ieteicamais mērķis — pārbaudi pret tvertnes SOP un kalibrētu manometru**.
9. If any prerequisite or safety limit is missing, show **Nepietiek datu drošam spiediena ieteikumam** rather than a guessed value.
10. Dry-hopped beer always shows a hop-creep/secondary-fermentation pressure warning.

### Documentation references

- Existing analytics placeholder: `src/main.js` `analyticsPage()`/`analysisBeerCard()`.
- Historical action averages: `src/domain.js` `calculateHistoryStats()`.
- BA over-pressure, pressure-vessel, and hop-creep sources from Phase 0.
- ASBC single-brand historian pattern from Phase 0.

### Verification checklist

- [ ] Curves align by elapsed day/time rather than array position or calendar date.
- [ ] Missing pH/pressure/CO₂ is excluded, not converted to zero.
- [ ] Latest + previous four + all-history average use only comparable profile versions.
- [ ] Rates and apparent attenuation match hand-calculated fixtures.
- [ ] No exact FG date appears when sample count/data coverage is insufficient.
- [ ] No pressure recommendation appears without every safety prerequisite.
- [ ] Recommendation never exceeds vessel, PRV, or device limit.
- [ ] Dry Hop triggers hop-creep warning.
- [ ] UI never claims matching curves prove ingredients caused a flavor difference.

### Anti-pattern guards

- Do not average measurements by row index.
- Do not hard-code ±2 SD as a universal quality pass/fail band.
- Do not treat target FG as guaranteed fermentable reserve.
- Do not calculate manometer pressure from target CO₂ and temperature alone.

## Phase 7 — Monday export task, restore workflow, and backup proof

**How this serves the primary goal:** Years of brewery history can be recovered after accidental changes or service failure, and operators receive a simple weekly habit instead of assuming backups exist.

### What to implement

1. Generate a recurring Monday maintenance work item: **Lejupielādēt nedēļas rezerves kopiju**.
2. Add authenticated export endpoint producing:
   - versioned relational JSON archive suitable for app restore;
   - human-friendly CSV files for batches, measurements, actions, packaging, cleanings, tasks, and volume events;
   - manifest with schema version, export time, row counts, and SHA-256 checksum.
3. Browser explicitly downloads the archive. After success, record checksum, time, operator, and file name; then complete the Monday task.
4. Add Settings pages for:
   - Download now;
   - export history;
   - trash and restore;
   - controlled JSON restore with dry-run validation and row-count preview.
5. Before permanent purge, require a recent verified export and typed confirmation.
6. Document separate admin disaster-recovery dump procedure using Supabase CLI `db dump --data-only`; do not call the browser archive a full Postgres backup.
7. Run a restore drill against a separate Supabase project before production restore is enabled.

### Documentation references

- Existing reset/data-version invalidation: `202611230001_reset_brewing_data.sql`.
- Supabase backup and CLI references from Phase 0.
- Use work-item recurrence from Phase 2, not a separate reminder subsystem.

### Verification checklist

- [ ] Monday task is generated once per week and can be acknowledged only after successful download.
- [ ] JSON export row counts match live database counts.
- [ ] Checksum detects a modified/corrupted archive.
- [ ] Restore dry run reports schema incompatibilities without writing.
- [ ] Test-project restore recreates relations and history correctly.
- [ ] Soft-deleted records and audit history are included according to documented policy.

### Anti-pattern guards

- Do not claim CSV is a restorable relational backup.
- Do not auto-download files in the background.
- Do not test restore first against production.

## Phase 8 — Integrated verification and staged rollout

**How this serves the primary goal:** The expanded application is proven safe in the exact mobile, offline, multi-operator, two-cycle, and pressure-sensitive workflows used by the brewery.

### What to implement and verify

1. Apply migrations in numbered order to a test Supabase project; retain rollback notes for each phase.
2. Run unit tests for task state transitions, warning rules, acid cadence, loss equations, analytics alignment, attenuation, and carbonation safety gates.
3. Run RLS/RPC tests with two breweries, invalid tokens, expired operator sessions, and forged operator IDs.
4. Run browser integration scenarios:
   - two operators claim the same task;
   - offline measurement with warning, reconnection, and no duplicate;
   - 8 t batch through two filter/package cycles;
   - vessel becomes dirty only after all beer leaves;
   - third cleaning requires acid;
   - Monday export and restore dry run;
   - push open does not accept work.
5. Test installed Chrome PWA on desktop and Android/iOS-supported paths. Badge remains optional when unsupported.
6. Pilot each phase with one or two operators for at least one real batch before enabling the next phase.
7. Add feature flags so task persistence, anomaly confirmation, cleaning enforcement, loss ledger, and carbonation advisory can be enabled independently.
8. Update README, operator quick guide, migration guide, and emergency recovery guide after each release.

### Documentation references

- Re-run every platform and brewing reference listed in Phase 0 before the corresponding final safety test.
- Reuse test fixture patterns from `tests/domain.test.js` and `tests/push-tasks.test.js`.
- Use Netlify Scheduled Functions “Run now” and logs for published push verification.
- Use Supabase RLS test workflow and a separate test project for restore evidence.

### Final verification checklist

- [ ] `npm test` and `npm run build` pass.
- [ ] Supabase RLS tests pass.
- [ ] No service/secret key exists in browser bundle or Git history.
- [ ] No task changes state merely from push navigation.
- [ ] No dirty vessel can receive a batch.
- [ ] No anomaly override lacks operator/time/reason where required.
- [ ] No loss metric is shown from missing boundaries.
- [ ] No pressure setpoint is shown without safety inputs or above hardware limits.
- [ ] A complete export can be restored in a separate project.
- [ ] Production rollout evidence records real-device, real-operator success.

### Anti-pattern guards

- Do not deploy every phase simultaneously.
- Do not make unverified safety calculations operational.
- Do not claim offline, push, restore, or multi-operator correctness without scenario evidence.

## Explicitly deferred

- QR codes on tanks.
- Direct sensor/hardware integration.
- Full BeerSmith recipe and inventory duplication.
- Ingredient-lot root-cause tracking.
- Email notifications beyond the current Web Push scope.
- Automatic valve control.
- Operator performance ranking.
- Fully automatic cloud/off-site backup storage; Phase 7 begins with explicit verified download.
