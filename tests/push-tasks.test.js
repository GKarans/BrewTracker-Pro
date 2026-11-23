import { describe, expect, it } from "vitest";
import { collectDueTasks, collectPredictedTasks } from "../netlify/functions/_push-tasks.mjs";

function batch(overrides = {}) {
  return {
    volume_tons: 4,
    spund_gravity: 1026,
    has_dry_hop: false,
    dry_hop_gravity: null,
    cooling_gravity: 1018,
    measurements: [],
    process_actions: [],
    packaging_runs: [],
    ...overrides,
  };
}

describe("Web Push dienas darbi", () => {
  it("pirms dzesēšanas prasa dienas mērījumu", () => {
    expect(collectDueTasks(batch(), "2026-11-23")).toContain("Ievadi pirmo mērījumu");
  });

  it("pēc dzesēšanas neprasa mērījumu un prasa filtrēšanu", () => {
    const tasks = collectDueTasks(batch({ process_actions: [{ action_type: "cool" }] }), "2026-11-23");
    expect(tasks).toEqual(["Filtrē nākamo daļu uz Dzidru"]);
  });

  it("pēc filtrēšanas prasa pildīšanu", () => {
    const tasks = collectDueTasks(batch({
      process_actions: [{ action_type: "cool" }],
      packaging_runs: [{ status: "filtered", volume_tons: 4 }],
    }), "2026-11-23");
    expect(tasks).toEqual(["Sapildi alu no Dzidras"]);
  });

  it("izmanto pabeigto tā paša alus partiju darbību prognozei", () => {
    const active = batch({ beer_type_id: "beer-a", brew_date: "2026-11-01" });
    const history = [{ beer_type_id: "beer-a", brew_date: "2026-10-01", process_actions: [{ action_type: "spund", performed_at: "2026-10-06T10:00:00Z" }] }];
    expect(collectPredictedTasks(active, history, "2026-11-06")).toContain("Pārbaudi — prognozēts: Aizgriezt vārstu");
  });
});
