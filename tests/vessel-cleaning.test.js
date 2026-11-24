import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

const migrationUrl = new URL("../supabase/migrations/202611240004_vessel_cleaning_cycles.sql", import.meta.url);
const mainUrl = new URL("../src/main.js", import.meta.url);
const syncUrl = new URL("../src/sync.js", import.meta.url);

describe("vessel cleaning lifecycle", () => {
  it("releases a source fermenter after the final planned cycle despite the physical heel", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql).toContain("expected_cycles:=ceil(b.volume_tons/4.0)");
    expect(sql).toContain("if filtered_cycles>=expected_cycles and b.fermenter_released_at is null");
    expect(sql).toContain("'estimated_heel_liters',case when b.volume_tons>4 then 350 else 200 end");
    expect(sql).toContain("set fermenter_released_at=new.filtered_at");
    expect(sql).toContain("one_unreleased_batch_per_fermenter");
  });

  it("enforces S and D plus acid on the third wash", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql).toContain("if not used_alkali or not used_disinfectant");
    expect(sql).toContain("consecutive_acid_skips>=2 and not used_acid");
    expect(sql).toContain("Trešajā mazgāšanā obligāti vajag S, A un D");
    expect(sql).toContain("validate_operator_session(session_token)");
  });

  it("blocks dirty fermenters and Dzidra at the database boundary", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql).toContain("VESSEL_NOT_READY: tvertne ir netīra vai nav gatava");
    expect(sql).toContain("VESSEL_NOT_READY: Dzidra ir netīra vai nav gatava");
    expect(sql).toContain("if vessel.cleanliness_status='occupied'");
  });

  it("shows dirty and clean states without a new-batch shortcut on dirty vessels", async () => {
    const main = await readFile(mainUrl, "utf8");
    const sync = await readFile(syncUrl, "utf8");
    expect(main).toContain("Brīva · gatava");
    expect(main).toContain("pārnests statuss");
    expect(main).toContain("data-vessel-cleaning");
    expect(main).toContain("complete_vessel_cleaning");
    expect(main).toContain("!vesselIsReady(fermenterNumber)");
    expect(main).toContain("Jaunu partiju var sākt tikai tiešsaistē");
    expect(main).toContain("data-save-cleaning");
    expect(main).toContain("if (saved) dialog.close(\"saved\")");
    expect(main).toContain("aria-label=");
    expect(sync).toContain("consecutiveAcidSkips");
  });

  it("keeps cleaning history append-only and applies the same rule to Dzidra", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql).toContain("Cleaning history is append-only");
    expect(sql).toContain("vessel_cleaning_events");
    expect(sql).toContain("number=13");
    expect(sql).toContain("related_batch_id uuid,");
    expect(sql).toContain("batch_soft_delete_updates_vessel");
    expect(sql).toContain("VESSEL_RESTORE_CONFLICT");
  });
});
