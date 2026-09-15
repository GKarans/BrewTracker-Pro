import { describe, expect, it } from "vitest";
import { BATCH_STATUS, calculateHistoryStats, formatBatchNumber, getRecommendedAction, validateGravity } from "../src/domain.js";

describe("partijas numurs", () => {
  it("apvieno divciparu gadu, kārtas numuru un tvertni", () => {
    expect(formatBatchNumber(2026, 65, 4)).toBe("26654");
  });
  it("noraida tvertni ārpus 1–13", () => {
    expect(() => formatBatchNumber(2026, 65, 14)).toThrow();
  });
});

describe("procesa ieteikumi", () => {
  it("iesaka aizgriezt vārstu, sasniedzot slieksni", () => {
    const batch = { spundGravity: 1026, hasDryHop: true, dryHopGravity: 1022, coolingGravity: 1018, fgTarget: 1012, actions: [], measurements: [{ gravity: 1025 }] };
    expect(getRecommendedAction(batch).type).toBe("spund");
  });
  it("validē blīvuma formātu", () => {
    expect(validateGravity("1056")).toBe(1056);
    expect(() => validateGravity("1.056")).toThrow();
  });
});

describe("vēsturiskā prognoze", () => {
  it("aprēķina vidējo dienu skaitu", () => {
    const batches = [{ beerTypeId: "a", status: BATCH_STATUS.FINISHED, brewDate: "2026-08-01", actions: [{ type: "cool", performedAt: "2026-08-11T10:00:00" }] }, { beerTypeId: "a", status: BATCH_STATUS.FINISHED, brewDate: "2026-09-01", actions: [{ type: "cool", performedAt: "2026-09-13T10:00:00" }] }];
    expect(calculateHistoryStats(batches, "a").cool.averageDays).toBe(11);
  });
});
