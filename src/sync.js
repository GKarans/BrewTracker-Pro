import { supabase } from "./supabase.js";

function throwOnError(result) {
  if (result.error) throw result.error;
  return result.data;
}

export async function fetchRemoteState(localState, breweryId) {
  const [fermenters, beerTypes, batches, measurements, actions, packagingRuns] = await Promise.all([
    supabase.from("fermenters").select("*").order("number"),
    supabase.from("beer_types").select("*").order("name"),
    supabase.from("batches").select("*").order("brew_date"),
    supabase.from("measurements").select("*").order("measured_at"),
    supabase.from("process_actions").select("*").order("performed_at"),
    supabase.from("packaging_runs").select("*").order("filtered_at"),
  ]);
  [fermenters, beerTypes, batches, measurements, actions, packagingRuns].forEach(throwOnError);
  return {
    ...localState,
    fermenters: fermenters.data,
    beerTypes: beerTypes.data.map((item) => ({ id: item.id, name: item.name, ogTarget: item.og_target, fgTarget: item.fg_target, spundGravity: item.spund_gravity, hasDryHop: item.has_dry_hop, dryHopGravity: item.dry_hop_gravity, coolingGravity: item.cooling_gravity, co2Target: Number(item.co2_target) })),
    batches: batches.data.map((batch) => ({
      id: batch.id,
      batchNumber: batch.batch_number,
      year: batch.brew_year,
      sequence: batch.sequence_number,
      fermenterNumber: fermenters.data.find((item) => item.id === batch.fermenter_id)?.number,
      fermenterId: batch.fermenter_id,
      beerTypeId: batch.beer_type_id,
      volumeTons: Number(batch.volume_tons),
      brewDate: batch.brew_date,
      status: batch.status,
      ogTarget: batch.og_target,
      fgTarget: batch.fg_target,
      spundGravity: batch.spund_gravity,
      hasDryHop: batch.has_dry_hop,
      dryHopGravity: batch.dry_hop_gravity,
      coolingGravity: batch.cooling_gravity,
      co2Target: Number(batch.co2_target),
      createdBy: batch.created_by,
      createdAt: batch.created_at,
      finishedAt: batch.finished_at,
      measurements: measurements.data.filter((item) => item.batch_id === batch.id).map((item) => { const linkedAction = actions.data.find((action) => action.id === item.process_action_id); return { id: item.id, measuredAt: item.measured_at, gravity: item.gravity, ph: Number(item.ph), temperature: Number(item.temperature_c), pressure: item.pressure_bar == null ? null : Number(item.pressure_bar), note: item.note || "", operatorId: item.operator_id, processActionId: item.process_action_id, actionType: linkedAction?.action_type || null }; }),
      actions: actions.data.filter((item) => item.batch_id === batch.id).map((item) => ({ id: item.id, type: item.action_type, performedAt: item.performed_at, gravity: item.gravity, ph: Number(item.ph), temperature: Number(item.temperature_c), pressure: item.pressure_bar == null ? null : Number(item.pressure_bar), note: item.note || "", operatorId: item.operator_id })),
      packagingRuns: packagingRuns.data.filter((item) => item.batch_id === batch.id).map((item) => ({ id: item.id, clientId: item.client_id, runNumber: item.run_number, volumeTons: Number(item.volume_tons), centrifugeLiters: item.centrifuge_liters == null ? null : Number(item.centrifuge_liters), status: item.status, filteredAt: item.filtered_at, packagedAt: item.packaged_at, gravity: item.gravity, ph: Number(item.ph), temperature: Number(item.temperature_c), pressure: item.pressure_bar == null ? null : Number(item.pressure_bar), co2Vol: item.co2_vol == null ? null : Number(item.co2_vol), operatorId: item.operator_id })),
    })),
    pendingSync: [],
    breweryId,
  };
}

export async function syncEvent(state, event, breweryId, sessionToken) {
  if (!navigator.onLine) return false;
  if (!sessionToken || !event.operatorId) throw new Error("Operatora sesija nav pieejama sinhronizācijai.");
  let payload;
  if (event.entity === "batch" && event.operation === "delete") {
    payload = { entity_id: event.entityId };
  } else if (event.entity === "batch") {
    const batch = state.batches.find((item) => item.id === event.entityId);
    const beer = state.beerTypes.find((item) => item.id === batch?.beerTypeId);
    if (!batch || !beer) return true;
    const fermenter = state.fermenters.find((item) => item.number === batch.fermenterNumber);
    if (!fermenter) throw new Error("Tvertnes dati nav ielādēti no Supabase.");
    payload = {
      beer: { id: beer.id, name: beer.name, og_target: beer.ogTarget, fg_target: beer.fgTarget, spund_gravity: beer.spundGravity, has_dry_hop: beer.hasDryHop, dry_hop_gravity: beer.dryHopGravity, cooling_gravity: beer.coolingGravity, co2_target: beer.co2Target },
      batch: { id: batch.id, beer_type_id: beer.id, fermenter_id: fermenter.id, batch_number: batch.batchNumber, brew_year: batch.year, sequence_number: batch.sequence, volume_tons: batch.volumeTons, brew_date: batch.brewDate, status: batch.status, og_target: batch.ogTarget, fg_target: batch.fgTarget, spund_gravity: batch.spundGravity, has_dry_hop: batch.hasDryHop, dry_hop_gravity: batch.dryHopGravity, cooling_gravity: batch.coolingGravity, co2_target: batch.co2Target, finished_at: batch.finishedAt || null },
    };
  } else {
    const batch = state.batches.find((item) => item.measurements.some((child) => child.id === event.entityId) || item.actions.some((child) => child.id === event.entityId) || (item.packagingRuns || []).some((child) => child.id === event.entityId));
    if (!batch) return true;
    if (event.entity === "measurement") {
      const item = batch.measurements.find((child) => child.id === event.entityId);
      payload = { item: { id: item.id, client_id: item.id, batch_id: batch.id, measured_at: item.measuredAt, gravity: item.gravity, ph: item.ph, temperature_c: item.temperature, pressure_bar: item.pressure, note: item.note || null, process_action_id: item.processActionId || null, action_type: item.actionType || null } };
    } else if (event.entity === "action") {
      const item = batch.actions.find((child) => child.id === event.entityId);
      payload = { item: { id: item.id, client_id: item.id, batch_id: batch.id, action_type: item.type, performed_at: item.performedAt, gravity: item.gravity, ph: item.ph, temperature_c: item.temperature, pressure_bar: item.pressure, note: item.note || null } };
    } else if (event.entity === "packagingRun") {
      const item = batch.packagingRuns.find((child) => child.id === event.entityId);
      payload = { item: { id: item.id, client_id: item.clientId || item.id, batch_id: batch.id, run_number: item.runNumber, volume_tons: item.volumeTons, centrifuge_liters: item.centrifugeLiters, status: item.status, filtered_at: item.filteredAt, packaged_at: item.packagedAt, gravity: item.gravity, ph: item.ph, temperature_c: item.temperature, pressure_bar: item.pressure, co2_vol: item.co2Vol } };
    } else {
      throw new Error("Neatbalstīts sinhronizācijas ieraksts.");
    }
  }
  throwOnError(await supabase.rpc("sync_operator_event", {
    session_token: sessionToken,
    expected_operator_id: event.operatorId,
    entity_type: event.entity,
    operation_type: event.operation,
    payload,
  }));
  return true;
}
