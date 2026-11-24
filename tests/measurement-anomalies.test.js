import { describe, expect, it } from "vitest";
import fs from "node:fs";

const migration = fs.readFileSync("supabase/migrations/202611240003_measurement_anomalies.sql", "utf8");
const main = fs.readFileSync("src/main.js", "utf8");
const sync = fs.readFileSync("src/sync.js", "utf8");
const operatorMigration = fs.readFileSync("supabase/migrations/202611230003_operator_sessions.sql", "utf8");

describe("servera mērījumu noviržu aizsardzība", () => {
  it("serveris pārrēķina brīdinājumus un sasaista apstiprinājumu ar operatora sesiju", () => {
    expect(migration).toContain("create or replace function public.validate_measurement_anomaly()");
    expect(migration).toContain("ANOMALY_BASELINE_CHANGED");
    expect(migration).toContain("new.anomaly_confirmed_by := case");
    expect(migration).toContain("new.pressure_bar > 2");
    expect(migration).toContain("where b.id=new.batch_id for update");
    expect(migration).toContain("and m.measured_at<=new.measured_at");
    expect(migration).toContain("'pressure_high','severity','warning'");
  });

  it("CO₂ nonāk DB rakstīšanas ceļā un procesa darbības formā", () => {
    expect(operatorMigration).toContain("pressure_bar,co2_vol,note,process_action_id");
    expect(operatorMigration).toContain("co2_vol=excluded.co2_vol");
    expect(main).toContain('name="co2Vol"');
    expect(main).toContain("function anomalyDetails(item)");
  });

  it("vecos rakstīšanas RPC aizstāj ar anomāliju konteksta versiju", () => {
    expect(sync).toContain('"sync_operator_work_event_v3"');
    expect(sync).toContain('"sync_operator_event_v3"');
    expect(migration).toContain("revoke all on function public.sync_operator_event_v2");
  });

  it("brīdinājums tiek parādīts pirms procesa datu mutācijas", () => {
    const warningIndex = main.indexOf("await confirmMeasurementWarnings(warnings, previous)");
    const mutationIndex = main.indexOf("batch.actions = batch.actions.filter", warningIndex);
    expect(warningIndex).toBeGreaterThan(-1);
    expect(mutationIndex).toBeGreaterThan(warningIndex);
  });
});
