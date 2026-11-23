import { describe, expect, it } from "vitest";
import { BATCH_STATUS, calculateHistoryStats, completedPackagingVolume, formatBatchNumber, getDailyTasks, getFermenter, getRecommendedAction, remainingInFermenter, requiredPackagingRuns, validateGravity } from "../src/domain.js";

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
  it("prasa dienas mērījumu, ja šodien tāda nav", () => {
    const batch = { status: BATCH_STATUS.ACTIVE, spundGravity: 1026, hasDryHop: false, coolingGravity: 1018, fgTarget: 1012, actions: [], packagingRuns: [], measurements: [{ gravity: 1040, measuredAt: "2026-11-22T10:00:00" }] };
    expect(getDailyTasks(batch, new Date("2026-11-23T12:00:00")).some((task) => task.type === "measure")).toBe(true);
  });
  it("neprasa otru mērījumu tajā pašā dienā", () => {
    const batch = { status: BATCH_STATUS.ACTIVE, spundGravity: 1026, hasDryHop: false, coolingGravity: 1018, fgTarget: 1012, actions: [], packagingRuns: [], measurements: [{ gravity: 1040, measuredAt: "2026-11-23T10:00:00" }] };
    expect(getDailyTasks(batch, new Date("2026-11-23T12:00:00")).some((task) => task.type === "measure")).toBe(false);
  });
});

describe("vēsturiskā prognoze", () => {
  it("aprēķina vidējo dienu skaitu", () => {
    const batches = [{ beerTypeId: "a", status: BATCH_STATUS.FINISHED, brewDate: "2026-08-01", actions: [{ type: "cool", performedAt: "2026-08-11T10:00:00" }] }, { beerTypeId: "a", status: BATCH_STATUS.FINISHED, brewDate: "2026-09-01", actions: [{ type: "cool", performedAt: "2026-09-13T10:00:00" }] }];
    expect(calculateHistoryStats(batches, "a").cool.averageDays).toBe(11);
  });
});

describe("tvertnes un pildīšana", () => {
  it("izmanto pareizās tvertņu ietilpības", () => {
    expect(getFermenter(1).capacityTons).toBe(4);
    expect(getFermenter(10).capacityTons).toBe(1);
    expect(getFermenter(11).capacityTons).toBe(8);
    expect(getFermenter(13)).toMatchObject({ name: "Dzidra", capacityTons: 4, type: "brite" });
  });
  it("8 tonnu partijai paredz divus pildīšanas ciklus", () => {
    expect(requiredPackagingRuns(8)).toBe(2);
    expect(completedPackagingVolume({ packagingRuns: [{ status: "packaged", volumeTons: 4 }, { status: "filtered", volumeTons: 4 }] })).toBe(4);
    expect(remainingInFermenter({ volumeTons: 8, packagingRuns: [{ status: "filtered", volumeTons: 4 }] })).toBe(4);
  });
});
