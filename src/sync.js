import { supabase } from "./supabase.js";

function throwOnError(result) {
  if (result.error) throw result.error;
  return result.data;
}

export async function fetchRemoteState(localState, breweryId, sessionToken = null) {
  const [fermenters, beerTypes, batches, measurements, actions, packagingRuns, workItems, workItemEvents] = await Promise.all([
    supabase.from("fermenters").select("*").order("number"),
    supabase.from("beer_types").select("*").order("name"),
    supabase.from("batches").select("*").order("brew_date"),
    supabase.from("measurements").select("*").order("measured_at"),
    supabase.from("process_actions").select("*").order("performed_at"),
    supabase.from("packaging_runs").select("*").order("filtered_at"),
    supabase.from("work_items").select("*").order("due_at"),
    supabase.from("work_item_events").select("*").order("created_at"),
  ]);
  [fermenters, beerTypes, batches, measurements, actions, packagingRuns, workItems, workItemEvents].forEach(throwOnError);
  let deletedBatches = localState.deletedBatches || [];
  if (sessionToken) {
    const deleted = await supabase.rpc("list_deleted_batches", { session_token: sessionToken });
    deletedBatches = throwOnError(deleted) || [];
  }
  const activeBatchRows = batches.data.filter((item) => !item.deleted_at);
  const activeMeasurements = measurements.data.filter((item) => !item.deleted_at);
  const activeActions = actions.data.filter((item) => !item.deleted_at);
  const activePackagingRuns = packagingRuns.data.filter((item) => !item.deleted_at);
  return {
    ...localState,
    fermenters: fermenters.data,
    beerTypes: beerTypes.data.map((item) => ({ id: item.id, version: item.version || 1, name: item.name, ogTarget: item.og_target, fgTarget: item.fg_target, spundGravity: item.spund_gravity, hasDryHop: item.has_dry_hop, dryHopGravity: item.dry_hop_gravity, coolingGravity: item.cooling_gravity, co2Target: Number(item.co2_target) })),
    batches: activeBatchRows.map((batch) => ({
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
      version: batch.version || 1,
      measurements: activeMeasurements.filter((item) => item.batch_id === batch.id).map((item) => { const linkedAction = activeActions.find((action) => action.id === item.process_action_id); return { id: item.id, version: item.version || 1, measuredAt: item.measured_at, gravity: item.gravity, ph: Number(item.ph), temperature: Number(item.temperature_c), pressure: item.pressure_bar == null ? null : Number(item.pressure_bar), note: item.note || "", operatorId: item.operator_id, processActionId: item.process_action_id, actionType: linkedAction?.action_type || null }; }),
      actions: activeActions.filter((item) => item.batch_id === batch.id).map((item) => ({ id: item.id, version: item.version || 1, type: item.action_type, performedAt: item.performed_at, gravity: item.gravity, ph: Number(item.ph), temperature: Number(item.temperature_c), pressure: item.pressure_bar == null ? null : Number(item.pressure_bar), note: item.note || "", operatorId: item.operator_id })),
      packagingRuns: activePackagingRuns.filter((item) => item.batch_id === batch.id).map((item) => ({ id: item.id, version: item.version || 1, clientId: item.client_id, runNumber: item.run_number, volumeTons: Number(item.volume_tons), centrifugeLiters: item.centrifuge_liters == null ? null : Number(item.centrifuge_liters), status: item.status, filteredAt: item.filtered_at, packagedAt: item.packaged_at, gravity: item.gravity, ph: Number(item.ph), temperature: Number(item.temperature_c), pressure: item.pressure_bar == null ? null : Number(item.pressure_bar), co2Vol: item.co2_vol == null ? null : Number(item.co2_vol), operatorId: item.operator_id })),
    })),
    deletedBatches: deletedBatches.map((item) => ({ id: item.id, batchNumber: item.batch_number, brewDate: item.brew_date, beerName: item.beer_name, version: item.version, deletedAt: item.deleted_at, deleteReason: item.delete_reason, deletedByName: item.deleted_by_name })),
    workItems: workItems.data.map((item) => ({ id:item.id, batchId:item.batch_id, occurrenceKey:item.occurrence_key, type:item.work_type, label:item.label, source:item.source, dueAt:item.due_at, status:item.status, acceptedBy:item.accepted_by, acceptedAt:item.accepted_at, completedBy:item.completed_by, completedAt:item.completed_at, postponedBy:item.postponed_by, postponedAt:item.postponed_at, postponeReason:item.postpone_reason, skippedBy:item.skipped_by, skippedAt:item.skipped_at, skipReason:item.skip_reason, linkedMeasurementId:item.linked_measurement_id, linkedActionId:item.linked_action_id, version:item.version })),
    workItemEvents: workItemEvents.data.map((item) => ({ id:item.id, workItemId:item.work_item_id, operatorId:item.operator_id, type:item.event_type, previousStatus:item.previous_status, newStatus:item.new_status, reason:item.reason, details:item.details, createdAt:item.created_at })),
    pendingSync: [],
    breweryId,
  };
}

export async function syncEvent(state, event, breweryId, sessionToken) {
  if (!navigator.onLine) return false;
  if (!sessionToken || !event.operatorId) throw new Error("Operatora sesija nav pieejama sinhronizācijai.");
  let payload;
  if (["processBundle", "packagingCompletion"].includes(event.entity)) {
    const batch = state.batches.find((item) => item.id === event.batchId);
    const action = batch?.actions.find((item) => item.id === event.actionId);
    const measurement = batch?.measurements.find((item) => item.id === event.measurementId);
    const packagingRun = batch?.packagingRuns?.find((item) => item.id === event.packagingRunId);
    const beer = state.beerTypes.find((item) => item.id === batch?.beerTypeId);
    const fermenter = state.fermenters.find((item) => item.number === batch?.fermenterNumber);
    if (!batch || !action || !beer || !fermenter) throw new Error("Saistītās darbības dati nav pieejami sinhronizācijai.");
    payload = {
      action: {
        operation: (event.expectedVersions?.action ?? 0) === 0 ? "create" : "update",
        expected_version: event.expectedVersions?.action ?? 0,
        item: { id: action.id, client_id: action.id, batch_id: batch.id, action_type: action.type, performed_at: action.performedAt, gravity: action.gravity, ph: action.ph, temperature_c: action.temperature, pressure_bar: action.pressure, note: action.note || null },
      },
      batch: {
        expected_version: event.expectedVersions?.batch ?? 0,
        beer_expected_version: event.expectedVersions?.beer ?? 0,
        beer: { id: beer.id, expected_version: event.expectedVersions?.beer ?? 0, name: beer.name, og_target: beer.ogTarget, fg_target: beer.fgTarget, spund_gravity: beer.spundGravity, has_dry_hop: beer.hasDryHop, dry_hop_gravity: beer.dryHopGravity, cooling_gravity: beer.coolingGravity, co2_target: beer.co2Target },
        item: { id: batch.id, beer_type_id: beer.id, fermenter_id: fermenter.id, batch_number: batch.batchNumber, brew_year: batch.year, sequence_number: batch.sequence, volume_tons: batch.volumeTons, brew_date: batch.brewDate, status: batch.status, og_target: batch.ogTarget, fg_target: batch.fgTarget, spund_gravity: batch.spundGravity, has_dry_hop: batch.hasDryHop, dry_hop_gravity: batch.dryHopGravity, cooling_gravity: batch.coolingGravity, co2_target: batch.co2Target, finished_at: batch.finishedAt || null },
      },
    };
    if (event.entity === "processBundle") {
      if (!measurement) throw new Error("Darbības mērījums nav pieejams sinhronizācijai.");
      payload.measurement = { expected_version: event.expectedVersions?.measurement ?? 0, item: { id: measurement.id, client_id: measurement.id, batch_id: batch.id, measured_at: measurement.measuredAt, gravity: measurement.gravity, ph: measurement.ph, temperature_c: measurement.temperature, pressure_bar: measurement.pressure, note: measurement.note || null, process_action_id: action.id, action_type: action.type } };
    } else {
      if (!packagingRun) throw new Error("Pildīšanas cikls nav pieejams sinhronizācijai.");
      payload.packaging = { expected_version: event.expectedVersions?.packagingRun ?? 0, item: { id: packagingRun.id, client_id: packagingRun.clientId || packagingRun.id, batch_id: batch.id, run_number: packagingRun.runNumber, volume_tons: packagingRun.volumeTons, centrifuge_liters: packagingRun.centrifugeLiters, status: packagingRun.status, filtered_at: packagingRun.filteredAt, packaged_at: packagingRun.packagedAt, gravity: packagingRun.gravity, ph: packagingRun.ph, temperature_c: packagingRun.temperature, pressure_bar: packagingRun.pressure, co2_vol: packagingRun.co2Vol } };
    }
  } else if (event.entity === "batch" && ["delete", "restore"].includes(event.operation)) {
    payload = { entity_id: event.entityId };
  } else if (event.entity === "batch") {
    const batch = state.batches.find((item) => item.id === event.entityId);
    const beer = state.beerTypes.find((item) => item.id === batch?.beerTypeId);
    if (!batch || !beer) return true;
    const fermenter = state.fermenters.find((item) => item.number === batch.fermenterNumber);
    if (!fermenter) throw new Error("Tvertnes dati nav ielādēti no Supabase.");
    payload = {
      beer: { id: beer.id, expected_version: event.beerExpectedVersion ?? beer.version ?? 0, name: beer.name, og_target: beer.ogTarget, fg_target: beer.fgTarget, spund_gravity: beer.spundGravity, has_dry_hop: beer.hasDryHop, dry_hop_gravity: beer.dryHopGravity, cooling_gravity: beer.coolingGravity, co2_target: beer.co2Target },
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
  const rpcName = event.workItemId ? "sync_operator_work_event" : "sync_operator_event_v2";
  const rpcArgs = {
    session_token: sessionToken,
    expected_operator_id: event.operatorId,
    entity_type: event.entity,
    operation_type: event.operation,
    payload,
    expected_version: event.expectedVersion ?? event.expectedVersions?.batch ?? 0,
    change_reason: event.reason || null,
  };
  if (event.workItemId) {
    rpcArgs.target_work_item_id = event.workItemId;
    rpcArgs.work_item_expected_version = event.workItemVersion;
  }
  throwOnError(await supabase.rpc(rpcName, rpcArgs));
  return true;
}
