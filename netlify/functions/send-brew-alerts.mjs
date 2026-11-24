import { createClient } from "@supabase/supabase-js";
import * as webpush from "web-push";
import { collectDueTasks, collectPredictedTasks, rigaDateKey, rigaLocalDateTimeIso } from "./_push-tasks.mjs";

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
    const { data: batches, error: batchError } = await supabase.from("batches")
      .select("id,status,beer_type_id,brew_date,volume_tons,spund_gravity,has_dry_hop,dry_hop_gravity,cooling_gravity,measurements(measured_at,gravity,deleted_at),process_actions(action_type,performed_at,deleted_at),packaging_runs(status,volume_tons,deleted_at)")
      .eq("brewery_id", subscription.brewery_id).is("deleted_at", null);
    if(batchError)throw batchError;
    const visible=(batches || []).map((batch)=>({...batch,measurements:(batch.measurements||[]).filter((item) => !item.deleted_at),process_actions:(batch.process_actions||[]).filter((item) => !item.deleted_at),packaging_runs:(batch.packaging_runs||[]).filter((item) => !item.deleted_at)}));
    const active=visible.filter((batch)=>batch.status!=="finished");
    const finished=visible.filter((batch)=>batch.status==="finished");
    const generated=active.flatMap((batch)=>{
      const labels=[...collectDueTasks(batch,dateKey),...collectPredictedTasks(batch,finished,dateKey)];
      return [...new Set(labels)].map((label)=>{
        const type=label.includes("mērījumu")||label.includes("pirmo mērījumu")?"measure":label.includes("vārstu")?"spund":label.includes("Dry Hop")?"dry_hop":label.includes("0 °C")?"cool":label.includes("Filtrē")?"filter":"package";
        const filtered=(batch.packaging_runs||[]).find((run)=>run.status==="filtered");
        const cycle=type==="package"&&filtered?filtered.run_number:(batch.packaging_runs?.length||0)+1;
        const occurrence=type==="measure"?`${batch.id}:measure:${dateKey}`:["filter","package"].includes(type)?`${batch.id}:${type}:cycle-${Math.max(1,cycle)}`:`${batch.id}:${type}`;
        return {brewery_id:subscription.brewery_id,batch_id:batch.id,occurrence_key:occurrence,work_type:type,label:label.replace("Pārbaudi — prognozēts: ",""),source:label.startsWith("Pārbaudi")?"history":"process",due_at:rigaLocalDateTimeIso(dateKey,7)};
      });
    });
    // A persistent weekly reminder.  It has no batch because it protects the
    // whole brewery; opening the notification never marks it accepted/completed.
    const mondayDate=weekMondayKey(dateKey);
    generated.push({brewery_id:subscription.brewery_id,batch_id:null,occurrence_key:`backup:${mondayDate}`,work_type:"backup",label:"Lejupielādē nedēļas rezerves kopiju",source:"backup",due_at:rigaLocalDateTimeIso(mondayDate,7)});
    if(generated.length){
      const keys=generated.map((item)=>item.occurrence_key);
      const {data:existing,error:existingError}=await supabase.from("work_items").select("id,occurrence_key,status").eq("brewery_id",subscription.brewery_id).in("occurrence_key",keys);
      if(existingError)throw existingError;
      const byKey=new Map((existing||[]).map((item)=>[item.occurrence_key,item]));
      const missing=generated.filter((item)=>!byKey.has(item.occurrence_key));
      if(missing.length){const {error}=await supabase.from("work_items").insert(missing);if(error)throw error;}
      for(const generatedItem of generated){
        const current=byKey.get(generatedItem.occurrence_key);
        if(current?.status==="todo"){
          const {error}=await supabase.from("work_items").update({label:generatedItem.label,source:generatedItem.source}).eq("id",current.id).eq("status","todo");
          if(error)throw error;
        }
      }
    }
    const nextDate=new Date(`${dateKey}T00:00:00Z`);nextDate.setUTCDate(nextDate.getUTCDate()+1);
    const dayEnd = new Date(new Date(rigaLocalDateTimeIso(nextDate.toISOString().slice(0,10),0)).getTime()-1).toISOString();
    const { data: tasks, error: taskError } = await supabase
      .from("work_items")
      .select("id,label,due_at,status,batch_id,batches(batch_number,beer_types(name),fermenters(number))")
      .eq("brewery_id", subscription.brewery_id)
      .in("status", ["todo", "accepted", "postponed"])
      .lte("due_at", dayEnd)
      .order("due_at");
    if (taskError) throw taskError;
    if (!tasks?.length) continue;

    const { data: delivered, error: deliveryError } = await supabase.from("work_notification_deliveries")
      .select("work_item_id,urgency").eq("subscription_id",subscription.id).eq("notification_date",dateKey);
    if (deliveryError) throw deliveryError;
    const already = new Set((delivered || []).map((item)=>`${item.work_item_id}:${item.urgency}`));
    const pending = tasks.filter((task)=>rigaDateKey(task.due_at)<=dateKey).map((task)=>({
      ...task,
      urgency: rigaDateKey(task.due_at) < dateKey ? "overdue" : "today",
      batchNumber: task.batches?.batch_number,
      beerName: task.batches?.beer_types?.name || "Alus",
      fermenterNumber: task.batches?.fermenters?.number,
    })).filter((task)=>!already.has(`${task.id}:${task.urgency}`));
    if (!pending.length) continue;

    const payload = JSON.stringify({
      title: `BrewTracker Pro — ${pending.length} ${pending.length === 1 ? "darbs" : "darbi"}`,
      body: pending.slice(0, 4).map((task) => `${task.urgency === "overdue" ? "KAVĒTS · " : ""}${task.batch_id ? `T${task.fermenterNumber} ${task.beerName}: ` : ""}${task.label}`).join("\n"),
      url: pending.length === 1 ? `/?work=${pending[0].id}` : "/?route=tasks",
      tag: `brewtracker-${dateKey}`,
    });

    try {
      await webpush.sendNotification({
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth_key },
      }, payload, { TTL: 21_600 });
      const { error: insertDeliveryError } = await supabase.from("work_notification_deliveries").insert(pending.map((task)=>({work_item_id:task.id,subscription_id:subscription.id,urgency:task.urgency,notification_date:dateKey})));
      if (insertDeliveryError && insertDeliveryError.code !== "23505") throw insertDeliveryError;
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

function weekMondayKey(dateKey) {
  const date=new Date(`${dateKey}T12:00:00Z`);
  const weekday=date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate()-weekday+1);
  return date.toISOString().slice(0,10);
}

export const config = { schedule: "0 * * * *" };

