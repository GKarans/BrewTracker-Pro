import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

const migrationUrl = new URL("../supabase/migrations/202611240002_work_items.sql", import.meta.url);
const mainUrl = new URL("../src/main.js", import.meta.url);
const pushUrl = new URL("../netlify/functions/send-brew-alerts.mjs", import.meta.url);
const pushTasksUrl = new URL("../netlify/functions/_push-tasks.mjs", import.meta.url);
const syncUrl = new URL("../src/sync.js", import.meta.url);

describe("persisted brewery work", () => {
  it("has explicit, event-backed state transitions", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql).toContain("('todo','accepted','completed','postponed','skipped')");
    expect(sql).toContain("item.status <> 'accepted'");
    expect(sql).toContain("Atlikšanai vajag iemeslu un nākotnes datumu");
    expect(sql).toContain("Izlaišanai vajag paskaidrojumu");
    expect(sql).toContain("insert into public.work_item_events");
    expect(sql).toContain("unique(work_item_id, subscription_id, urgency, notification_date)");
  });

  it("does not accept work merely by opening it", async () => {
    const main = await readFile(mainUrl, "utf8");
    expect(main).toContain("Atvēršana darbu nepieņem");
    expect(main).toContain('data-work-transition="accept"');
    expect(main).toContain("ensureAcceptedWork");
    expect(main).toContain("acceptedWorkItem");
  });

  it("pushes only persisted today or overdue work with delivery idempotency", async () => {
    const push = await readFile(pushUrl, "utf8");
    expect(push).toContain('.from("work_items")');
    expect(push).toContain('.in("status", ["todo", "accepted", "postponed"])');
    expect(push).toContain('.from("work_notification_deliveries")');
    expect(push).toContain('urgency: rigaDateKey(task.due_at) < dateKey ? "overdue" : "today"');
  });

  it("creates separate filtering occurrences for packaging cycles", async () => {
    const main = await readFile(mainUrl, "utf8");
    expect(main).toContain("workOccurrenceKey");
    expect(main).toContain("`${batch.id}:measure:${dateKey}`");
    expect(main).toContain("`${batch.id}:${type}`");
    expect(main).toContain("cycle-${Math.max(1, cycle)}");
  });

  it("completes accepted work atomically with process evidence", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    const sync = await readFile(syncUrl, "utf8");
    expect(sql).toContain("function public.sync_operator_work_event");
    expect(sql).toContain("Darbības veids neatbilst pieņemtajam darbam");
    expect(sql).toContain("linked_packaging_run_id");
    expect(sync).toContain('event.workItemId ? "sync_operator_work_event_v4"');
  });

  it("uses Europe/Riga instead of a fixed UTC offset", async () => {
    const push = await readFile(pushUrl, "utf8");
    const tasks = await readFile(pushTasksUrl, "utf8");
    expect(tasks).toContain('timeZone:"Europe/Riga"');
    expect(push).not.toContain("+02:00");
  });
});
