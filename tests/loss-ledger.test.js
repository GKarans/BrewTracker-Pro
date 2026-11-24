import { describe, expect, it } from "vitest";
import { calculateLossLedger, estimatedFermenterHeelLiters, estimatedKettleResidueLiters } from "../src/domain.js";
import fs from "node:fs";

describe("loss ledger", () => {
  it("keeps gross centrifuge throughput separate from beer received in Dzidra", () => {
    const ledger = calculateLossLedger({ volumeTons: 4, packagingRuns: [{ status:"packaged", sourceDrawnLiters:3800, centrifugeLiters:4100, briteReceivedLiters:3600, packagedLiters:3500 }] });
    expect(ledger.centrifugeGrossLiters).toBe(4100);
    expect(ledger.briteLiters).toBe(3600);
    expect(ledger.centrifugeSystemDifferenceLiters).toBe(500);
    expect(ledger.sourceToBriteLossLiters).toBe(200);
    expect(ledger.briteToPackageLossLiters).toBe(100);
  });

  it("does not calculate a stage loss without both measured boundaries", () => {
    const ledger = calculateLossLedger({ volumeTons: 4, packagingRuns: [{ status:"filtered", centrifugeLiters:3900 }] });
    expect(ledger.sourceToBriteLossLiters).toBeNull();
    expect(ledger.briteToPackageLossLiters).toBeNull();
    expect(ledger.totalNominalToPackageDifferenceLiters).toBeNull();
  });

  it("does not treat a planned filtration share as a measured source volume", () => {
    const ledger = calculateLossLedger({ volumeTons: 4, packagingRuns: [{ status:"filtered", briteReceivedLiters:3600 }] });
    expect(ledger.sourceLiters).toBeNull();
    expect(ledger.sourceToBriteLossLiters).toBeNull();
  });

  it("uses the agreed estimates without making them release blockers", () => {
    expect(estimatedKettleResidueLiters(4)).toBe(300);
    expect(estimatedKettleResidueLiters(8)).toBe(600);
    expect(estimatedFermenterHeelLiters(4)).toBe(200);
    expect(estimatedFermenterHeelLiters(8)).toBe(350);
  });

  it("records explicit measured stage events and retains correction reason", () => {
    const sql = fs.readFileSync("supabase/migrations/202611240005_volume_loss_ledger.sql", "utf8");
    expect(sql).toContain("centrifuge_gross_throughput");
    expect(sql).toContain("brite_received");
    expect(sql).toContain("packaged_output");
    expect(sql).toContain("volume_override_reason");
    expect(sql).toContain("VOLUME_BOUNDARY_EXCEEDED");
    expect(sql).toContain("sync_operator_event_v4");
  });

  it("keeps the source-to-centrifuge entry optional in the filtration form", () => {
    const main = fs.readFileSync("src/main.js", "utf8");
    expect(main).toContain('name="sourceDrawnLiters" type="number" min="0" step="1" placeholder="Piem., ${Math.round(volume * 1000)}"');
    expect(main).toContain('data.sourceDrawnLiters === "" ? null');
    expect(main).toContain("Plānotā daļa ir ${Math.round(volume * 1000)} l; tā netiek saglabāta kā mērījums.");
  });
});
