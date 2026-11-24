import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL("../supabase/migrations/202611240001_audit_soft_delete_versions.sql", import.meta.url);
const syncUrl = new URL("../src/sync.js", import.meta.url);
const mainUrl = new URL("../src/main.js", import.meta.url);
const pushUrl = new URL("../netlify/functions/send-brew-alerts.mjs", import.meta.url);

describe("audited reversible history", () => {
  it("adds audit triggers, soft-delete metadata and optimistic versions", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql).toContain("create or replace function public.audit_operational_change()");
    expect(sql).toContain("add column if not exists deleted_at");
    expect(sql).toContain("add column if not exists version integer not null default 1");
    expect(sql).toContain("VERSION_CONFLICT");
    expect(sql).toContain("Delete reason is required");
    expect(sql).toContain("alter table public.beer_types");
    expect(sql).toContain("VERSION_CONFLICT: beer profile");
    expect(sql).toContain("array['beer_types','batches','measurements','process_actions','packaging_runs']");
    expect(sql).toContain("operation in ('insert', 'update', 'soft_delete', 'restore')");
  });

  it("routes writes through the versioned RPC and excludes deleted rows", async () => {
    const sync = await readFile(syncUrl, "utf8");
    expect(sync).toContain('event.workItemId ? "sync_operator_work_event_v4" : "sync_operator_event_v4"');
    expect(sync).toContain("expected_version: event.expectedVersion ?? event.expectedVersions?.batch ?? 0");
    expect(sync).toContain("filter((item) => !item.deleted_at)");
    expect(sync).toContain('supabase.rpc("list_deleted_batches"');
    expect(sync).toContain("deletedBatches = throwOnError(deleted)");
  });

  it("synchronizes a process and final packaging as atomic composite events", async () => {
    const [sql, sync, main] = await Promise.all([
      readFile(migrationUrl, "utf8"),
      readFile(syncUrl, "utf8"),
      readFile(mainUrl, "utf8"),
    ]);
    expect(sql).toContain("if entity_type = 'processBundle'");
    expect(sql).toContain("elsif entity_type = 'packagingCompletion'");
    expect(sql).toContain("rolls the whole operator action back");
    expect(sync).toContain('["processBundle", "packagingCompletion"]');
    expect(main).toContain('entity: "processBundle"');
    expect(main).toContain('entity: "packagingCompletion"');
  });

  it("offers restore and visible conflict recovery", async () => {
    const main = await readFile(mainUrl, "utf8");
    expect(main).toContain("data-restore-batch");
    expect(main).toContain("Šo ierakstu citā ierīcē jau mainīja");
    expect(main).toContain("Dzēšanas iemesls");
    expect(main).toContain('operation: "restore"');
    expect(main).toContain("isTransientSyncError");
    expect(main).toContain("reloadRemotePreservingQueue");
  });

  it("excludes soft-deleted data from scheduled push reminders", async () => {
    const push = await readFile(pushUrl, "utf8");
    expect(push).toContain('.is("deleted_at", null)');
    expect(push).toContain("filter((item) => !item.deleted_at)");
  });
});
