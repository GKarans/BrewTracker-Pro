import { createClient } from "@supabase/supabase-js";
import * as webpush from "web-push";
import { collectDueTasks, collectPredictedTasks, rigaDateKey } from "./_push-tasks.mjs";

export default async () => {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;
  const vapidPublicKey = process.env.VAPID_PUBLIC_KEY;
  const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;
  const vapidSubject = process.env.VAPID_SUBJECT;
  if (!supabaseUrl || !supabaseSecretKey || !vapidPublicKey || !vapidPrivateKey || !vapidSubject) {
    console.error("Missing Web Push environment variables");
    return;
  }

  const localHour = Number(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Riga",
    hour: "2-digit",
    hourCycle: "h23",
  }).format(new Date()));
  if (localHour !== 7) return;

  webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
  const supabase = createClient(supabaseUrl, supabaseSecretKey, { auth: { persistSession: false } });
  const dateKey = rigaDateKey();
  const { data: subscriptions, error: subscriptionError } = await supabase
    .from("push_subscriptions")
    .select("id, brewery_id, endpoint, p256dh, auth_key, last_notified_on")
    .eq("is_active", true)
    .or(`last_notified_on.is.null,last_notified_on.lt.${dateKey}`);
  if (subscriptionError) throw subscriptionError;

  for (const subscription of subscriptions || []) {
    const { data: batches, error: batchError } = await supabase
      .from("batches")
      .select("id, status, beer_type_id, brew_date, batch_number, volume_tons, spund_gravity, has_dry_hop, dry_hop_gravity, cooling_gravity, beer_types(name), fermenters(number), measurements(measured_at,gravity,deleted_at), process_actions(action_type,performed_at,deleted_at), packaging_runs(status,volume_tons,deleted_at)")
      .eq("brewery_id", subscription.brewery_id)
      .is("deleted_at", null);
    if (batchError) throw batchError;

    const visibleBatches = (batches || []).map((batch) => ({
      ...batch,
      measurements: (batch.measurements || []).filter((item) => !item.deleted_at),
      process_actions: (batch.process_actions || []).filter((item) => !item.deleted_at),
      packaging_runs: (batch.packaging_runs || []).filter((item) => !item.deleted_at),
    }));
    const activeBatches = visibleBatches.filter((batch) => batch.status !== "finished");
    const finishedBatches = visibleBatches.filter((batch) => batch.status === "finished");
    const tasks = activeBatches.flatMap((batch) => {
      const labels = collectDueTasks(batch, dateKey);
      const predicted = collectPredictedTasks(batch, finishedBatches, dateKey)
        .filter((label) => !labels.some((existing) => label.includes(existing)));
      return [...labels, ...predicted].map((label) => ({
      label,
      batchNumber: batch.batch_number,
      beerName: batch.beer_types?.name || "Alus",
      fermenterNumber: batch.fermenters?.number,
      }));
    });
    if (!tasks.length) continue;

    const payload = JSON.stringify({
      title: `BrewTracker Pro — ${tasks.length} ${tasks.length === 1 ? "darbs" : "darbi"}`,
      body: tasks.slice(0, 4).map((task) => `T${task.fermenterNumber} ${task.beerName}: ${task.label}`).join("\n"),
      url: "/",
      tag: `brewtracker-${dateKey}`,
    });

    try {
      await webpush.sendNotification({
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth_key },
      }, payload, { TTL: 21_600 });
      await supabase.from("push_subscriptions").update({ last_notified_on: dateKey, updated_at: new Date().toISOString() }).eq("id", subscription.id);
    } catch (error) {
      if ([404, 410].includes(error.statusCode)) {
        await supabase.from("push_subscriptions").update({ is_active: false, updated_at: new Date().toISOString() }).eq("id", subscription.id);
      } else {
        console.error("Push delivery failed", subscription.id, error.statusCode || error.message);
      }
    }
  }
};

export const config = { schedule: "0 * * * *" };

