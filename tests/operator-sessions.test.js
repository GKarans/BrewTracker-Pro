import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL("../supabase/migrations/202611230003_operator_sessions.sql", import.meta.url);
const syncUrl = new URL("../src/sync.js", import.meta.url);
const mainUrl = new URL("../src/main.js", import.meta.url);

describe("operator session migration", () => {
  it("stores only a SHA-256 token hash and expires sessions after 12 hours", async () => {
    const sql = await readFile(migrationUrl, "utf8");

    expect(sql).toContain("token_hash text not null unique");
    expect(sql).not.toMatch(/session_token\s+text[^)]*not null/i);
    expect(sql).toContain("interval '12 hours'");
    expect(sql).toContain("extensions.digest(raw_token, 'sha256')");
  });

  it("keeps the table private and exposes authenticated RPC helpers", async () => {
    const sql = await readFile(migrationUrl, "utf8");

    expect(sql).toContain("alter table public.operator_sessions enable row level security");
    expect(sql).toContain("revoke all on public.operator_sessions from anon, authenticated");
    expect(sql).toMatch(/grant execute on function public\.create_operator_session\(uuid,\s*text\)/);
    expect(sql).toMatch(/public\.validate_operator_session\(text\)[\s\S]*to authenticated/);
  });

  it("rate limits PIN guesses and revokes sessions on PIN change", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql).toContain("operator_auth_attempts");
    expect(sql).toContain("recent_failures >= 5");
    expect(sql).toContain("interval '15 minutes'");
    expect(sql).toMatch(/change_operator_pin_with_session[\s\S]*update public\.operator_sessions set revoked_at = now\(\)/);
  });

  it("blocks direct authenticated writes and derives attribution from a session", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql).toContain("acting_operator_id := public.validate_operator_session(session_token)");
    expect(sql).toContain("acting_operator_id <> expected_operator_id");
    expect(sql).toContain("revoke insert, update, delete on public.breweries, public.fermenters, public.operators, public.beer_types");
    expect(sql).toContain("Measurement belongs to another batch");
    expect(sql).toContain("Packaging run belongs to another batch");
    expect(sql).toContain("public.measurements.batch_id=excluded.batch_id");
    expect(sql).toContain("public.packaging_runs.batch_id=excluded.batch_id");
    expect(sql).toContain("get diagnostics affected_rows = row_count");
    expect(sql).toContain("Batch number does not match year, sequence, and fermenter");
    expect(sql).toContain("Fermenter not found in this brewery");
    expect(sql).toContain("public.sync_operator_event(text,uuid,text,text,jsonb) to authenticated");
  });

  it("routes browser synchronization through the trusted RPC only", async () => {
    const sync = await readFile(syncUrl, "utf8");
    expect(sync).toContain('event.workItemId ? "sync_operator_work_event" : "sync_operator_event_v2"');
    expect(sync).not.toMatch(/supabase\.from\("(?:batches|beer_types|measurements|process_actions|packaging_runs)"\)\.(?:upsert|update|delete|insert)/);
    expect(sync).not.toMatch(/operator_id:\s*item\.operatorId/);
  });

  it("revokes browser sessions and escapes operator-controlled HTML", async () => {
    const main = await readFile(mainUrl, "utf8");
    expect(main).toContain('supabase.rpc("revoke_operator_session"');
    expect(main).toContain("escapeHtml(operator.name)");
    expect(main).toContain("escapeHtml(currentOperator()?.name");
    expect(main).toContain("escapeHtml(task.beerName)");
    expect(main).toContain("operatorId: state.activeOperatorId");
  });
});
