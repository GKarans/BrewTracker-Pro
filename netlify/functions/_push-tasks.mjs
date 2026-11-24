export function collectDueTasks(batch, dateKey) {
  const actions = new Set((batch.process_actions || []).map((action) => action.action_type));
  const measurements = [...(batch.measurements || [])].sort((a, b) => new Date(a.measured_at) - new Date(b.measured_at));
  const latest = measurements.at(-1);
  const runs = batch.packaging_runs || [];
  const tasks = [];

  if (actions.has("cool")) {
    const filtered = runs.find((run) => run.status === "filtered");
    if (filtered) tasks.push("Sapildi alu no Dzidras");
    else {
      const packagedVolume = runs.filter((run) => run.status === "packaged").reduce((sum, run) => sum + Number(run.volume_tons), 0);
      if (packagedVolume < Number(batch.volume_tons)) tasks.push("Filtrē nākamo daļu uz Dzidru");
    }
    return tasks;
  }

  if (latest) {
    if (!actions.has("spund") && latest.gravity <= batch.spund_gravity) tasks.push("Aizgriez vārstu");
    if (batch.has_dry_hop && !actions.has("dry_hop") && latest.gravity <= batch.dry_hop_gravity) tasks.push("Pievieno Dry Hop");
    if (!actions.has("cool") && latest.gravity <= batch.cooling_gravity) tasks.push("Iestati temperatūru uz 0 °C");
  }

  const measuredToday = measurements.some((measurement) => rigaDateKey(measurement.measured_at) === dateKey);
  if (!measuredToday) tasks.push(latest ? "Paņem obligāto dienas mērījumu" : "Ievadi pirmo mērījumu");
  return [...new Set(tasks)];
}

export function collectPredictedTasks(batch, finishedBatches, dateKey) {
  const completed = new Set((batch.process_actions || []).map((action) => action.action_type));
  const labels = { spund: "Aizgriezt vārstu", dry_hop: "Pievienot Dry Hop", cool: "Iestatīt 0 °C" };
  const types = ["spund", ...(batch.has_dry_hop ? ["dry_hop"] : []), "cool"];
  const tasks = [];
  for (const type of types) {
    if (completed.has(type)) continue;
    const dayValues = finishedBatches
      .filter((item) => item.beer_type_id === batch.beer_type_id)
      .flatMap((item) => {
        const action = (item.process_actions || []).find((candidate) => candidate.action_type === type);
        return action ? [daysBetween(item.brew_date, action.performed_at.slice(0, 10))] : [];
      });
    if (!dayValues.length) continue;
    const averageDays = dayValues.reduce((sum, days) => sum + days, 0) / dayValues.length;
    if (addDays(batch.brew_date, averageDays) <= dateKey) tasks.push(`Pārbaudi — prognozēts: ${labels[type]}`);
  }
  return tasks;
}

export function rigaDateKey(value = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Riga",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}

export function rigaLocalDateTimeIso(dateKey, hour = 7, minute = 0) {
  const desired = Date.UTC(Number(dateKey.slice(0,4)),Number(dateKey.slice(5,7))-1,Number(dateKey.slice(8,10)),hour,minute);
  let instant=desired;
  for(let attempt=0;attempt<2;attempt+=1){
    const parts=Object.fromEntries(new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Riga",hour12:false,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"}).formatToParts(new Date(instant)).filter((part)=>part.type!=="literal").map((part)=>[part.type,part.value]));
    const represented=Date.UTC(Number(parts.year),Number(parts.month)-1,Number(parts.day),Number(parts.hour)%24,Number(parts.minute));
    instant+=desired-represented;
  }
  return new Date(instant).toISOString();
}

function daysBetween(start, end) {
  return Math.round((new Date(`${end}T00:00:00Z`) - new Date(`${start}T00:00:00Z`)) / 86_400_000);
}

function addDays(value, days) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + Math.round(days));
  return date.toISOString().slice(0, 10);
}

