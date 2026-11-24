import { describe, expect, it } from "vitest";
import { BATCH_STATUS, buildWorkTimeline, calculateHistoryStats, completedPackagingVolume, detectMeasurementWarnings, formatBatchNumber, getDailyTasks, getFermenter, getRecommendedAction, remainingInFermenter, requiredPackagingRuns, validateGravity, validatePh, validatePressure } from "../src/domain.js";

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
  it("pēc dzesēšanas uzsākšanas vairs neprasa ikdienas mērījumu", () => {
    const batch = { status: BATCH_STATUS.COOLING, spundGravity: 1026, hasDryHop: false, coolingGravity: 1018, fgTarget: 1012, actions: [{ type: "cool", performedAt: "2026-11-22T10:00:00" }], packagingRuns: [], measurements: [{ gravity: 1012, measuredAt: "2026-11-22T10:00:00" }] };
    expect(getDailyTasks(batch, new Date("2026-11-23T12:00:00")).some((task) => task.type === "measure")).toBe(false);
  });
});

describe("vēsturiskā prognoze", () => {
  it("aprēķina vidējo dienu skaitu", () => {
    const batches = [{ beerTypeId: "a", status: BATCH_STATUS.FINISHED, brewDate: "2026-08-01", actions: [{ type: "cool", performedAt: "2026-08-11T10:00:00" }] }, { beerTypeId: "a", status: BATCH_STATUS.FINISHED, brewDate: "2026-09-01", actions: [{ type: "cool", performedAt: "2026-09-13T10:00:00" }] }];
    expect(calculateHistoryStats(batches, "a").cool.averageDays).toBe(11);
  });
  it("saliek nākamos darbus hronoloģiskā laika līnijā", () => {
    const batches = [
      { id: "old", beerTypeId: "a", status: BATCH_STATUS.FINISHED, brewDate: "2026-10-01", actions: [{ type: "spund", performedAt: "2026-10-06T10:00:00" }], measurements: [] },
      { id: "active", beerTypeId: "a", status: BATCH_STATUS.ACTIVE, brewDate: "2026-11-20", spundGravity: 1026, hasDryHop: false, coolingGravity: 1018, fgTarget: 1012, actions: [], packagingRuns: [], measurements: [{ gravity: 1040, measuredAt: "2026-11-23T09:00:00" }] },
    ];
    const timeline = buildWorkTimeline(batches, new Date("2026-11-23T12:00:00"));
    expect(timeline.find((task) => task.type === "prediction_spund")).toMatchObject({ date: "2026-11-25", sampleCount: 1 });
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

describe("mērījumu noviržu kontrole", () => {
  const previous = { id: "previous", measuredAt: "2026-11-24T08:00:00Z", gravity: 1018, ph: 4.5, temperature: 17, pressure: 0.7, co2Vol: null };
  const draft = { measuredAt: "2026-11-24T12:00:00Z", gravity: 1040, ph: 4.5, temperature: 28, pressure: 1.9, co2Vol: null, actionType: null };

  it("atrod blīvuma un temperatūras kritiskas novirzes, bet 1.9 bar ir tikai brīdinājums", () => {
    const warnings = detectMeasurementWarnings(draft, previous, [previous], { now: "2026-11-24T12:00:00Z" });
    expect(warnings.map((item) => item.code)).toEqual(expect.arrayContaining(["gravity_increase", "temperature_jump", "pressure_high"]));
    expect(warnings.filter((item) => item.severity === "critical").length).toBeGreaterThan(0);
    expect(warnings.find((item) => item.code === "pressure_high")?.severity).toBe("warning");
  });

  it("atzīmē precīzu dublikātu 15 minūtēs", () => {
    const duplicate = { ...previous, measuredAt: "2026-11-24T08:10:00Z" };
    expect(detectMeasurementWarnings(duplicate, previous, [previous], { now: "2026-11-24T08:10:00Z" }).map((item) => item.code)).toContain("duplicate");
  });

  it("atzīmē vecu un būtiski nākotnē ievadītu laiku", () => {
    const oldDraft = { ...draft, gravity: 1017, temperature: 17, pressure: 0.7, measuredAt: "2026-11-24T07:00:00Z" };
    const futureDraft = { ...oldDraft, measuredAt: "2026-11-24T13:00:00Z" };
    expect(detectMeasurementWarnings(oldDraft, previous, [], { now: "2026-11-24T12:00:00Z" }).map((item) => item.code)).toContain("timestamp_old");
    expect(detectMeasurementWarnings(futureDraft, previous, [], { now: "2026-11-24T12:00:00Z" }).map((item) => item.code)).toContain("timestamp_future");
  });

  it("atpakaļdatētu mērījumu salīdzina ar hronoloģisko priekšteci, bet vecumu ar jaunāko", () => {
    const predecessor = { ...previous, measuredAt: "2026-11-23T08:00:00Z", gravity: 1020, temperature: 17 };
    const latest = { ...previous, id: "latest", measuredAt: "2026-11-25T08:00:00Z", gravity: 1012, temperature: 0 };
    const backdated = { ...draft, measuredAt: "2026-11-24T08:00:00Z", gravity: 1018, temperature: 17, pressure: 0.7 };
    const warnings = detectMeasurementWarnings(backdated, predecessor, [predecessor, latest], { now: "2026-11-26T08:00:00Z", latest });
    expect(warnings.map((item) => item.code)).toContain("timestamp_old");
    expect(warnings.map((item) => item.code)).not.toContain("temperature_jump");
  });

  it("trūkstošu CO₂ un spiedienu nepārvērš par nulles brīdinājumu", () => {
    const normal = { measuredAt: "2026-11-24T12:00:00Z", gravity: 1017, ph: 4.4, temperature: 17, pressure: null, co2Vol: null };
    expect(detectMeasurementWarnings(normal, previous, [previous], { now: "2026-11-24T12:00:00Z" })).toEqual([]);
  });

  it("pH 47 un spiedienu virs 2 bar noraida ar cieto validāciju", () => {
    expect(() => validatePh(47)).toThrow();
    expect(() => validatePressure(2.1)).toThrow();
  });
});
