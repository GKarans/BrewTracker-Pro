import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { BACKUP_SCHEMA_VERSION, canonicalJson, createBackupArchive, archivePayload, toCsv, validateBackupArchive } from "../src/backup.js";

const emptyEntities = () => Object.fromEntries([
  "beer_types", "fermenters", "operators", "batches", "measurements", "process_actions", "packaging_runs",
  "work_items", "work_item_events", "vessel_cleaning_cycles", "vessel_cleaning_events", "volume_events",
  "batch_carbonation_advisories", "audit_log",
].map((name) => [name, []]));

describe("backup archive", () => {
  it("creates a versioned archive with counts and a checksum", async () => {
    const entities=emptyEntities(); entities.batches=[{ id:"batch-1" }];
    const archive=await createBackupArchive({ brewery:{id:"brewery-1",name:"Labietis"},entities,exportedAt:new Date("2026-11-24T08:00:00Z") });
    expect(archive.schemaVersion).toBe(BACKUP_SCHEMA_VERSION);
    expect(archive.manifest.rowCounts.batches).toBe(1);
    expect(archive.manifest.payloadChecksum).toMatch(/^[0-9a-f]{64}$/);
    expect((await validateBackupArchive(archive,"brewery-1")).valid).toBe(true);
  });

  it("detects modified or foreign archives without writing any data", async () => {
    const archive=await createBackupArchive({ brewery:{id:"other",name:"Cita"},entities:emptyEntities() });
    archive.entities.batches.push({id:"changed"});
    const result=await validateBackupArchive(archive,"current");
    expect(result.valid).toBe(false);
    expect(result.foreignBrewery).toBe(true);
  });

  it("produces CSV with quoted JSON values", () => {
    const csv=toCsv([{id:"1",nested:{reason:"test"}}]);
    expect(csv).toContain('"nested"');
    expect(csv).toContain('"{""reason"":""test""}"');
  });

  it("uses session-attributed metadata RPCs and never stores sensitive tables", async () => {
    const sql=await readFile(new URL("../supabase/migrations/202611240006_backup_exports.sql",import.meta.url),"utf8");
    const main=await readFile(new URL("../src/main.js",import.meta.url),"utf8");
    const backup=await readFile(new URL("../src/backup.js",import.meta.url),"utf8");
    expect(sql).toContain("public.validate_operator_session(session_token)");
    expect(sql).toContain("record_backup_restore_dry_run");
    expect(backup).toContain("operator_sessions\", \"operator_auth_attempts\", \"push_subscriptions\"");
    expect(main).toContain("backup:${monday}");
    expect(main).toContain("validation_only_no_write");
    expect(main).not.toContain("restore_backup_replace_production");
  });

  it("provides a checksum-bound restore route limited to an empty test brewery", async () => {
    const sql=await readFile(new URL("../supabase/migrations/202611240007_restore_to_empty_test_brewery.sql",import.meta.url),"utf8");
    const main=await readFile(new URL("../src/main.js",import.meta.url),"utf8");
    const archive=await createBackupArchive({ brewery:{id:"source",name:"Labietis"},entities:emptyEntities() });
    expect(canonicalJson(archivePayload(archive))).toContain('"format":"brewtracker-pro-backup"');
    expect(sql).toContain("restore_backup_to_empty_test_brewery");
    expect(sql).toContain("ATJAUNOŠANA_BLOĶĒTA: mērķa darītava nav tukša");
    expect(sql).toContain("is_restore_test_target boolean not null default false");
    expect(sql).toContain("mērķa darītava nav atzīmēta kā testa vide");
    expect(sql).toContain("extensions.digest(convert_to(canonical_payload,'UTF8'),'sha256')");
    expect(sql).toContain("confirmation <> 'ATJAUNOT TESTĀ'");
    expect(sql).toContain("app.restore_import");
    expect(sql).toContain("historical finished batches");
    expect(main).toContain("ATJAUNOT TESTĀ");
    expect(main).toContain("restore_backup_to_empty_test_brewery");
  });

  it("keeps Monday's brewery-wide backup task visible without a batch", async () => {
    const main=await readFile(new URL("../src/main.js",import.meta.url),"utf8");
    expect(main).toContain('item.batch || item.type === "backup"');
  });
});
