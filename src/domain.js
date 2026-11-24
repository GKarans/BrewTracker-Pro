export const BATCH_STATUS = Object.freeze({
  ACTIVE: "active",
  DRY_HOP: "dry_hop",
  COOLING: "cooling",
  FINISHED: "finished",
});

export const ACTION_TYPES = Object.freeze({
  SPUND: "spund",
  DRY_HOP: "dry_hop",
  COOL: "cool",
  FINISH: "finish",
});

export const ACTION_LABELS = Object.freeze({
  spund: "Aizgriezt vārstu",
  dry_hop: "Pievienot Dry Hop",
  cool: "Iestatīt 0 °C",
  finish: "Pildīšana",
});

export const FERMENTERS = Object.freeze([
  ...Array.from({ length: 9 }, (_, index) => ({ number: index + 1, name: `Tvertne ${index + 1}`, capacityTons: 4, type: "fermenter" })),
  { number: 10, name: "Tvertne 10", capacityTons: 1, type: "fermenter" },
  { number: 11, name: "Tvertne 11", capacityTons: 8, type: "fermenter" },
  { number: 12, name: "Tvertne 12", capacityTons: 8, type: "fermenter" },
  { number: 13, name: "Dzidra", capacityTons: 4, type: "brite" },
]);

export function getFermenter(number) {
  return FERMENTERS.find((item) => item.number === Number(number));
}

export function requiredPackagingRuns(volumeTons) {
  return Math.ceil(Number(volumeTons) / 4);
}

export function completedPackagingVolume(batch) {
  return (batch.packagingRuns || [])
    .filter((run) => run.status === "packaged")
    .reduce((total, run) => total + Number(run.volumeTons), 0);
}

export function filteredVolume(batch) {
  return (batch.packagingRuns || []).reduce((total, run) => total + Number(run.volumeTons), 0);
}

export function remainingInFermenter(batch) {
  return Math.max(0, Number(batch.volumeTons) - filteredVolume(batch));
}

export function formatBatchNumber(year, sequence, fermenterNumber) {
  const shortYear = String(year).slice(-2);
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > 999) {
    throw new Error("Kārtas numuram jābūt no 1 līdz 999.");
  }
  if (!Number.isInteger(fermenterNumber) || fermenterNumber < 1 || fermenterNumber > 13) {
    throw new Error("Tvertnes numuram jābūt no 1 līdz 13.");
  }
  return `${shortYear}${String(sequence).padStart(2, "0")}${fermenterNumber}`;
}

export function validateGravity(value, required = true) {
  if ((value === "" || value == null) && !required) return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 950 || number > 1200) {
    throw new Error("Blīvumam jābūt veselam skaitlim no 950 līdz 1200, piemēram, 1056.");
  }
  return number;
}

export function validatePh(value, required = true) {
  if ((value === "" || value == null) && !required) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 14) {
    throw new Error("pH jābūt skaitlim no 0 līdz 14.");
  }
  return number;
}

export function validateTemperature(value, required = true) {
  if ((value === "" || value == null) && !required) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < -5 || number > 50) {
    throw new Error("Temperatūrai jābūt no -5 līdz 50 °C.");
  }
  return number;
}

export function validatePressure(value, required = false) {
  if ((value === "" || value == null) && !required) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 5) {
    throw new Error("Spiedienam jābūt no 0 līdz 5 bar.");
  }
  return number;
}

export function daysBetween(startDate, endDate) {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  return Math.round((end - start) / 86_400_000);
}

export function addDays(date, days) {
  const result = new Date(`${date}T00:00:00Z`);
  result.setUTCDate(result.getUTCDate() + Math.round(days));
  return result.toISOString().slice(0, 10);
}

export function calculateHistoryStats(batches, beerTypeId) {
  const relevant = batches.filter((batch) => batch.beerTypeId === beerTypeId && batch.status === BATCH_STATUS.FINISHED);
  const actionTypes = [ACTION_TYPES.SPUND, ACTION_TYPES.DRY_HOP, ACTION_TYPES.COOL, ACTION_TYPES.FINISH];
  return Object.fromEntries(actionTypes.map((type) => {
    const values = relevant.flatMap((batch) => {
      const action = batch.actions?.find((item) => item.type === type);
      if (!action) return [];
      return [{ days: daysBetween(batch.brewDate, action.performedAt.slice(0, 10)), ...action }];
    });
    if (!values.length) return [type, null];
    const averageDays = values.reduce((sum, item) => sum + item.days, 0) / values.length;
    return [type, { count: values.length, averageDays, last: values.at(-1) }];
  }));
}

export function getRecommendedAction(batch) {
  const latest = batch.measurements?.at(-1);
  if (!latest) return { type: "measure", label: "Ievadi pirmo mērījumu", tone: "neutral" };
  const completed = new Set((batch.actions || []).map((action) => action.type));
  if (!completed.has(ACTION_TYPES.SPUND) && latest.gravity <= batch.spundGravity) {
    return { type: ACTION_TYPES.SPUND, label: "Aizgriez vārstu", tone: "urgent" };
  }
  if (batch.hasDryHop && !completed.has(ACTION_TYPES.DRY_HOP) && latest.gravity <= batch.dryHopGravity) {
    return { type: ACTION_TYPES.DRY_HOP, label: "Pievieno Dry Hop", tone: "urgent" };
  }
  if (!completed.has(ACTION_TYPES.COOL) && latest.gravity <= batch.coolingGravity) {
    return { type: ACTION_TYPES.COOL, label: "Iestati temperatūru uz 0 °C", tone: "urgent" };
  }
  if (completed.has(ACTION_TYPES.COOL) && latest.gravity <= batch.fgTarget) {
    const activeRun = (batch.packagingRuns || []).find((run) => run.status === "filtered");
    if (activeRun) return { type: "package", label: "Sapildi alu no Dzidras", tone: "urgent" };
    if (completedPackagingVolume(batch) < Number(batch.volumeTons)) return { type: "filter", label: "Filtrē nākamo daļu uz Dzidru", tone: "ready" };
  }
  return { type: "wait", label: "Turpini fermentāciju un veic mērījumu", tone: "normal" };
}

export function getDailyTasks(batch, date = new Date()) {
  if (batch.status === BATCH_STATUS.FINISHED) return [];
  const dateKey = localDateKey(date);
  const latest = batch.measurements?.at(-1);
  const recommendation = getRecommendedAction(batch);
  const completed = new Set((batch.actions || []).map((action) => action.type));
  const tasks = [];

  if (["urgent", "ready"].includes(recommendation.tone)) {
    tasks.push({ type: recommendation.type, label: recommendation.label, tone: recommendation.tone });
  }

  const measuredToday = batch.measurements?.some((measurement) => localDateKey(measurement.measuredAt) === dateKey);
  if (!measuredToday && !completed.has(ACTION_TYPES.COOL) && recommendation.type !== "package") {
    tasks.push({
      type: "measure",
      label: latest ? "Paņem obligāto dienas mērījumu" : "Ievadi pirmo mērījumu",
      tone: "urgent",
    });
  }

  return tasks;
}

export function buildWorkTimeline(batches, date = new Date()) {
  const dateKey = localDateKey(date);
  const active = batches.filter((batch) => batch.status !== BATCH_STATUS.FINISHED);
  return active.flatMap((batch) => {
    const daily = getDailyTasks(batch, date).map((task) => ({
      ...task,
      batchId: batch.id,
      date: dateKey,
      source: "current",
    }));
    const dailyTypes = new Set(daily.map((task) => task.type));
    const completed = new Set((batch.actions || []).map((action) => action.type));
    const stats = calculateHistoryStats(batches, batch.beerTypeId);
    const types = [ACTION_TYPES.SPUND, ...(batch.hasDryHop ? [ACTION_TYPES.DRY_HOP] : []), ACTION_TYPES.COOL, ACTION_TYPES.FINISH];
    const predictions = types.flatMap((type) => {
      const stat = stats[type];
      if (!stat || completed.has(type) || dailyTypes.has(type)) return [];
      const predictedDate = addDays(batch.brewDate, stat.averageDays);
      const overdue = predictedDate < dateKey;
      return [{
        batchId: batch.id,
        type: `prediction_${type}`,
        date: predictedDate,
        predictedDate,
        label: overdue ? `Pārbaudi — prognozēts: ${ACTION_LABELS[type]}` : `Prognozēts: ${ACTION_LABELS[type]}`,
        tone: overdue ? "urgent" : "planned",
        source: "history",
        sampleCount: stat.count,
      }];
    });
    return [...daily, ...predictions];
  }).sort((a, b) => a.date.localeCompare(b.date) || (a.tone === "urgent" ? -1 : 1));
}

function localDateKey(value) {
  return new Intl.DateTimeFormat("en-CA", { timeZone:"Europe/Riga", year:"numeric", month:"2-digit", day:"2-digit" }).format(value instanceof Date ? value : new Date(value));
}
