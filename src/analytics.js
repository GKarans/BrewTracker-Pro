/**
 * Fermentation analysis is intentionally deterministic and conservative.
 * Missing imported measurements stay missing: nothing in this module invents
 * pH, temperature, pressure or gravity points.
 */
const DAY_MS = 86_400_000;

export const ANALYSIS_METRICS = {
  gravity: { label: "Blīvums", unit: "", lowerIsBetter: true },
  ph: { label: "pH", unit: "", lowerIsBetter: true },
  temperature: { label: "Temperatūra", unit: "°C", lowerIsBetter: false },
  pressure: { label: "Spiediens", unit: "bar", lowerIsBetter: false },
  co2Vol: { label: "CO₂", unit: "vol", lowerIsBetter: false },
};

function dayAt(batch, measuredAt) {
  const start = new Date(`${batch.brewDate}T00:00:00Z`).getTime();
  return Math.max(0, Math.floor((new Date(measuredAt).getTime() - start) / DAY_MS));
}

export function usableMeasurements(batch) {
  return [...(batch.measurements || [])]
    .filter((m) => m && m.measuredAt && Number.isFinite(Number(m.gravity)))
    .sort((a, b) => new Date(a.measuredAt) - new Date(b.measuredAt));
}

export function seriesForBatch(batch, metric) {
  return [...(batch.measurements || [])]
    .filter((m) => m && m.measuredAt)
    .sort((a, b) => new Date(a.measuredAt) - new Date(b.measuredAt))
    .filter((m) => m[metric] !== null && m[metric] !== undefined && Number.isFinite(Number(m[metric])))
    .map((m) => ({ day: dayAt(batch, m.measuredAt), value: Number(m[metric]), measuredAt: m.measuredAt }));
}

/** Linear interpolation is used only between actually measured neighbouring points. */
export function valueAtDay(series, day) {
  const exact = series.find((point) => point.day === day);
  if (exact) return exact.value;
  const before = [...series].reverse().find((point) => point.day < day);
  const after = series.find((point) => point.day > day);
  if (!before || !after) return null;
  return before.value + ((after.value - before.value) * (day - before.day)) / (after.day - before.day);
}

export function mean(values) {
  const valid = values.filter((value) => Number.isFinite(value));
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

export function standardDeviation(values) {
  const average = mean(values);
  if (average === null || values.length < 2) return null;
  return Math.sqrt(values.reduce((sum, value) => sum + ((value - average) ** 2), 0) / (values.length - 1));
}

export function averageCurve(batches, metric) {
  const series = batches.map((batch) => seriesForBatch(batch, metric)).filter((points) => points.length);
  const observedDays = series.flatMap((points) => points.map((point) => point.day));
  const days = observedDays.length
    ? Array.from({ length: Math.max(...observedDays) - Math.min(...observedDays) + 1 }, (_, index) => Math.min(...observedDays) + index)
    : [];
  return days.map((day) => {
    const values = series.map((points) => valueAtDay(points, day)).filter((value) => value !== null);
    const average = mean(values);
    const sd = standardDeviation(values);
    return { day, value: average, count: values.length, sd, lower: sd === null ? null : average - sd, upper: sd === null ? null : average + sd };
  }).filter((point) => point.value !== null);
}

export function comparableBatches(batches, beerTypeId) {
  return batches
    .filter((batch) => batch.beerTypeId === beerTypeId && batch.status === "finished" && (batch.measurements || []).length)
    .sort((a, b) => new Date(a.finishedAt || a.brewDate) - new Date(b.finishedAt || b.brewDate));
}

export function processProfileKey(batch) {
  const volumeClass = Number(batch.volumeTons) > 4 ? "8t" : "4t";
  return [volumeClass, batch.ogTarget, batch.fgTarget, batch.spundGravity, batch.hasDryHop ? batch.dryHopGravity : "no-dry-hop", batch.coolingGravity].join(":");
}

export function sameProfileBatches(batches, reference) {
  if (!reference) return [];
  const key = processProfileKey(reference);
  return batches.filter((batch) => processProfileKey(batch) === key);
}

export function fermentationMetrics(batch, baselineBatches = []) {
  const points = seriesForBatch(batch, "gravity");
  const first = points[0];
  const latest = points.at(-1);
  const gravityRate = points.length > 1 && latest.day > first.day ? (latest.value - first.value) / (latest.day - first.day) : null;
  const phPoints = seriesForBatch(batch, "ph");
  const phRate = phPoints.length > 1 && phPoints.at(-1).day > phPoints[0].day
    ? (phPoints.at(-1).value - phPoints[0].value) / (phPoints.at(-1).day - phPoints[0].day) : null;
  const apparentAttenuation = first && latest && first.value > 1000
    ? ((first.value - latest.value) / (first.value - 1000)) * 100 : null;
  const baseline = averageCurve(baselineBatches, "gravity");
  const latestBaseline = latest && baseline.find((point) => point.day === latest.day && point.count >= 2);
  const deviationPercent = latestBaseline ? ((latest.value - latestBaseline.value) / Math.max(1, Math.abs(latestBaseline.value - 1000))) * 100 : null;
  const firstDifference = points.map((point) => {
    const expected = baseline.find((candidate) => candidate.day === point.day && candidate.count >= 2);
    if (!expected || expected.sd === null) return null;
    return Math.abs(point.value - expected.value) > Math.max(2, expected.sd * 1.5) ? point.day : null;
  }).find((day) => day !== null) ?? null;
  let predictedFgDay = null;
  if (latest && points.length >= 3 && gravityRate !== null && gravityRate < -0.1 && Number.isFinite(Number(batch.fgTarget)) && latest.value > Number(batch.fgTarget)) {
    predictedFgDay = latest.day + ((latest.value - Number(batch.fgTarget)) / Math.abs(gravityRate));
  }
  return { first, latest, gravityRate, phRate, apparentAttenuation, deviationPercent, firstDifference, predictedFgDay };
}

export function carbonationReadiness(batch, configuration = {}) {
  const latest = usableMeasurements(batch).at(-1);
  const blockers = [];
  if (latest?.co2Vol == null) blockers.push("nav aktuālā CO₂ mērījuma");
  if (!latest?.co2MeasurementMethod) blockers.push("aktuālajam CO₂ mērījumam nav norādīta metode/ierīce");
  if (latest?.temperature == null) blockers.push("nav aktuālās alus temperatūras");
  if (latest?.gravity == null) blockers.push("nav aktuālā blīvuma");
  if (!configuration.confirmedTerminalGravity) blockers.push("nav apstiprināta gala blīvuma vai forced-fermentation rezultāta");
  if (!Number.isFinite(Number(batch.co2Target))) blockers.push("nav mērķa CO₂");
  if (!configuration.beerVolumeLiters) blockers.push("nav ievadīts alus tilpums");
  if (!configuration.headspaceLiters) blockers.push("nav ievadīts galvas telpas tilpums");
  if (!configuration.hardwareMaxBar) blockers.push("nav tvertnes sertificētās maksimālās darba spiediena robežas");
  if (!configuration.prvLimitBar) blockers.push("nav PRV/drošības vārsta robežas");
  if (!configuration.deviceLimitBar) blockers.push("nav spundes/manometra darba robežas");
  if (!configuration.pressureBasis) blockers.push("nav norādīts, ka spiediens ir manometra (gauge) spiediens");
  if (configuration.altitudeMeters === null || configuration.altitudeMeters === undefined || configuration.altitudeMeters === "") blockers.push("nav ievadīts augstums virs jūras līmeņa");
  if (batch.hasDryHop && !configuration.hopCreepAcknowledged) blockers.push("Dry Hop gadījumā nav apstiprināts hop-creep risks");
  const ceiling = Math.min(2, ...[configuration.hardwareMaxBar, configuration.prvLimitBar, configuration.deviceLimitBar]
    .map(Number).filter(Number.isFinite));
  const co2Deficit = latest?.co2Vol != null && Number.isFinite(Number(batch.co2Target)) ? Number(batch.co2Target) - Number(latest.co2Vol) : null;
  const residualGravityPoints = latest?.gravity != null && configuration.confirmedTerminalGravity != null
    ? Math.max(0, Number(latest.gravity) - Number(configuration.confirmedTerminalGravity)) : null;
  return { latest, blockers, ceiling: Number.isFinite(ceiling) ? ceiling : null, ready: blockers.length === 0, co2Deficit, residualGravityPoints };
}
