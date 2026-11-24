import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { averageCurve, carbonationReadiness, fermentationMetrics, seriesForBatch } from "../src/analytics.js";

const batch = (id, measurements, extra = {}) => ({ id, brewDate: "2026-11-01", fgTarget: 1012, co2Target: 2.4, hasDryHop: false, measurements, ...extra });
const measurement = (day, gravity, extra = {}) => ({ measuredAt: `2026-11-${String(day + 1).padStart(2, "0")}T08:00:00Z`, gravity, ph: 4.4, temperature: 17, pressure: .7, ...extra });

describe("fermentation analysis", () => {
  it("keeps missing metric fields as gaps", () => {
    expect(seriesForBatch(batch("a", [measurement(0, 1050, { pressure: null }), measurement(2, 1030)]), "pressure")).toHaveLength(1);
  });
  it("keeps a pH observation when the imported row has no gravity", () => {
    const imported = measurement(1, null, { ph: 4.31 });
    expect(seriesForBatch(batch("a", [imported]), "ph")).toEqual([{ day: 1, value: 4.31, measuredAt: imported.measuredAt }]);
  });
  it("averages only measured/interpolatable historic values", () => {
    const curve = averageCurve([batch("a", [measurement(0, 1050), measurement(2, 1030)]), batch("b", [measurement(0, 1052), measurement(2, 1032)])], "gravity");
    expect(curve.find((point) => point.day === 1).value).toBe(1041);
  });
  it("reports rates, attenuation and a cautious FG projection", () => {
    const stats = fermentationMetrics(batch("a", [measurement(0, 1050), measurement(1, 1040), measurement(2, 1030)]), []);
    expect(stats.gravityRate).toBe(-10);
    expect(stats.apparentAttenuation).toBeCloseTo(40);
    expect(stats.predictedFgDay).toBeGreaterThan(2);
  });
  it("blocks carbonation without the full physical checklist", () => {
    const result = carbonationReadiness(batch("a", [measurement(1, 1012, { co2Vol: 2.4, temperature: 0.5 })]), {});
    expect(result.ready).toBe(false);
    expect(result.blockers).toContain("nav tvertnes sertificētās maksimālās darba spiediena robežas");
  });
  it("caps the advisor ceiling at 2 bar but never calculates a setpoint", () => {
    const result = carbonationReadiness(batch("a", [measurement(1, 1012, { co2Vol: 2.4, co2MeasurementMethod: "CBox", temperature: 0.5 })]), {
      confirmedTerminalGravity: 1012, beerVolumeLiters: 3500, headspaceLiters: 500,
      hardwareMaxBar: 2, prvLimitBar: 1.8, deviceLimitBar: 2, pressureBasis: "gauge", altitudeMeters: 10,
    });
    expect(result.ready).toBe(true);
    expect(result.ceiling).toBe(1.8);
    expect(result.setpoint).toBeUndefined();
  });
  it("blocks advisory when a CO2 value has no method on the measurement", () => {
    const result = carbonationReadiness(batch("a", [measurement(1, 1012, { co2Vol: 2.4, temperature: 0.5 })]), {
      confirmedTerminalGravity: 1012, beerVolumeLiters: 3500, headspaceLiters: 500,
      hardwareMaxBar: 2, prvLimitBar: 1.8, deviceLimitBar: 2, pressureBasis: "gauge", altitudeMeters: 10,
    });
    expect(result.blockers).toContain("aktuālajam CO₂ mērījumam nav norādīta metode/ierīce");
  });
  it("keeps carbonation configuration behind a session-validated RPC", async () => {
    const sql = await readFile(new URL("../supabase/migrations/202611240005_fermentation_analysis_and_carbonation.sql", import.meta.url), "utf8");
    expect(sql).toContain("public.validate_operator_session(session_token)");
    expect(sql).toContain("co2_measurement_method");
    expect(sql).toContain("hardware_limit > 2");
    expect(sql).not.toMatch(/recommended_pressure|pressure_setpoint/i);
  });
});
