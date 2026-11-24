import "./styles.css";
import { icons, createElement } from "lucide";
import { ACTION_LABELS, ACTION_TYPES, BATCH_STATUS, FERMENTERS, addDays, buildWorkTimeline, calculateHistoryStats, calculateLossLedger, completedPackagingVolume, detectMeasurementWarnings, formatBatchNumber, getDailyTasks, getFermenter, getRecommendedAction, packagingCyclesComplete, remainingInFermenter, requiredPackagingRuns, validateCo2, validateGravity, validatePh, validatePressure, validateTemperature } from "./domain.js";
import { loadState, saveState } from "./store.js";
import { isSupabaseConfigured, supabase } from "./supabase.js";
import { fetchRemoteState, syncEvent } from "./sync.js";
import { ANALYSIS_METRICS, averageCurve, carbonationReadiness, comparableBatches, fermentationMetrics, sameProfileBatches, seriesForBatch } from "./analytics.js";

const app = document.querySelector("#app");
let state = await loadState();
let route = new URLSearchParams(location.search).get("route") === "tasks" ? "tasks" : "dashboard";
let selectedBatchId = null;
let authSession = null;
let authMode = "login";
let brewery = null;
let operatorUnlocked = false;
let requestedWorkItemId = new URLSearchParams(location.search).get("work");
let selectedAnalysisBeerId = null;

const OPERATOR_ID_SESSION_KEY = "brewtracker-operator-id";
const OPERATOR_TOKEN_SESSION_KEY = "brewtracker-operator-session";

function clearOperatorSession() {
  sessionStorage.removeItem(OPERATOR_ID_SESSION_KEY);
  sessionStorage.removeItem(OPERATOR_TOKEN_SESSION_KEY);
  operatorUnlocked = false;
}

function operatorSessionToken() {
  return sessionStorage.getItem(OPERATOR_TOKEN_SESSION_KEY);
}

async function revokeCurrentOperatorSession() {
  const token = operatorSessionToken();
  if (token && isSupabaseConfigured && !navigator.onLine) {
    throw new Error("Lai droši beigtu operatora sesiju, nepieciešams interneta savienojums.");
  }
  if (token && isSupabaseConfigured) {
    const { error } = await supabase.rpc("revoke_operator_session", { session_token: token });
    if (error) throw error;
  }
  clearOperatorSession();
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character]);
}

function rememberOperatorSession(operatorId, sessionToken) {
  sessionStorage.setItem(OPERATOR_ID_SESSION_KEY, operatorId);
  sessionStorage.setItem(OPERATOR_TOKEN_SESSION_KEY, sessionToken);
}

async function createOperatorSession(operatorId, pin) {
  const { data, error } = await supabase.rpc("create_operator_session", {
    target_operator_id: operatorId,
    operator_pin: pin,
  });
  const session = Array.isArray(data) ? data[0] : data;
  if (error) throw error;
  return session?.session_token ? session : null;
}

async function revalidateOpenOperatorSession() {
  if (!operatorUnlocked || !navigator.onLine || !authSession) return;
  const token = operatorSessionToken();
  if (!token) { clearOperatorSession(); operatorUnlockPage(); return; }
  const { data, error } = await supabase.rpc("validate_operator_session", { session_token: token });
  if (error) return; // Preserve the token on retryable network/server failures.
  if (data !== state.activeOperatorId) {
    clearOperatorSession();
    operatorUnlockPage("Operatora sesija ir beigusies. Ievadi PIN, lai turpinātu.");
  }
}

function icon(name, size = 20) {
  return createElement(icons[name], { width: size, height: size, "stroke-width": 2.2 }).outerHTML;
}

function authPage(message = "", isError = false) {
  app.innerHTML = `<main class="auth-page"><section class="auth-card"><div class="auth-brand"><span class="brand-mark">BT</span><div><h1>BrewTracker Pro</h1><p>Alus fermentācijas procesa asistents</p></div></div><div class="auth-tabs"><button type="button" data-auth-mode="login" class="${authMode === "login" ? "active" : ""}">Ieiet</button><button type="button" data-auth-mode="signup" class="${authMode === "signup" ? "active" : ""}">Reģistrēties</button></div><form id="auth-form"><div class="field"><label>E-pasts</label><input name="email" type="email" autocomplete="email" required placeholder="daritava@epasts.lv"></div><div class="field"><label>Parole</label><input name="password" type="password" autocomplete="${authMode === "login" ? "current-password" : "new-password"}" minlength="8" required placeholder="Vismaz 8 rakstzīmes"></div>${authMode === "signup" ? `<div class="field"><label>Atkārto paroli</label><input name="passwordConfirm" type="password" autocomplete="new-password" minlength="8" required></div>` : ""}<div class="auth-message ${isError ? "error" : ""}">${escapeHtml(message)}</div><button class="primary full" type="submit">${authMode === "login" ? "Ieiet aplikācijā" : "Izveidot kontu"}</button></form><p class="auth-note">Šis būs viens kopīgs alus darītavas konts. Darbinieku darbības tiks nošķirtas ar operatoru profiliem un PIN.</p></section></main>`;
}

function onboardingPage(message = "") {
  app.innerHTML = `<main class="auth-page"><section class="auth-card"><div class="auth-brand"><span class="brand-mark">BT</span><div><h1>Sākotnējā iestatīšana</h1><p>Izveido alus darītavu un pirmo operatoru</p></div></div><form id="onboarding-form"><div class="field"><label>Alus darītavas nosaukums</label><input name="breweryName" required value="Labietis" autocomplete="organization"></div><div class="field"><label>Pirmā operatora vārds</label><input name="operatorName" required autocomplete="name" placeholder="Piemēram, Jānis"></div><div class="field"><label>Operatora PIN</label><input name="pin" type="password" inputmode="numeric" pattern="[0-9]{4,8}" minlength="4" maxlength="8" required placeholder="4–8 cipari"></div><div class="field"><label>Atkārto PIN</label><input name="pinConfirm" type="password" inputmode="numeric" pattern="[0-9]{4,8}" minlength="4" maxlength="8" required></div><div class="auth-message error">${escapeHtml(message)}</div><button class="primary full" type="submit">Izveidot darba vidi</button></form><p class="auth-note">Tiks automātiski izveidotas 13 fermentācijas tvertnes. Vēlāk varēsi pievienot pārējos operatorus.</p></section></main>`;
}

function operatorUnlockPage(message = "") {
  app.innerHTML = `<main class="auth-page"><section class="auth-card"><div class="auth-brand"><span class="brand-mark">BT</span><div><h1>Kas šobrīd strādā?</h1><p>${escapeHtml(brewery?.name || "BrewTracker Pro")}</p></div></div><form id="operator-unlock-form"><div class="field"><label>Operators</label><select name="operatorId" required><option value="">Izvēlies savu profilu</option>${state.operators.filter((operator) => operator.is_active !== false).map((operator) => `<option value="${escapeHtml(operator.id)}">${escapeHtml(operator.name)}</option>`).join("")}</select></div><div class="field"><label>PIN</label><input name="pin" type="password" inputmode="numeric" pattern="[0-9]{4,8}" minlength="4" maxlength="8" required placeholder="••••"></div><div class="auth-message error">${escapeHtml(message)}</div><button class="primary full" type="submit">Turpināt</button><button class="text-button auth-logout" type="button" data-auth-logout>Iziet no kopīgā konta</button></form></section></main>`;
}

async function loadWorkspace() {
  let { data: breweryData, error } = await supabase.from("breweries").select("id, name, data_version").maybeSingle();
  if (error?.code === "42703" || error?.code === "PGRST204") {
    const fallback = await supabase.from("breweries").select("id, name").maybeSingle();
    breweryData = fallback.data ? { ...fallback.data, data_version: null } : null;
    error = fallback.error;
  }
  if (error) {
    if (error.code === "42P01") onboardingPage("Datubāzes tabulas nav atrastas. Pārbaudi, vai pirmā SQL migrācija ir izpildīta.");
    else onboardingPage(`Neizdevās ielādēt darba vidi: ${error.message}`);
    return;
  }
  brewery = breweryData;
  if (!brewery) { onboardingPage(); return; }
  if (state.breweryDataVersion != null && state.breweryDataVersion !== brewery.data_version) {
    state.beerTypes = [];
    state.batches = [];
    state.pendingSync = [];
  }
  state.breweryDataVersion = brewery.data_version;
  state = await saveState(state);
  const { data: operators, error: operatorError } = await supabase.from("operators").select("id, name, is_active").order("created_at");
  if (operatorError) { operatorUnlockPage(`Neizdevās ielādēt operatorus: ${operatorError.message}`); return; }
  state.operators = operators || [];
  const rememberedOperator = sessionStorage.getItem(OPERATOR_ID_SESSION_KEY);
  const rememberedToken = sessionStorage.getItem(OPERATOR_TOKEN_SESSION_KEY);
  if (rememberedOperator && rememberedToken && state.operators.some((operator) => operator.id === rememberedOperator)) {
    const { data: validatedOperator, error: sessionError } = await supabase.rpc("validate_operator_session", { session_token: rememberedToken });
    if (!sessionError && validatedOperator === rememberedOperator) {
      state.activeOperatorId = rememberedOperator;
      operatorUnlocked = true;
      state = await saveState(state);
      await refreshRemoteState();
      render();
      return;
    }
    if (sessionError) {
      operatorUnlocked = false;
      operatorUnlockPage("Sesiju pašlaik nevar pārbaudīt. Savienojuma kļūdas dēļ tā nav dzēsta; mēģini vēlreiz.");
      return;
    }
  }
  clearOperatorSession();
  operatorUnlockPage();
}

async function submitOnboarding(form) {
  const data = Object.fromEntries(new FormData(form));
  if (data.pin !== data.pinConfirm) { onboardingPage("PIN kodi nesakrīt."); return; }
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true; button.textContent = "Veido darba vidi…";
  const { data: result, error } = await supabase.rpc("bootstrap_brewery", {
    brewery_name: data.breweryName.trim(),
    operator_name: data.operatorName.trim(),
    operator_pin: data.pin,
  });
  if (error) { onboardingPage(error.message.includes("Could not find") ? "Nav atrasta sākotnējās iestatīšanas funkcija. Izpildi jaunāko SQL migrāciju." : error.message); return; }
  brewery = { id: result.brewery_id, name: result.brewery_name };
  state.operators = [{ id: result.operator_id, name: result.operator_name, is_active: true }];
  let operatorSession;
  try {
    operatorSession = await createOperatorSession(result.operator_id, data.pin);
  } catch (sessionError) {
    operatorUnlockPage(`Darba vide izveidota, bet operatora sesiju neizdevās izveidot: ${sessionError.message}`);
    return;
  }
  if (!operatorSession) { operatorUnlockPage("Darba vide izveidota, bet PIN sesiju neizdevās izveidot."); return; }
  state.activeOperatorId = result.operator_id;
  operatorUnlocked = true;
  rememberOperatorSession(result.operator_id, operatorSession.session_token);
  state = await saveState(state);
  await refreshRemoteState();
  render();
  showDailyTasks(true);
  openRequestedWorkItem();
}

async function submitOperatorUnlock(form) {
  const data = Object.fromEntries(new FormData(form));
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true; button.textContent = "Pārbauda…";
  let operatorSession;
  try {
    operatorSession = await createOperatorSession(data.operatorId, data.pin);
  } catch (error) {
    operatorUnlockPage(`PIN pārbaudes kļūda: ${error.message}`);
    return;
  }
  if (!operatorSession) { operatorUnlockPage("Nepareizs PIN kods."); return; }
  state.activeOperatorId = data.operatorId;
  operatorUnlocked = true;
  rememberOperatorSession(data.operatorId, operatorSession.session_token);
  state = await saveState(state);
  await refreshRemoteState();
  render();
  openRequestedWorkItem();
}

function openRequestedWorkItem() {
  if (!requestedWorkItemId) return;
  const id=requestedWorkItemId;
  requestedWorkItemId=null;
  history.replaceState({},"",location.pathname);
  setTimeout(()=>workItemDialog(id),0);
}

async function refreshRemoteState() {
  if (!navigator.onLine || !brewery || !operatorUnlocked) return;
  try {
    const token = operatorSessionToken();
    if (!token) throw new Error("Operatora sesija nav pieejama.");
    const legacyEvents = state.pendingSync.filter((event) => !event.operatorId);
    if (legacyEvents.length) {
      const legacySummary = legacyEvents.slice(0, 5).map((event) => {
        const relatedBatch = state.batches.find((batch) => (
          batch.id === event.entityId
          || batch.measurements.some((entry) => entry.id === event.entityId)
          || batch.actions.some((entry) => entry.id === event.entityId)
          || (batch.packagingRuns || []).some((entry) => entry.id === event.entityId)
        ));
        const beerName = state.beerTypes.find((beer) => beer.id === relatedBatch?.beerTypeId)?.name;
        const context = relatedBatch ? `#${relatedBatch.batchNumber}${beerName ? ` ${beerName}` : ""}` : event.entity;
        return `${event.createdAt ? formatDate(event.createdAt) : "Datums nav zināms"} · ${context}`;
      }).join("\n");
      const remainingCount = Math.max(0, legacyEvents.length - 5);
      const takeOwnership = window.confirm(
        `${legacyEvents.length} vecāki bezsaistes ieraksti nav piesaistīti operatoram:\n\n${legacySummary}`
        + `${remainingCount ? `\n…un vēl ${remainingCount}` : ""}\n\n`
        + `Vai apstiprini to piesaisti operatoram “${currentOperator()?.name || "Operators"}” un sinhronizāciju?`,
      );
      if (!takeOwnership) {
        alert("Vecie bezsaistes ieraksti netika nosūtīti. Tie paliek šajā ierīcē līdz apstiprināšanai.");
        return;
      }
      const confirmedAt = new Date().toISOString();
      state.pendingSync = state.pendingSync.map((event) => (event.operatorId ? event : {
        ...event,
        operatorId: state.activeOperatorId,
        legacyAttribution: { operatorId: state.activeOperatorId, confirmedAt, confirmedByUser: true },
      }));
      state = await saveState(state);
    }
    let syncStopped = false;
    for (const event of [...state.pendingSync]) {
      try {
        await syncEvent(state, event, brewery.id, token);
        state.pendingSync = state.pendingSync.filter((item) => item.id !== event.id);
      } catch (error) {
        console.error("Queued synchronization failed", error);
        if (isTransientSyncError(error)) break;
        state.pendingSync = state.pendingSync.filter((item) => item.id !== event.id);
        state = await saveState(state);
        const conflict = /VERSION_CONFLICT/i.test(error.message || "");
        alert(conflict
          ? "Bezsaistes izmaiņa konfliktē ar jaunāku ierakstu citā ierīcē un netika piemērota. Ielādēta servera versija."
          : `Bezsaistes izmaiņu nevarēja saglabāt: ${friendlySyncError(error)}`);
        syncStopped = true;
        break;
      }
    }
    if (syncStopped) {
      await reloadRemotePreservingQueue(token);
      render();
      return;
    }
    const operatorId = state.activeOperatorId;
    const operators = state.operators;
    state = await fetchRemoteState(state, brewery.id, token);
    state.operators = operators;
    state.activeOperatorId = operatorId;
    await generatePersistedWorkItems(token);
    state = await saveState(state);
  } catch (error) {
    console.error("Supabase synchronization failed", error);
    if (!isTransientSyncError(error)) alert(`Datu ielāde neizdevās: ${friendlySyncError(error)}`);
  }
}

function generatedWorkPayload() {
  return buildWorkTimeline(state.batches).map((task) => {
    const type=task.type.replace(/^prediction_/, "");
    const batch=state.batches.find((item)=>item.id===task.batchId);
    const occurrenceKey = workOccurrenceKey(batch, type, task.date);
    return { batch_id: task.batchId, occurrence_key: occurrenceKey, work_type:type, label:task.label.replace(/^Prognozēts: /,""), source:task.source, due_at:rigaLocalDateTimeToIso(task.date, 7) };
  });
}

function workOccurrenceKey(batch, type, dateKey) {
  if (type === "measure") return `${batch.id}:measure:${dateKey}`;
  if (["filter", "package"].includes(type)) {
    const filtered = (batch.packagingRuns || []).find((run) => run.status === "filtered");
    const cycle = type === "package" && filtered
      ? filtered.runNumber
      : (batch.packagingRuns || []).length + 1;
    return `${batch.id}:${type}:cycle-${Math.max(1, cycle)}`;
  }
  return `${batch.id}:${type}`;
}

async function generatePersistedWorkItems(token = operatorSessionToken()) {
  if (!navigator.onLine || !token || !isSupabaseConfigured) return;
  const payload = generatedWorkPayload();
  if (payload.length) {
    const { error } = await supabase.rpc("upsert_work_items", { session_token: token, generated_items: payload });
    if (error) throw error;
  }
  const [items, events] = await Promise.all([
    supabase.from("work_items").select("*").order("due_at"),
    supabase.from("work_item_events").select("*").order("created_at"),
  ]);
  if (items.error) throw items.error;
  if (events.error) throw events.error;
  state.workItems = (items.data || []).map((item) => ({ id:item.id, batchId:item.batch_id, occurrenceKey:item.occurrence_key, type:item.work_type, label:item.label, source:item.source, dueAt:item.due_at, status:item.status, acceptedBy:item.accepted_by, acceptedAt:item.accepted_at, completedBy:item.completed_by, completedAt:item.completed_at, postponedBy:item.postponed_by, postponedAt:item.postponed_at, postponeReason:item.postpone_reason, skippedBy:item.skipped_by, skippedAt:item.skipped_at, skipReason:item.skip_reason, linkedMeasurementId:item.linked_measurement_id, linkedActionId:item.linked_action_id, version:item.version }));
  state.workItemEvents = (events.data || []).map((item) => ({ id:item.id, workItemId:item.work_item_id, operatorId:item.operator_id, type:item.event_type, previousStatus:item.previous_status, newStatus:item.new_status, reason:item.reason, details:item.details, createdAt:item.created_at }));
  const badgeCount=state.workItems.filter((item)=>!["completed","skipped"].includes(item.status) && rigaDateKey(item.dueAt)<=today()).length;
  if("setAppBadge" in navigator) navigator.setAppBadge(badgeCount).catch(()=>{});
}

async function saveAndSync(event) {
  if (["processBundle", "packagingCompletion"].includes(event.entity)) {
    const batch = state.batches.find((item) => item.id === event.batchId);
    const action = batch?.actions.find((item) => item.id === event.actionId);
    const measurement = batch?.measurements.find((item) => item.id === event.measurementId);
    const packagingRun = batch?.packagingRuns?.find((item) => item.id === event.packagingRunId);
    if (!batch || !action || (event.entity === "processBundle" && !measurement) || (event.entity === "packagingCompletion" && !packagingRun)) {
      alert("Saistītās darbības dati nav pilnīgi; nekas netika sinhronizēts.");
      return false;
    }
    const beer = state.beerTypes.find((item) => item.id === batch.beerTypeId);
    const expectedVersions = {
      batch: batch.version ?? 0,
      action: action.version ?? 0,
      measurement: measurement?.version ?? 0,
      packagingRun: packagingRun?.version ?? 0,
      beer: beer?.version ?? 0,
    };
    batch.version = expectedVersions.batch + 1;
    action.version = expectedVersions.action + 1;
    if (measurement) measurement.version = expectedVersions.measurement + 1;
    if (packagingRun) packagingRun.version = expectedVersions.packagingRun + 1;
    if (beer) beer.version = expectedVersions.beer + 1;
    event = { ...event, entityId: batch.id, expectedVersions, beerExpectedVersion: expectedVersions.beer };
  }
  const entity = findLocalEntity(event.entity, event.entityId);
  const expectedVersion = event.expectedVersion ?? entity?.version ?? event.expectedVersions?.batch ?? 0;
  if (entity) entity.version = expectedVersion + 1;
  let beerExpectedVersion;
  if (event.entity === "batch" && ["create", "update"].includes(event.operation)) {
    const batch = state.batches.find((item) => item.id === event.entityId);
    const beer = state.beerTypes.find((item) => item.id === batch?.beerTypeId);
    if (beer) {
      beerExpectedVersion = beer.version ?? 0;
      beer.version = beerExpectedVersion + 1;
    }
  }
  const attributedEvent = { ...event, expectedVersion, beerExpectedVersion, operatorId: state.activeOperatorId };
  state = await saveState(state, attributedEvent);
  if (!navigator.onLine || !brewery || !operatorUnlocked) return true;
  const queued = state.pendingSync.at(-1);
  try {
    await syncEvent(state, queued, brewery.id, operatorSessionToken());
    state.pendingSync = state.pendingSync.filter((item) => item.id !== queued.id);
    state = await saveState(state);
    if (queued.workItemId) await refreshRemoteState();
    return true;
  } catch (error) {
    console.error("Change synchronization failed", error);
    if (/VERSION_CONFLICT|ANOMALY_BASELINE_CHANGED/i.test(error.message || "")) {
      state.pendingSync = state.pendingSync.filter((item) => item.id !== queued.id);
      state = await saveState(state);
      alert(/ANOMALY_BASELINE_CHANGED/i.test(error.message || "")
        ? "Kopš ievades ir saglabāts jaunāks mērījums. Ielādēsim servera datus — pārbaudi novirzi un ievadi mērījumu vēlreiz."
        : "Šo ierakstu citā ierīcē jau mainīja. Tiks ielādēta jaunākā servera versija; pārbaudi datus un atkārto darbību.");
      await reloadRemotePreservingQueue(operatorSessionToken());
      render();
      return false;
    }
    if (/session invalid|session expired|does not match offline event/i.test(error.message || "")) {
      clearOperatorSession();
      operatorUnlockPage("Operatora sesija ir beigusies. Ievadi PIN, lai droši sinhronizētu izmaiņas.");
      return false;
    }
    if (isTransientSyncError(error)) return true;
    state.pendingSync = state.pendingSync.filter((item) => item.id !== queued.id);
    state = await saveState(state);
    alert(`Izmaiņu nevarēja saglabāt: ${friendlySyncError(error)}`);
    await reloadRemotePreservingQueue(operatorSessionToken());
    render();
    return false;
  }
}

function isTransientSyncError(error) {
  const message = `${error?.message || error || ""}`;
  const status = Number(error?.status || error?.statusCode || 0);
  return !navigator.onLine || status >= 500 || /failed to fetch|networkerror|network request|timeout|load failed/i.test(message);
}

function friendlySyncError(error) {
  const message = `${error?.message || error || "Nezināma kļūda"}`;
  if (/duplicate key|unique constraint|batches_active_number/i.test(message)) return "partijas numurs jau tiek izmantots.";
  if (/one_active_batch_per_fermenter/i.test(message)) return "tvertne jau ir aizņemta; vispirms atbrīvo tvertni.";
  if (/one_unreleased_batch_per_fermenter/i.test(message)) return "tvertne vēl ir piesaistīta citai partijai.";
  if (/VESSEL_NOT_READY/i.test(message)) return "tvertne ir netīra vai vēl nav gatava; vispirms reģistrē mazgāšanu.";
  return message;
}

async function reloadRemotePreservingQueue(token) {
  const pendingSync = [...state.pendingSync];
  const operatorId = state.activeOperatorId;
  const operators = state.operators;
  const remote = await fetchRemoteState(state, brewery.id, token);
  state = { ...remote, pendingSync, operators, activeOperatorId: operatorId };
  state = await saveState(state);
}

function findLocalEntity(entity, id) {
  if (entity === "batch") return state.batches.find((item) => item.id === id);
  for (const batch of state.batches) {
    if (entity === "measurement") { const item = batch.measurements.find((value) => value.id === id); if (item) return item; }
    if (entity === "action") { const item = batch.actions.find((value) => value.id === id); if (item) return item; }
    if (entity === "packagingRun") { const item = (batch.packagingRuns || []).find((value) => value.id === id); if (item) return item; }
  }
  return null;
}

async function submitAuth(form) {
  const data = Object.fromEntries(new FormData(form));
  if (authMode === "signup" && data.password !== data.passwordConfirm) {
    authPage("Paroles nesakrīt.", true);
    return;
  }
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  submit.textContent = "Lūdzu, uzgaidi…";
  const result = authMode === "login"
    ? await supabase.auth.signInWithPassword({ email: data.email, password: data.password })
    : await supabase.auth.signUp({ email: data.email, password: data.password });
  if (result.error) {
    authPage(result.error.message === "Invalid login credentials" ? "Nepareizs e-pasts vai parole." : result.error.message, true);
    return;
  }
  if (authMode === "signup" && !result.data.session) {
    authMode = "login";
    authPage("Konts izveidots. Pārbaudi e-pastu un apstiprini reģistrāciju, pēc tam ienāc.");
    return;
  }
  authSession = result.data.session;
  await loadWorkspace();
}

function activeBatches() { return state.batches.filter((batch) => batch.status !== BATCH_STATUS.FINISHED); }
function activePackagingRun() { return state.batches.flatMap((batch) => (batch.packagingRuns || []).map((run) => ({ ...run, batch }))).find((item) => item.status === "filtered"); }
function vesselRecord(number) { return state.fermenters.find((item) => Number(item.number) === Number(number)); }
function vesselIsReady(number) { return ["free_clean", "legacy_ready"].includes(vesselRecord(number)?.cleanlinessStatus || "legacy_ready"); }
function vesselIsOccupied(number) {
  if (Number(number) === 13) return Boolean(activePackagingRun());
  return activeBatches().some((batch) => batch.fermenterNumber === Number(number) && !batch.fermenterReleasedAt);
}
function currentOperator() { return state.operators.find((operator) => operator.id === state.activeOperatorId) || state.operators[0]; }
function today() { return rigaDateKey(); }
function rigaDateKey(value = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone:"Europe/Riga", year:"numeric", month:"2-digit", day:"2-digit" }).format(new Date(value));
}
function rigaLocalDateTimeToIso(dateKey, hour = 7, minute = 0) {
  const desired = Date.UTC(Number(dateKey.slice(0,4)), Number(dateKey.slice(5,7))-1, Number(dateKey.slice(8,10)), hour, minute);
  let instant = desired;
  for (let attempt=0; attempt<2; attempt+=1) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone:"Europe/Riga", hour12:false, year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit" }).formatToParts(new Date(instant)).filter((part)=>part.type!=="literal").map((part)=>[part.type,part.value]));
    const represented = Date.UTC(Number(parts.year),Number(parts.month)-1,Number(parts.day),Number(parts.hour)%24,Number(parts.minute));
    instant += desired-represented;
  }
  return new Date(instant).toISOString();
}
function localDateTimeValue(value = new Date()) {
  const date = new Date(value);
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}
function formatDate(value) { return new Intl.DateTimeFormat("lv-LV", { day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(`${value.slice(0, 10)}T00:00:00`)); }

function dailyTaskItems() {
  if (isSupabaseConfigured && state.workItems?.length) {
    return state.workItems.filter((item) => !["completed", "skipped"].includes(item.status) && rigaDateKey(item.dueAt) <= today()).map((item) => {
      const batch = state.batches.find((candidate) => candidate.id === item.batchId);
      const beer = state.beerTypes.find((candidate) => candidate.id === batch?.beerTypeId);
      return { ...item, batch, beerName: beer?.name || "Nezināms alus", tone: rigaDateKey(item.dueAt) < today() ? "overdue" : "urgent" };
    }).filter((item) => item.batch);
  }
  return activeBatches().flatMap((batch) => {
    const beer = state.beerTypes.find((item) => item.id === batch.beerTypeId);
    const tasks = getDailyTasks(batch);
    const completed = new Set((batch.actions || []).map((action) => action.type));
    const stats = calculateHistoryStats(state.batches, batch.beerTypeId);
    const predictableActions = [ACTION_TYPES.SPUND, ...(batch.hasDryHop ? [ACTION_TYPES.DRY_HOP] : []), ACTION_TYPES.COOL];
    for (const type of predictableActions) {
      const stat = stats[type];
      if (!stat || completed.has(type) || tasks.some((task) => task.type === type)) continue;
      const predictedDate = addDays(batch.brewDate, stat.averageDays);
      if (predictedDate <= today()) {
        tasks.push({ type: `check_${type}`, label: `Pārbaudi — prognozēts: ${ACTION_LABELS[type]}`, tone: "ready" });
      }
    }
    return tasks.map((task) => ({ ...task, batch, beerName: beer?.name || "Nezināms alus" }));
  });
}

function showDailyTasks(sendSystemNotification = false) {
  const tasks = dailyTaskItems();
  if (!tasks.length) return;
  const dialog = document.createElement("dialog");
  dialog.innerHTML = `<div class="dialog-card daily-dialog"><button class="dialog-close" data-close-daily>${icon("X")}</button><p class="eyebrow">Šodienas darbi</p><h2>${tasks.length} ${tasks.length === 1 ? "uzdevums" : "uzdevumi"}</h2><p>Atvēršana darbu nepieņem. Izvēlies darbu un nospied “Pieņemt”.</p><div class="daily-task-list">${tasks.map((task) => `<button ${task.id ? `data-open-work-item="${escapeHtml(task.id)}"` : `data-daily-batch="${escapeHtml(task.batch.id)}"`} class="daily-task ${escapeHtml(task.tone)}"><span class="tank-number">${escapeHtml(task.batch.fermenterNumber)}</span><span><strong>${escapeHtml(task.beerName)}</strong><small>#${escapeHtml(task.batch.batchNumber)} · ${escapeHtml(task.label)}</small></span>${icon("ChevronRight")}</button>`).join("")}</div><button class="secondary full" data-close-daily>Aizvērt</button></div>`;
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog || event.target.closest("[data-close-daily]")) dialog.close();
    const batchButton = event.target.closest("[data-daily-batch]");
    if (batchButton) {
      selectedBatchId = batchButton.dataset.dailyBatch;
      route = "batch";
      dialog.close();
      render();
    }
    const workButton = event.target.closest("[data-open-work-item]");
    if (workButton) { dialog.close(); workItemDialog(workButton.dataset.openWorkItem); }
  });
  dialog.showModal();

  if (sendSystemNotification && "Notification" in window && Notification.permission === "granted") {
    navigator.serviceWorker?.ready.then((registration) => registration.showNotification("BrewTracker Pro — šodienas darbi", {
      body: tasks.slice(0, 3).map((task) => `Tvertne ${task.batch.fermenterNumber}: ${task.label}`).join("\n"),
      icon: "/icons/brewtracker.svg",
      badge: "/icons/brewtracker.svg",
      tag: `brewtracker-${today()}`,
    }));
  }
}

async function enableNotifications() {
  if (!("Notification" in window) || !("PushManager" in window) || !("serviceWorker" in navigator)) {
    alert("Šis pārlūks neatbalsta Web Push paziņojumus.");
    return;
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    alert("Paziņojumi netika atļauti. Tos vari ieslēgt Chrome vietnes iestatījumos.");
    render();
    return;
  }
  try {
    const configResponse = await fetch("/.netlify/functions/push-config");
    if (!configResponse.ok) throw new Error("Netlify Web Push atslēgas vēl nav konfigurētas.");
    const { publicKey } = await configResponse.json();
    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
    }
    const value = subscription.toJSON();
    const { error } = await supabase.rpc("register_push_subscription", {
      subscription_endpoint: value.endpoint,
      subscription_p256dh: value.keys.p256dh,
      subscription_auth: value.keys.auth,
      subscription_user_agent: navigator.userAgent,
    });
    if (error) throw error;
    alert("Web Push ieslēgts šim datoram. Katru rītu ap 07:00 saņemsi paziņojumu, ja būs neizpildīti darbi.");
  } catch (error) {
    alert(`Web Push neizdevās ieslēgt: ${error.message}`);
  }
  render();
}

function urlBase64ToUint8Array(value) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((character) => character.charCodeAt(0)));
}

function shell(content, title = "BrewTracker") {
  const taskCount = dailyTaskItems().length;
  app.innerHTML = `<div class="app-shell"><header class="topbar"><button class="brand" data-route="dashboard"><span class="brand-mark">BT</span><span>${escapeHtml(title)}</span></button><nav class="desktop-nav"><button data-route="dashboard" class="${route === "dashboard" ? "active" : ""}">${icon("LayoutDashboard", 17)} Tvertnes</button><button data-route="tasks" class="${route === "tasks" ? "active" : ""}">${icon("ListTodo", 17)} Darbi</button><button data-route="history" class="${route === "history" ? "active" : ""}">${icon("History", 17)} Vēsture</button><button data-route="analytics" class="${route === "analytics" ? "active" : ""}">${icon("ChartNoAxesCombined", 17)} Analīze</button><button data-route="settings" class="${route === "settings" ? "active" : ""}">${icon("Settings", 17)} Iestatījumi</button></nav>${taskCount ? `<button class="task-bell" data-show-daily-tasks title="Šodienas darbi">${icon("BellRing", 18)}<span>${taskCount}</span></button>` : ""}<div class="network ${navigator.onLine ? "online" : "offline"}">${navigator.onLine ? "Tiešsaistē" : "Bezsaistē"}</div><button class="operator" data-action="operators">${icon("UserRound", 18)} ${escapeHtml(currentOperator()?.name || "Operators")}</button></header>${content}<nav class="bottom-nav"><button data-route="dashboard" class="${route === "dashboard" ? "active" : ""}">${icon("LayoutDashboard")}<span>Tvertnes</span></button><button data-route="tasks" class="${route === "tasks" ? "active" : ""}">${icon("ListTodo")}<span>Darbi</span></button><button data-route="history" class="${route === "history" ? "active" : ""}">${icon("History")}<span>Vēsture</span></button><button data-route="analytics" class="${route === "analytics" ? "active" : ""}">${icon("ChartNoAxesCombined")}<span>Analīze</span></button><button data-route="settings" class="${route === "settings" ? "active" : ""}">${icon("Settings")}<span>Iestatījumi</span></button></nav></div>`;
  const advisoryMethod = app.querySelector('#carbonation-advisory-form [name="co2MeasurementMethod"]');
  if (advisoryMethod) {
    const field = advisoryMethod.closest(".field");
    field.innerHTML = "<label>CO₂ mērījuma metode</label><p class=\"field-hint\">Metodi ieraksti pie jaunākā CO₂ mērījuma, nevis šeit.</p>";
  }
}

function dashboard() {
  const batches = activeBatches();
  const readyCount = FERMENTERS.filter((tank) => tank.type === "fermenter" && !vesselIsOccupied(tank.number) && vesselIsReady(tank.number)).length;
  shell(`<main><section class="page-heading"><div><p class="eyebrow">Fermentācijas pārskats</p><h1>Kas jādara šodien?</h1></div><button class="primary" data-action="new-batch">${icon("Plus")} Jauna partija</button></section><section class="summary"><article><strong>${batches.length}</strong><span>aktīvas partijas</span></article><article><strong>${readyCount}</strong><span>gatavas tvertnes</span></article><article><strong>${batches.filter((batch) => getRecommendedAction(batch).tone === "urgent").length}</strong><span>steidzamas darbības</span></article></section><section class="tank-grid">${FERMENTERS.map((tank) => tankCard(tank.number)).join("")}</section></main>`, "BrewTracker Pro");
}

function tankCard(number) {
  const vessel = getFermenter(number);
  if (vessel.type === "brite") {
    const activeRun = activePackagingRun();
    const beer = activeRun && state.beerTypes.find((item) => item.id === activeRun.batch.beerTypeId);
    const record = vesselRecord(number);
    const status = record?.cleanlinessStatus || "legacy_ready";
    const chemicals = (record?.lastCleaningChemicals || []).join(" ");
    return activeRun
      ? `<article class="tank-card brite occupied" data-open-batch="${activeRun.batch.id}"><div class="tank-number">D</div><div class="tank-main"><div class="card-top"><span class="batch-no">DZIDRA · ${activeRun.volumeTons} t</span><span class="days">Cikls ${activeRun.runNumber}</span></div><h2>${escapeHtml(beer?.name || "Alus")}</h2><p>Izfiltrēts, gaida pildīšanu</p><div class="recommendation urgent">${icon("PackageCheck", 18)} Sapildīt no Dzidras</div></div>${icon("ChevronRight")}</article>`
      : `<article class="tank-card brite empty ${vesselIsReady(number) ? "clean" : "dirty"}"><div class="tank-number">D</div><div class="tank-main"><h2>Dzidra</h2><p>4 t Brite Tank · ${status === "legacy_ready" ? "brīva · gatava (pārnests statuss)" : vesselIsReady(number) ? "brīva · tīra" : "brīva · netīra"}</p>${chemicals ? `<div class="chemical-badges">${chemicals.split(" ").map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>` : ""}${record?.consecutiveAcidSkips >= 2 ? `<small class="acid-warning">Nākamajā mazgāšanā obligāti A</small>` : ""}</div><button class="vessel-toggle" data-vessel-cleaning="${number}" aria-label="${vesselIsReady(number) ? "Atzīmēt Dzidru kā netīru" : "Reģistrēt Dzidras mazgāšanu"}">${icon(vesselIsReady(number) ? "ToggleRight" : "Waves")}<span>${vesselIsReady(number) ? "Atzīmēt netīru" : "Mazgāt"}</span></button></article>`;
  }
  const batch = activeBatches().find((item) => item.fermenterNumber === number && !item.fermenterReleasedAt);
  if (!batch) {
    const record = vesselRecord(number);
    const status = record?.cleanlinessStatus || "legacy_ready";
    const ready = vesselIsReady(number);
    const chemicals = record?.lastCleaningChemicals || [];
    const heading = status === "legacy_ready" ? "Brīva · gatava" : `Brīva · ${ready ? "tīra" : "netīra"}`;
    return `<article class="tank-card empty ${ready ? "clean" : "dirty"}"><div class="tank-number">${number}</div><div class="tank-main"><h2>${heading}</h2><p>Kapacitāte ${vessel.capacityTons} t${status === "legacy_ready" ? " · pārnests statuss" : ""}</p>${chemicals.length ? `<div class="chemical-badges">${chemicals.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>` : ""}${record?.consecutiveAcidSkips >= 2 ? `<small class="acid-warning">Nākamajā mazgāšanā obligāti S A D</small>` : ""}</div>${ready ? `<button data-action="new-batch" data-tank="${number}" title="Jauna partija">${icon("Plus")}</button>` : ""}<button class="vessel-toggle" data-vessel-cleaning="${number}" aria-label="${ready ? `Atzīmēt tvertni ${number} kā netīru` : `Reģistrēt tvertnes ${number} mazgāšanu`}">${icon(ready ? "ToggleRight" : "Waves")}<span>${ready ? "Atzīmēt netīru" : "Mazgāt"}</span></button></article>`;
  }
  const beer = state.beerTypes.find((item) => item.id === batch.beerTypeId);
  const latest = batch.measurements.at(-1);
  const recommendation = getRecommendedAction(batch);
  const remaining = remainingInFermenter(batch);
  return `<article class="tank-card occupied" data-open-batch="${batch.id}"><div class="tank-number">${number}</div><div class="tank-main"><div class="card-top"><span class="batch-no">#${escapeHtml(batch.batchNumber)}</span><span class="days">${Math.max(0, Math.floor((Date.now() - new Date(batch.brewDate)) / 86400000))}. diena</span></div><h2>${escapeHtml(beer?.name || "Nezināms alus")} <small>${remaining} t${remaining !== Number(batch.volumeTons) ? ` palikušas no ${batch.volumeTons} t` : ""}</small></h2><p>${latest ? `Blīvums ${latest.gravity} · pH ${latest.ph} · ${latest.temperature} °C` : "Vēl nav mērījumu"}</p><div class="recommendation ${recommendation.tone}">${icon(recommendation.tone === "urgent" ? "TriangleAlert" : "CircleCheck", 18)} ${recommendation.label}</div></div>${icon("ChevronRight")}</article>`;
}

function newBatchForm(tank = "") {
  const currentYear = new Date().getFullYear();
  const existingThisYear = state.batches.filter((batch) => batch.year === currentYear);
  const nextSequence = existingThisYear.length ? Math.max(...existingThisYear.map((batch) => batch.sequence)) + 1 : 1;
  const beerOptions = state.beerTypes.map((beer) => `<option value="${escapeHtml(beer.name)}">`).join("");
  shell(`<main class="narrow"><button class="text-button" data-route="dashboard">${icon("ArrowLeft")} Atpakaļ</button><section class="page-heading"><div><p class="eyebrow">Jauna fermentācija</p><h1>Izveidot partiju</h1></div></section><form id="batch-form" class="form-card"><div class="field full"><label>Alus nosaukums</label><input name="beerName" list="beer-types" required autocomplete="off"><datalist id="beer-types">${beerOptions}</datalist><small>Esošam nosaukumam tiks izmantoti saglabātie sliekšņi.</small></div><div class="field"><label>Tilpums, tonnas</label><input name="volumeTons" type="number" min="0.1" step="0.1" required></div><div class="field"><label>Vārīšanas datums</label><input name="brewDate" type="date" value="${today()}" required></div><div class="field"><label>Kārtas numurs gadā</label><input name="sequence" type="number" min="1" max="999" value="${nextSequence}" required></div><div class="field"><label>Fermentācijas tvertne</label><select name="fermenterNumber" required><option value="">Izvēlies tīru tvertni</option>${FERMENTERS.filter((item) => item.type === "fermenter").map((item) => { const occupied=vesselIsOccupied(item.number); const ready=vesselIsReady(item.number); return `<option value="${item.number}" ${String(item.number) === String(tank) ? "selected" : ""} ${occupied || !ready ? "disabled" : ""}>${item.name} · max ${item.capacityTons} t${occupied ? " — aizņemta" : !ready ? " — netīra" : " — tīra"}</option>`; }).join("")}</select></div><hr><h2 class="full">Procesa sliekšņi</h2><div class="field"><label>Sākotnējais blīvums (OG)</label><input name="ogTarget" inputmode="numeric" placeholder="1056" required></div><div class="field"><label>Gala blīvums (FG)</label><input name="fgTarget" inputmode="numeric" placeholder="1012" required></div><div class="field"><label>Vārstu aizgriezt pie</label><input name="spundGravity" inputmode="numeric" placeholder="1026" required></div><div class="field"><label>Dzesēt uz 0 °C pie</label><input name="coolingGravity" inputmode="numeric" placeholder="1018" required></div><label class="check full"><input name="hasDryHop" type="checkbox"><span>Šim alum ir Dry Hop</span></label><div class="field" id="dry-hop-field" hidden><label>Dry Hop pie blīvuma</label><input name="dryHopGravity" inputmode="numeric" placeholder="1022"></div><div class="field"><label>Mērķa CO₂, vol</label><input name="co2Target" type="number" min="1" max="4" step="0.1" value="2.4" required></div><div class="form-error full" id="form-error"></div><button class="primary full" type="submit">Izveidot partiju</button></form></main>`, "Jauna partija");
  const checkbox = document.querySelector('[name="hasDryHop"]');
  const beerInput = document.querySelector('[name="beerName"]');
  checkbox.addEventListener("change", () => document.querySelector("#dry-hop-field").hidden = !checkbox.checked);
  beerInput.addEventListener("change", () => {
    const beer = state.beerTypes.find((item) => item.name.toLocaleLowerCase("lv") === beerInput.value.trim().toLocaleLowerCase("lv"));
    if (!beer) return;
    ["ogTarget", "fgTarget", "spundGravity", "coolingGravity", "dryHopGravity", "co2Target"].forEach((name) => { document.querySelector(`[name="${name}"]`).value = beer[name] ?? ""; });
    checkbox.checked = beer.hasDryHop; checkbox.dispatchEvent(new Event("change"));
  });
}

async function submitBatch(form) {
  try {
    if (isSupabaseConfigured && !navigator.onLine) throw new Error("Jaunu partiju var sākt tikai tiešsaistē, lai pārbaudītu tvertnes tīrību.");
    const data = Object.fromEntries(new FormData(form));
    const year = Number(data.brewDate.slice(0, 4));
    const sequence = Number(data.sequence);
    const fermenterNumber = Number(data.fermenterNumber);
    const vessel = getFermenter(fermenterNumber);
    if (!vessel || vessel.type !== "fermenter") throw new Error("Izvēlies fermentācijas tvertni no 1 līdz 12.");
    if (Number(data.volumeTons) > vessel.capacityTons) throw new Error(`${vessel.name} maksimālā ietilpība ir ${vessel.capacityTons} t.`);
    const batchNumber = formatBatchNumber(year, sequence, fermenterNumber);
    if (state.batches.some((batch) => batch.batchNumber === batchNumber)) throw new Error(`Partija ${batchNumber} jau eksistē.`);
    if (vesselIsOccupied(fermenterNumber)) throw new Error(`Tvertne ${fermenterNumber} jau ir aizņemta.`);
    if (!vesselIsReady(fermenterNumber)) throw new Error(`Tvertne ${fermenterNumber} nav tīra un gatava jaunam alum.`);
    let beer = state.beerTypes.find((item) => item.name.toLocaleLowerCase("lv") === data.beerName.trim().toLocaleLowerCase("lv"));
    const targets = { ogTarget: validateGravity(data.ogTarget), fgTarget: validateGravity(data.fgTarget), spundGravity: validateGravity(data.spundGravity), coolingGravity: validateGravity(data.coolingGravity), hasDryHop: data.hasDryHop === "on", dryHopGravity: data.hasDryHop === "on" ? validateGravity(data.dryHopGravity) : null, co2Target: Number(data.co2Target) };
    if (!beer) { beer = { id: crypto.randomUUID(), name: data.beerName.trim(), ...targets }; state.beerTypes.push(beer); }
    else Object.assign(beer, targets);
    const batch = { id: crypto.randomUUID(), version: 0, batchNumber, year, sequence, fermenterNumber, beerTypeId: beer.id, volumeTons: Number(data.volumeTons), brewDate: data.brewDate, status: BATCH_STATUS.ACTIVE, ...targets, measurements: [], actions: [], packagingRuns: [], createdAt: new Date().toISOString(), createdBy: currentOperator().id };
    state.batches.push(batch);
    if (!await saveAndSync({ entity: "batch", operation: "create", entityId: batch.id })) return;
    selectedBatchId = batch.id; route = "batch"; render();
  } catch (error) { document.querySelector("#form-error").textContent = error.message; }
}

function batchDetail() {
  const batch = state.batches.find((item) => item.id === selectedBatchId);
  if (!batch) { route = "dashboard"; return dashboard(); }
  const rawBeer = state.beerTypes.find((item) => item.id === batch.beerTypeId);
  const beer = { ...rawBeer, name: escapeHtml(rawBeer?.name || "Nezināms alus") };
  const recommendation = getRecommendedAction(batch);
  const stats = calculateHistoryStats(state.batches, batch.beerTypeId);
  shell(`<main class="narrow"><button class="text-button" data-route="dashboard">${icon("ArrowLeft")} Visas tvertnes</button><section class="batch-hero"><div><span class="batch-no">#${escapeHtml(batch.batchNumber)} · Tvertne ${escapeHtml(batch.fermenterNumber)}</span><h1>${escapeHtml(beer.name)} <small>${remainingInFermenter(batch)} t tvertnē no ${batch.volumeTons} t</small></h1><p>Sākts ${formatDate(batch.brewDate)}</p></div><div class="hero-actions"><span class="status">${batch.status === BATCH_STATUS.FINISHED ? "Pabeigts" : "Aktīvs"}</span><button class="danger-button" data-delete-batch="${batch.id}">${icon("Trash2", 17)} Dzēst partiju</button></div></section><section class="action-banner ${recommendation.tone}"><div>${icon("Sparkles", 24)}<span><small>Ieteicamā darbība</small><strong>${recommendation.label}</strong></span></div></section>${predictionPanel(batch, stats)}<section class="detail-grid"><article class="panel"><div class="panel-title"><h2>Jauns mērījums</h2><span>Var saglabāt bez interneta</span></div><form id="measurement-form" class="measurement-form"><div class="field full"><label>Mērījuma datums un laiks</label><input name="measuredAt" type="datetime-local" value="${localDateTimeValue()}" required></div><div class="field"><label>Blīvums</label><input name="gravity" inputmode="numeric" placeholder="1054" required></div><div class="field"><label>pH</label><input name="ph" type="number" min="0" step="0.01" placeholder="4.20" required></div><div class="field"><label>Temperatūra °C</label><input name="temperature" type="number" min="-5" max="50" step="0.1" placeholder="19.5" required></div><div class="field"><label>Spiediens bar</label><input name="pressure" type="number" min="0" max="2" step="0.01" placeholder="0.80"></div><div class="field"><label>CO₂, vol <small>(neobligāts)</small></label><input name="co2Vol" type="number" min="0" max="5" step="0.1" placeholder="—"></div><div class="field"><label>CO₂ metode/ierīce <small>(ja mērīts)</small></label><input name="co2MeasurementMethod" placeholder="Piem., CBox"></div><div class="field full"><label>Saistītā fermentācijas darbība</label><select name="actionType"><option value="">Nav — tikai mērījums</option><option value="spund">Aizgriezts vārsts</option>${batch.hasDryHop ? `<option value="dry_hop">Pievienots Dry Hop</option>` : ""}<option value="cool">Iestatīta dzesēšana uz 0 °C</option></select></div><div class="field full"><label>Piezīme</label><input name="note" placeholder="Neobligāta piezīme"></div><div class="form-error full" id="measurement-error"></div><button class="primary full">${icon("Save")} Saglabāt mērījumu</button></form></article><article class="panel"><div class="panel-title"><h2>Fermentācijas darbības</h2></div><div class="action-list">${[ACTION_TYPES.SPUND, ...(batch.hasDryHop ? [ACTION_TYPES.DRY_HOP] : []), ACTION_TYPES.COOL].map((type) => actionButton(batch, type)).join("")}</div></article></section>${packagingPanel(batch)}${lossLedgerPanel(batch)}<section class="panel"><div class="panel-title"><h2>Mērījumu vēsture</h2><span>${batch.measurements.length} ieraksti</span></div>${measurementTable(batch)}</section></main>`, beer.name);
}

function deleteBatchDialog(batchId) {
  const batch = state.batches.find((item) => item.id === batchId);
  const beer = state.beerTypes.find((item) => item.id === batch?.beerTypeId);
  if (!batch) return;
  const dialog = document.createElement("dialog");
  dialog.innerHTML = `<form method="dialog" class="dialog-card delete-dialog"><button class="dialog-close" value="cancel">${icon("X")}</button><p class="eyebrow danger-text">Atgriezeniska dzēšana</p><h2>Pārvietot partiju #${escapeHtml(batch.batchNumber)} uz miskasti?</h2><p>Partija “${escapeHtml(beer?.name || "Nezināms alus")}” pazudīs no darba skatiem un statistikas, bet to varēs atjaunot vēstures sadaļā.</p><div class="field"><label>Dzēšanas iemesls</label><input name="reason" required placeholder="Piemēram, testa partija vai kļūdaina ievade"></div><div class="dialog-actions"><button class="secondary" value="cancel">Atcelt</button><button class="danger-button solid" value="delete">${icon("Trash2", 17)} Pārvietot uz miskasti</button></div></form>`;
  document.body.append(dialog); dialog.showModal();
  dialog.addEventListener("close", async () => { if (dialog.returnValue === "delete") { const reason = new FormData(dialog.querySelector("form")).get("reason")?.trim(); if (reason) await deleteBatch(batchId, reason); } dialog.remove(); });
}

async function deleteBatch(batchId, reason) {
  const batch = state.batches.find((item) => item.id === batchId);
  if (!batch) return;
  const expectedVersion = batch.version || 0;
  const accepted = await saveAndSync({ entity: "batch", operation: "delete", entityId: batchId, expectedVersion, reason });
  if (!accepted) return;
  state.deletedBatches ||= [];
  state.deletedBatches.unshift({ id: batch.id, batchNumber: batch.batchNumber, brewDate: batch.brewDate, beerName: state.beerTypes.find((beer) => beer.id === batch.beerTypeId)?.name || "Nezināms alus", version: expectedVersion + 1, deletedAt: new Date().toISOString(), deleteReason: reason, deletedByName: currentOperator()?.name });
  state.batches = state.batches.filter((item) => item.id !== batchId);
  state = await saveState(state);
  selectedBatchId = null; route = "dashboard"; render();
}

function packagingPanel(batch) {
  const runs = batch.packagingRuns || [];
  const required = requiredPackagingRuns(batch.volumeTons);
  const packaged = completedPackagingVolume(batch);
  const coolingDone = batch.actions.some((action) => action.type === ACTION_TYPES.COOL);
  const briteBusy = activePackagingRun();
  const canFilter = coolingDone && runs.length < required && !briteBusy && batch.status !== BATCH_STATUS.FINISHED;
  return `<section class="panel packaging-panel"><div class="panel-title"><div><h2>Filtrēšana un pildīšana</h2><p>${packaged} no ${batch.volumeTons} t sapildītas · tvertnē palikušas ${remainingInFermenter(batch)} t</p></div>${canFilter ? `<button class="primary" data-filter-to-brite>${icon("ArrowRightLeft")} Filtrēt uz Dzidru</button>` : ""}</div><div class="packaging-runs">${runs.length ? runs.map((run) => `<article class="packaging-run ${run.status}"><div><span>Cikls ${run.runNumber} no ${required}</span><strong>${run.volumeTons} t · ${run.status === "filtered" ? "Dzidrā" : "Sapildīts"}</strong><small>${formatDate(run.filteredAt)}${run.packagedAt ? ` → ${formatDate(run.packagedAt)}` : ""}</small><small class="volume-run-meta">${run.sourceDrawnLiters != null ? `Uz centrifūgu ${run.sourceDrawnLiters} l` : "Uz centrifūgu —"} · ${run.briteReceivedLiters != null ? `Dzidrā ${run.briteReceivedLiters} l` : "Dzidrā —"} · ${run.centrifugeLiters != null ? `centrifūga bruto ${run.centrifugeLiters} l` : "centrifūga —"}${run.packagedLiters != null ? ` · sapildīts ${run.packagedLiters} l` : ""}</small></div>${run.status === "filtered" ? `<button class="primary" data-finish-packaging="${run.id}">${icon("PackageCheck")} Sapildīts</button>` : icon("CircleCheckBig", 28)}</article>`).join("") : `<div class="empty-state compact"><p>${coolingDone ? (briteBusy ? "Dzidra pašlaik ir aizņemta ar citu partiju." : "Alus gatavs filtrēšanai uz Dzidru.") : "Pirms filtrēšanas pabeidz dzesēšanu uz 0 °C."}</p></div>`}</div></section>`;
}

function liters(value) { return value == null ? "—" : `${Math.round(value)} l`; }
function lossValue(value, percent = null) { return value == null ? "—" : `${liters(value)}${percent == null ? "" : ` · ${percent.toFixed(1)}%`}`; }

function lossLedgerPanel(batch) {
  const ledger = calculateLossLedger(batch);
  const sourceIsMeasured = ledger.sourceLiters != null;
  return `<section class="panel loss-ledger"><div class="panel-title"><div><p class="eyebrow">Informatīva uzskaite</p><h2>Zudumu un iznākuma žurnāls</h2></div><span>Mērīts ≠ aprēķināts</span></div><p class="ledger-note">Centrifūgas bruto skaitītājs ietver discharge/tīrīšanas šķidrumu, tādēļ tas nekad netiek uzskatīts par Dzidrā saņemto alus daudzumu.</p><div class="ledger-grid"><article><small>Partijas nominālais apjoms</small><strong>${liters(ledger.nominalLiters)}</strong><em>ievadīts</em></article><article><small>Vārkatla atlikums</small><strong>${liters(ledger.kettleResidueEstimateLiters)}</strong><em>aprēķins: 150 l pēc katriem 2 t</em></article><article><small>Uz centrifūgu aizlaists</small><strong>${liters(ledger.sourceLiters)}</strong><em>${sourceIsMeasured ? "mērīts" : "nav izmērīts"}</em></article><article><small>Dzidrā saņemts</small><strong>${liters(ledger.briteLiters)}</strong><em>mērīts</em></article><article><small>Uz centrifūgu → Dzidra</small><strong>${lossValue(ledger.sourceToBriteLossLiters, ledger.sourceToBriteLossPercent)}</strong><em>${ledger.sourceToBriteLossLiters == null ? "vajag abus mērījumus" : "starpības zudums"}</em></article><article><small>Centrifūga bruto</small><strong>${liters(ledger.centrifugeGrossLiters)}</strong><em>${ledger.centrifugeSystemDifferenceLiters == null ? "nav produkta rādītājs" : `atšķirība no Dzidras: ${liters(ledger.centrifugeSystemDifferenceLiters)}`}</em></article><article><small>Sapildīts</small><strong>${liters(ledger.packagedLiters)}</strong><em>mērīts</em></article><article><small>Dzidra → pildīšana</small><strong>${lossValue(ledger.briteToPackageLossLiters, ledger.briteToPackageLossPercent)}</strong><em>${ledger.briteToPackageLossLiters == null ? "vajag abus mērījumus" : "starpības zudums"}</em></article><article><small>Tvertnes atlikums ar raugu</small><strong>${liters(ledger.fermenterHeelEstimateLiters)}</strong><em>${ledger.fermenterHeelEstimateLiters == null ? "aprēķins pēc pēdējā cikla" : "aprēķins: 4 t 200 l · 8 t 350 l"}</em></article><article><small>Kopējā iznākuma starpība</small><strong>${lossValue(ledger.totalNominalToPackageDifferenceLiters)}</strong><em>${ledger.yieldPercent == null ? "vajag sapildīto daudzumu" : `iznākums ${ledger.yieldPercent.toFixed(1)}% no nominālā`}</em></article></div></section>`;
}

function predictionPanel(batch, stats) {
  const items = [ACTION_TYPES.SPUND, ...(batch.hasDryHop ? [ACTION_TYPES.DRY_HOP] : []), ACTION_TYPES.COOL, ACTION_TYPES.FINISH];
  return `<section class="predictions">${items.map((type) => { const stat = stats[type]; const completed = batch.actions.find((action) => action.type === type); return `<article><span>${ACTION_LABELS[type]}</span><strong>${completed ? formatDate(completed.performedAt) : stat ? `ap ${formatDate(addDays(batch.brewDate, stat.averageDays))}` : "Vēl nav datu"}</strong><small>${completed ? "Izpildīts" : stat ? `Vidēji ${stat.averageDays.toFixed(1)} dienās · ${stat.count} partijas` : "Prognoze parādīsies pēc pabeigtas partijas"}</small></article>`; }).join("")}</section>`;
}

function actionButton(batch, type) {
  const action = batch.actions.find((item) => item.type === type);
  return `<button data-batch-action="${type}" class="process-action ${action ? "done" : ""}" ${batch.status === BATCH_STATUS.FINISHED ? "disabled" : ""}><span>${icon(action ? "CircleCheckBig" : "Circle", 22)}<span><strong>${ACTION_LABELS[type]}</strong><small>${action ? `${formatDate(action.performedAt)} · ${action.gravity ?? "—"}` : "Atzīmēt kā izpildītu"}</small></span></span>${icon("ChevronRight")}</button>`;
}

function measurementTable(batch) {
  if (!batch.measurements.length) return `<div class="empty-state">${icon("Gauge", 34)}<p>Vēl nav neviena mērījuma.</p></div>`;
  return `<div class="table-wrap"><table><thead><tr><th>Laiks</th><th>Darbība</th><th>Blīvums</th><th>pH</th><th>°C</th><th>bar</th><th>CO₂</th><th>Kvalitāte</th><th>Operators</th></tr></thead><tbody>${[...batch.measurements].reverse().map((item) => `<tr><td>${new Date(item.measuredAt).toLocaleString("lv-LV", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })}</td><td>${item.actionType ? `<span class="action-tag">${ACTION_LABELS[item.actionType]}</span>` : "—"}</td><td><strong>${item.gravity}</strong></td><td>${item.ph}</td><td>${item.temperature}</td><td>${item.pressure ?? "—"}</td><td>${item.co2Vol ?? "—"}</td><td>${anomalyDetails(item)}</td><td>${escapeHtml(state.operators.find((op) => op.id === item.operatorId)?.name || "—")}</td></tr>`).join("")}</tbody></table></div>`;
}

const ANOMALY_LABELS = { gravity_increase: "Blīvums pieaudzis", ph_unusual: "Neparasts pH", temperature_jump: "Strauja temperatūras maiņa", pressure_high: "Spiediens tuvu 2 bar", duplicate: "Iespējams dublikāts", timestamp_old: "Atpakaļdatēts mērījums", timestamp_future: "Laiks ir nākotnē" };

function anomalyDetails(item) {
  if (!item.warningCodes?.length) return "—";
  const details = item.warningCodes.map((code) => `<li>${escapeHtml(ANOMALY_LABELS[code] || code)}</li>`).join("");
  const reason = item.anomalyReason ? `<p><strong>Pamatojums:</strong> ${escapeHtml(item.anomalyReason)}</p>` : "";
  return `<details class="warning-details"><summary class="warning-badge" aria-label="Atvērt ${item.warningCodes.length} mērījuma brīdinājumus">${icon("TriangleAlert", 14)} ${item.warningCodes.length}</summary><ul>${details}</ul>${reason}</details>`;
}

function measurementContext(batch, measuredAt) {
  const sorted = [...batch.measurements].sort((a, b) => new Date(a.measuredAt) - new Date(b.measuredAt));
  return {
    previous: sorted.filter((item) => new Date(item.measuredAt) <= new Date(measuredAt)).at(-1) || null,
    latest: sorted.at(-1) || null,
  };
}

function validatedMeasurementDraft(data, measuredAt, actionType = null) {
  if (Number(data.ph) > 14 && Number(data.ph) <= 140) throw new Error(`pH ${data.ph} nav derīgs. Vai domāji ${(Number(data.ph) / 10).toFixed(1)}? Izlabo vērtību pirms saglabāšanas.`);
  return {
    measuredAt,
    gravity: validateGravity(data.gravity),
    ph: validatePh(data.ph),
    temperature: validateTemperature(data.temperature),
    pressure: validatePressure(data.pressure),
    co2Vol: validateCo2(data.co2Vol),
    co2MeasurementMethod: data.co2MeasurementMethod?.trim() || null,
    actionType,
  };
}

function confirmMeasurementWarnings(warnings, previous) {
  if (!warnings.length) return Promise.resolve({ confirmed: false, reason: null, confirmedAt: null });
  return new Promise((resolve) => {
    const critical = warnings.some((item) => item.severity === "critical");
    const dialog = document.createElement("dialog");
    dialog.innerHTML = `<form method="dialog" class="dialog-card anomaly-dialog"><button class="dialog-close" value="fix" formnovalidate>${icon("X")}</button><p class="eyebrow danger-text">Pārbaudi mērījumu</p><h2>Vērtības atšķiras no iepriekšējā ieraksta</h2>${previous ? `<p>Iepriekšējais mērījums: ${previous.gravity} · pH ${previous.ph} · ${previous.temperature} °C · ${previous.pressure ?? "—"} bar</p>` : ""}<ul class="anomaly-list">${warnings.map((item) => `<li class="${item.severity}">${icon(item.severity === "critical" ? "TriangleAlert" : "Info", 19)}<span>${escapeHtml(item.message)}</span></li>`).join("")}</ul>${critical ? `<div class="field"><label>Iemesls, kāpēc tomēr saglabāt</label><textarea name="reason" minlength="3" required placeholder="Piemēram, atkārtoti pārbaudīts ar otru mērierīci"></textarea></div>` : `<div class="field"><label>Piezīme par novirzi (neobligāta)</label><textarea name="reason" placeholder="Kas izskaidro atšķirību?"></textarea></div>`}<div class="dialog-actions"><button class="secondary" value="fix" formnovalidate>Labot</button><button class="primary" value="save">Tomēr saglabāt</button></div></form>`;
    document.body.append(dialog); dialog.showModal();
    dialog.addEventListener("close", () => {
      const reason = dialog.querySelector('[name="reason"]').value.trim();
      const save = dialog.returnValue === "save" && (!critical || reason.length >= 3);
      if (dialog.returnValue === "save" && critical && !save) alert("Kritiskai novirzei ieraksti īsu iemeslu.");
      dialog.remove();
      resolve(save ? { confirmed: true, reason: reason || null, confirmedAt: new Date().toISOString() } : null);
    });
  });
}

async function submitMeasurement(form) {
  try {
    const data = Object.fromEntries(new FormData(form));
    const batch = state.batches.find((item) => item.id === selectedBatchId);
    const measuredAt = new Date(data.measuredAt).toISOString();
    const { previous, latest } = measurementContext(batch, measuredAt);
    const draft = validatedMeasurementDraft(data, measuredAt, data.actionType || null);
    const warnings = detectMeasurementWarnings(draft, previous, batch.measurements, { latest });
    const override = await confirmMeasurementWarnings(warnings, previous);
    if (warnings.length && !override) return;
    if (!await ensureAcceptedWork(selectedBatchId, data.actionType || "measure")) return;
    let processActionId = null;
    if (data.actionType) {
      const previousAction = batch.actions.find((item) => item.type === data.actionType);
      const action = { id: previousAction?.id || crypto.randomUUID(), version: previousAction?.version || 0, type: data.actionType, performedAt: measuredAt, gravity: draft.gravity, ph: draft.ph, temperature: draft.temperature, pressure: draft.pressure, note: data.note.trim(), operatorId: currentOperator().id };
      batch.actions = batch.actions.filter((item) => item.type !== data.actionType);
      batch.actions.push(action);
      if (data.actionType === ACTION_TYPES.DRY_HOP) batch.status = BATCH_STATUS.DRY_HOP;
      if (data.actionType === ACTION_TYPES.COOL) batch.status = BATCH_STATUS.COOLING;
      processActionId = action.id;
    }
    const measurement = { id: crypto.randomUUID(), version: 0, ...draft, note: data.note.trim(), operatorId: currentOperator().id, processActionId, warningCodes: warnings.map((item) => item.code), warningDetails: warnings, anomalyConfirmedAt: override?.confirmedAt || null, anomalyReason: override?.reason || null, anomalyBaselineId: previous?.id || null };
    batch.measurements.push(measurement);
    const workItem=acceptedWorkItem(batch.id,data.actionType || "measure");
    if (data.actionType) {
      if (!await saveAndSync({ entity: "processBundle", operation: "apply", batchId: batch.id, actionId: processActionId, measurementId: measurement.id, workItemId:workItem.id, workItemVersion:workItem.version })) return;
    } else if (!await saveAndSync({ entity: "measurement", operation: "create", entityId: measurement.id, workItemId:workItem.id, workItemVersion:workItem.version })) return;
    render();
  } catch (error) { document.querySelector("#measurement-error").textContent = error.message; }
}

function actionDialog(type) {
  const batch = state.batches.find((item) => item.id === selectedBatchId);
  const latest = batch.measurements.at(-1);
  const dialog = document.createElement("dialog");
  dialog.innerHTML = `<form method="dialog" id="action-form" class="dialog-card"><button class="dialog-close" value="cancel">${icon("X")}</button><p class="eyebrow">Procesa darbība</p><h2>${ACTION_LABELS[type]}</h2><p>Fiksē mērījumus darbības izpildes brīdī.</p><div class="measurement-form"><div class="field full"><label>Darbības datums un laiks</label><input name="performedAt" type="datetime-local" value="${localDateTimeValue()}" required></div><div class="field"><label>Blīvums</label><input name="gravity" value="${latest?.gravity ?? ""}" required></div><div class="field"><label>pH</label><input name="ph" type="number" step="0.01" value="${latest?.ph ?? ""}" required></div><div class="field"><label>Temperatūra °C</label><input name="temperature" type="number" step="0.1" value="${latest?.temperature ?? ""}" required></div><div class="field"><label>Spiediens bar</label><input name="pressure" type="number" step="0.01" value="${latest?.pressure ?? ""}"></div><div class="field"><label>CO₂, vol <small>(neobligāts)</small></label><input name="co2Vol" type="number" min="0" max="5" step="0.1" value="${latest?.co2Vol ?? ""}"></div><div class="field"><label>CO₂ metode/ierīce <small>(vajag karbonizācijas analīzei)</small></label><input name="co2MeasurementMethod" value="${escapeHtml(latest?.co2MeasurementMethod ?? "")}" placeholder="Piem., CBox"></div><div class="form-error full" id="action-error"></div><button class="primary full" value="default">Apstiprināt darbību</button></div></form>`;
  document.body.append(dialog); dialog.showModal();
  dialog.addEventListener("close", async () => { if (dialog.returnValue === "default") await completeAction(type, dialog.querySelector("form")); dialog.remove(); });
}

function filterToBriteDialog() {
  const batch = state.batches.find((item) => item.id === selectedBatchId);
  const latest = batch.measurements.at(-1);
  const remaining = remainingInFermenter(batch);
  const volume = Math.min(4, remaining);
  const dialog = document.createElement("dialog");
  dialog.innerHTML = `<form method="dialog" id="filter-form" class="dialog-card"><button class="dialog-close" value="cancel">${icon("X")}</button><p class="eyebrow">Dzidra · Brite Tank</p><h2>Filtrēt uz Dzidru</h2><p>Bruto centrifūgas skaitītājs nav alus daudzums Dzidrā: tajā ieskaitās arī discharge un tīrīšanas šķidrums.</p><div class="measurement-form"><div class="field full"><label>Filtrēšanas datums un laiks</label><input name="filteredAt" type="datetime-local" value="${localDateTimeValue()}" required></div><div class="field"><label>Plānotā daļa no tvertnes, t</label><input name="volumeTons" type="number" min="0.1" max="4" step="0.1" value="${volume}" required></div><div class="field"><label>Uz centrifūgu aizlaists, l <small>(mērīts, neobligāts)</small></label><input name="sourceDrawnLiters" type="number" min="0" step="1" placeholder="Piem., ${Math.round(volume * 1000)}"></div><div class="field full"><small>Plānotā daļa ir ${Math.round(volume * 1000)} l; tā netiek saglabāta kā mērījums.</small></div><div class="field"><label>Dzidrā saņemts, l <small>(mērīts, neobligāts)</small></label><input name="briteReceivedLiters" type="number" min="0" step="1" placeholder="Piem., 3650"></div><div class="field"><label>Centrifūgas bruto skaitītājs, l <small>(nevis produkta apjoms)</small></label><input name="centrifugeLiters" type="number" min="0" step="1" placeholder="Neobligāts"></div><div class="field full"><label>Labojuma pamatojums <small>(vajadzīgs, ja daudzums pārsniedz pieejamo)</small></label><input name="volumeOverrideReason" placeholder="Piem., skaitītāja korekcija pēc pārbaudes"></div><div class="field"><label>Blīvums</label><input name="gravity" value="${latest?.gravity ?? ""}" required></div><div class="field"><label>pH</label><input name="ph" type="number" step="0.01" value="${latest?.ph ?? ""}" required></div><div class="field"><label>Temperatūra °C</label><input name="temperature" type="number" step="0.1" value="${latest?.temperature ?? ""}" required></div><div class="field"><label>Spiediens bar</label><input name="pressure" type="number" step="0.01" value="${latest?.pressure ?? ""}"></div><div class="form-error full" id="filter-error"></div><button class="primary full" value="default">Apstiprināt filtrēšanu</button></div></form>`;
  document.body.append(dialog); dialog.showModal();
  dialog.addEventListener("close", async () => { if (dialog.returnValue === "default") await createPackagingRun(dialog.querySelector("form")); dialog.remove(); });
}

async function createPackagingRun(form) {
  try {
    const data = Object.fromEntries(new FormData(form));
    const batch = state.batches.find((item) => item.id === selectedBatchId);
    if (activePackagingRun()) throw new Error("Dzidra pašlaik ir aizņemta.");
    if (!vesselIsReady(13)) throw new Error("Dzidra ir netīra. Pirms filtrēšanas reģistrē S/A/D mazgāšanu.");
    const remaining = remainingInFermenter(batch);
    const volumeTons = Number(data.volumeTons);
    if (volumeTons <= 0 || volumeTons > 4 || volumeTons > remaining) throw new Error(`Atļauts filtrēt ne vairāk kā ${Math.min(4, remaining)} t.`);
    const sourceDrawnLiters = data.sourceDrawnLiters === "" ? null : Number(data.sourceDrawnLiters);
    const briteReceivedLiters = data.briteReceivedLiters === "" ? null : Number(data.briteReceivedLiters);
    if (sourceDrawnLiters != null && (!Number.isFinite(sourceDrawnLiters) || sourceDrawnLiters < 0)) throw new Error("Norādi korektu izmērīto daudzumu, kas aizlaists uz centrifūgu.");
    if (briteReceivedLiters != null && briteReceivedLiters < 0) throw new Error("Dzidrā saņemtajam daudzumam jābūt nullei vai lielākam.");
    const run = { id: crypto.randomUUID(), version: 0, clientId: crypto.randomUUID(), runNumber: (batch.packagingRuns || []).length + 1, volumeTons, sourceDrawnLiters, centrifugeLiters: data.centrifugeLiters === "" ? null : Number(data.centrifugeLiters), briteReceivedLiters, packagedLiters: null, volumeOverrideReason: data.volumeOverrideReason.trim() || null, status: "filtered", filteredAt: new Date(data.filteredAt).toISOString(), packagedAt: null, gravity: validateGravity(data.gravity), ph: validatePh(data.ph), temperature: validateTemperature(data.temperature), pressure: validatePressure(data.pressure), co2Vol: null, operatorId: currentOperator().id };
    batch.packagingRuns ||= []; batch.packagingRuns.push(run);
    const workItem=acceptedWorkItem(batch.id,"filter");
    if (!await saveAndSync({ entity: "packagingRun", operation: "create", entityId: run.id, workItemId:workItem.id, workItemVersion:workItem.version })) return;
    if (navigator.onLine && isSupabaseConfigured) await reloadRemotePreservingQueue(operatorSessionToken());
    render();
  } catch (error) { alert(error.message); }
}

function finishPackagingDialog(runId) {
  const batch = state.batches.find((item) => item.id === selectedBatchId);
  const run = batch.packagingRuns.find((item) => item.id === runId);
  const dialog = document.createElement("dialog");
  dialog.innerHTML = `<form method="dialog" class="dialog-card"><button class="dialog-close" value="cancel">${icon("X")}</button><p class="eyebrow">Pildīšana · cikls ${run.runNumber}</p><h2>Apstiprināt pildīšanu</h2><p>Pēc apstiprināšanas Dzidra būs netīra un jāizmazgā pirms nākamās filtrēšanas.</p><div class="measurement-form"><div class="field full"><label>Pildīšanas datums un laiks</label><input name="packagedAt" type="datetime-local" value="${localDateTimeValue()}" required></div><div class="field"><label>Reāli sapildīts, l <small>(neobligāts)</small></label><input name="packagedLiters" type="number" min="0" step="1" placeholder="Piem., 3550"></div><div class="field"><label>Labojuma pamatojums <small>(ja apjoms pārsniedz Dzidru)</small></label><input name="volumeOverrideReason" value="${escapeHtml(run.volumeOverrideReason || "")}" placeholder="Neobligāts"></div><div class="field"><label>Gala blīvums</label><input name="gravity" value="${run.gravity}" required></div><div class="field"><label>pH</label><input name="ph" type="number" step="0.01" value="${run.ph}" required></div><div class="field"><label>Temperatūra °C</label><input name="temperature" type="number" step="0.1" value="${run.temperature}" required></div><div class="field"><label>CO₂, vol</label><input name="co2Vol" type="number" min="0" max="5" step="0.1" value="${batch.co2Target}" required></div><button class="primary full" value="default">Sapildīts</button></div></form>`;
  document.body.append(dialog); dialog.showModal();
  dialog.addEventListener("close", async () => { if (dialog.returnValue === "default") await finishPackagingRun(runId, dialog.querySelector("form")); dialog.remove(); });
}

async function finishPackagingRun(runId, form) {
  try {
    const data = Object.fromEntries(new FormData(form));
    const batch = state.batches.find((item) => item.id === selectedBatchId);
    const run = batch.packagingRuns.find((item) => item.id === runId);
    const packagedLiters = data.packagedLiters === "" ? null : Number(data.packagedLiters);
    if (packagedLiters != null && (!Number.isFinite(packagedLiters) || packagedLiters < 0)) throw new Error("Sapildītajam daudzumam jābūt nullei vai lielākam.");
    Object.assign(run, { status: "packaged", packagedAt: new Date(data.packagedAt).toISOString(), packagedLiters, volumeOverrideReason: data.volumeOverrideReason.trim() || run.volumeOverrideReason || null, gravity: validateGravity(data.gravity), ph: validatePh(data.ph), temperature: validateTemperature(data.temperature), pressure: null, co2Vol: Number(data.co2Vol), operatorId: currentOperator().id });
    if (packagingCyclesComplete(batch)) {
      batch.status = BATCH_STATUS.FINISHED;
      batch.finishedAt = run.packagedAt;
      batch.actions = batch.actions.filter((item) => item.type !== ACTION_TYPES.FINISH);
      batch.actions.push({ id: crypto.randomUUID(), version: 0, type: ACTION_TYPES.FINISH, performedAt: run.packagedAt, gravity: run.gravity, ph: run.ph, temperature: run.temperature, pressure: run.pressure, operatorId: run.operatorId });
    }
    if (batch.status === BATCH_STATUS.FINISHED) {
      const finishAction = batch.actions.find((item) => item.type === ACTION_TYPES.FINISH);
      const workItem=acceptedWorkItem(batch.id,"package");
      if (!await saveAndSync({ entity: "packagingCompletion", operation: "apply", batchId: batch.id, packagingRunId: run.id, actionId: finishAction.id, workItemId:workItem.id, workItemVersion:workItem.version })) return;
    } else {
      const workItem=acceptedWorkItem(batch.id,"package");
      if (!await saveAndSync({ entity: "packagingRun", operation: "update", entityId: run.id, workItemId:workItem.id, workItemVersion:workItem.version })) return;
    }
    if (navigator.onLine && isSupabaseConfigured) await reloadRemotePreservingQueue(operatorSessionToken());
    render();
  } catch (error) { alert(error.message); }
}

function vesselCleaningDialog(number) {
  const vessel = vesselRecord(number);
  if (!vessel) { alert("Tvertnes dati nav ielādēti."); return; }
  if (vesselIsOccupied(number)) { alert("Aizņemtai tvertnei tīrības statusu mainīt nevar."); return; }
  if (!navigator.onLine || !isSupabaseConfigured) { alert("Tvertnes tīrības maiņai vajadzīgs interneta savienojums."); return; }
  if (vesselIsReady(number)) {
    const dialog = document.createElement("dialog");
    dialog.innerHTML = `<form method="dialog" class="dialog-card"><button class="dialog-close" value="cancel">${icon("X")}</button><p class="eyebrow">Tvertne ${number === 13 ? "Dzidra" : number}</p><h2>Atzīmēt kā netīru?</h2><p>Jaunu alu šajā tvertnē nevarēs ievadīt, līdz būs reģistrēta mazgāšana.</p><div class="field"><label>Piezīme <small>(neobligāta)</small></label><input name="note" placeholder="Kāpēc statuss mainīts"></div><div class="form-error"></div><div class="dialog-actions"><button class="secondary" value="cancel">Atcelt</button><button class="danger-button solid" type="button" data-mark-dirty>Brīva · netīra</button></div></form>`;
    document.body.append(dialog); dialog.showModal();
    dialog.querySelector("[data-mark-dirty]").addEventListener("click", async (event) => {
      event.currentTarget.disabled = true;
      const saved = await markVesselDirty(number, dialog.querySelector("[name=note]").value, dialog.querySelector(".form-error"));
      event.currentTarget.disabled = false;
      if (saved) dialog.close("saved");
    });
    dialog.addEventListener("close", () => dialog.remove());
    return;
  }
  const acidRequired = Number(vessel.consecutiveAcidSkips || 0) >= 2;
  const dialog = document.createElement("dialog");
  dialog.innerHTML = `<form method="dialog" class="dialog-card cleaning-dialog"><button class="dialog-close" value="cancel">${icon("X")}</button><p class="eyebrow">Tvertne ${number === 13 ? "Dzidra" : number}</p><h2>Reģistrēt mazgāšanu</h2><p>${acidRequired ? "Divas mazgāšanas bijušas bez akmensskābes — šoreiz obligāti S, A un D." : "Gatavībai obligāti vajag sārmu un dezinfekciju."}</p><div class="chemical-options"><label><input type="checkbox" name="alkali" checked> <strong>S</strong> Sārms</label><label><input type="checkbox" name="acid" ${acidRequired ? "checked disabled" : ""}> <strong>A</strong> Akmensskābe</label><label><input type="checkbox" name="disinfectant" checked> <strong>D</strong> Dezinfekcija</label></div>${acidRequired ? `<input type="hidden" name="acid" value="on">` : ""}<div class="field"><label>Mazgāšanas programma <small>(neobligāta)</small></label><input name="program" placeholder="Piem., pilnā CIP"></div><div class="field"><label>Piezīme / problēmas <small>(neobligāta)</small></label><textarea name="note" rows="3"></textarea></div><div class="form-error" id="cleaning-error"></div><div class="dialog-actions"><button class="secondary" value="cancel">Atcelt</button><button class="primary" type="button" data-save-cleaning>Saglabāt · brīva tīra</button></div></form>`;
  document.body.append(dialog); dialog.showModal();
  dialog.querySelector("[data-save-cleaning]").addEventListener("click", async (event) => {
    const form = dialog.querySelector("form"); const data = new FormData(form); const errorNode = dialog.querySelector("#cleaning-error");
    if (data.get("alkali") !== "on" || data.get("disinfectant") !== "on" || (acidRequired && data.get("acid") !== "on")) {
      errorNode.textContent = acidRequired ? "Šajā mazgāšanā obligāti atzīmē S, A un D." : "Gatavībai obligāti atzīmē S un D.";
      return;
    }
    event.currentTarget.disabled = true;
    const saved = await completeVesselCleaning(number, form, errorNode);
    event.currentTarget.disabled = false;
    if (saved) dialog.close("saved");
  });
  dialog.addEventListener("close", () => dialog.remove());
}

async function completeVesselCleaning(number, form, errorNode) {
  try {
    const vessel = vesselRecord(number); const data = new FormData(form);
    const { error } = await supabase.rpc("complete_vessel_cleaning", {
      session_token: operatorSessionToken(), target_fermenter_id: vessel.id, expected_version: vessel.cleaningVersion,
      used_alkali: data.get("alkali") === "on", used_acid: data.get("acid") === "on",
      used_disinfectant: data.get("disinfectant") === "on", cleaning_program: data.get("program") || null,
      cleaning_note: data.get("note") || null,
    });
    if (error) throw error;
    await reloadRemotePreservingQueue(operatorSessionToken()); render();
    return true;
  } catch (error) {
    errorNode.textContent = `Mazgāšanu nevarēja saglabāt: ${friendlySyncError(error)}`;
    return false;
  }
}

async function markVesselDirty(number, note, errorNode) {
  try {
    const vessel = vesselRecord(number);
    const { error } = await supabase.rpc("mark_vessel_dirty", { session_token: operatorSessionToken(), target_fermenter_id: vessel.id, expected_version: vessel.cleaningVersion, dirty_note: note || null });
    if (error) throw error;
    await reloadRemotePreservingQueue(operatorSessionToken()); render();
    return true;
  } catch (error) {
    errorNode.textContent = `Tvertnes statusu nevarēja mainīt: ${friendlySyncError(error)}`;
    return false;
  }
}

async function completeAction(type, form) {
  try {
    const data = Object.fromEntries(new FormData(form));
    const batch = state.batches.find((item) => item.id === selectedBatchId);
    const measuredAt = new Date(data.performedAt).toISOString();
    const { previous, latest } = measurementContext(batch, measuredAt);
    const draft = validatedMeasurementDraft(data, measuredAt, type);
    const warnings = detectMeasurementWarnings(draft, previous, batch.measurements, { latest });
    const override = await confirmMeasurementWarnings(warnings, previous);
    if (warnings.length && !override) return;
    const previousAction = batch.actions.find((item) => item.type === type);
    const action = { id: previousAction?.id || crypto.randomUUID(), version: previousAction?.version || 0, type, performedAt: measuredAt, gravity: draft.gravity, ph: draft.ph, temperature: draft.temperature, pressure: draft.pressure, operatorId: currentOperator().id };
    batch.actions = batch.actions.filter((item) => item.type !== type); batch.actions.push(action);
    if (type === ACTION_TYPES.DRY_HOP) batch.status = BATCH_STATUS.DRY_HOP;
    if (type === ACTION_TYPES.COOL) batch.status = BATCH_STATUS.COOLING;
    if (type === ACTION_TYPES.FINISH) batch.status = BATCH_STATUS.FINISHED;
    const actionMeasurement = { id: crypto.randomUUID(), version: 0, ...draft, note: ACTION_LABELS[type], operatorId: action.operatorId, processActionId: action.id, warningCodes: warnings.map((item) => item.code), warningDetails: warnings, anomalyConfirmedAt: override?.confirmedAt || null, anomalyReason: override?.reason || null, anomalyBaselineId: previous?.id || null };
    batch.measurements.push(actionMeasurement);
    const workItem=acceptedWorkItem(batch.id,type);
    if (!await saveAndSync({ entity: "processBundle", operation: "apply", batchId: batch.id, actionId: action.id, measurementId: actionMeasurement.id, workItemId:workItem.id, workItemVersion:workItem.version })) return;
    render();
  } catch (error) { alert(error.message); }
}

function tasksPage() {
  const timeline = (state.workItems || []).filter((item) => !["completed", "skipped"].includes(item.status)).map((item) => ({
    ...item, date: rigaDateKey(item.dueAt), tone: workUrgency(item),
  })).sort((a,b) => a.dueAt.localeCompare(b.dueAt));
  const horizon = addDays(today(), 3);
  const upcoming = timeline.filter((task) => task.date <= horizon);
  const later = timeline.filter((task) => task.date > horizon);
  const completedToday=(state.workItems||[]).filter((item)=>item.status==="completed" && item.completedAt && rigaDateKey(item.completedAt)===today());
  shell(`<main><section class="page-heading"><div><p class="eyebrow">Procesa kalendārs</p><h1>Darbu plāns</h1><p>Katrs darbs ir jāpieņem un pēc izpildes atsevišķi jāapstiprina.</p></div></section><section class="planning-summary"><article><strong>${timeline.filter((task) => task.tone === "overdue").length}</strong><span>kavēti</span></article><article><strong>${timeline.filter((task) => task.date === today()).length}</strong><span>šodien</span></article><article><strong>${upcoming.filter((task) => task.date > today()).length}</strong><span>nākamajās 3 dienās</span></article></section><section class="timeline-panel"><div class="panel-title"><div><h2>Šodiena un nākamās trīs dienas</h2><p>Piektdien pārbaudi šo sarakstu pirms došanās prom.</p></div></div>${renderTimeline(upcoming, "Tuvākajās dienās darbu nav.")}</section><section class="timeline-panel later-timeline"><div class="panel-title"><div><h2>Vēlākie darbi</h2><p>Hronoloģiska prognoze visām aktīvajām partijām.</p></div></div>${renderTimeline(later, "Vēlāku darbu prognozei vēl nepietiek vēsturisko datu.")}</section>${completedToday.length?`<section class="timeline-panel completed-work"><div class="panel-title"><h2>Šodien izpildīts</h2><span>${completedToday.length}</span></div>${completedToday.map((item)=>{const accepted=state.operators.find((operator)=>operator.id===item.acceptedBy)?.name||"—";const completed=state.operators.find((operator)=>operator.id===item.completedBy)?.name||"—";return `<div class="completed-work-row">${icon("CircleCheckBig",20)}<span><strong>${escapeHtml(item.label)}</strong><small>Pieņēma: ${escapeHtml(accepted)} ${item.acceptedAt?new Date(item.acceptedAt).toLocaleTimeString("lv-LV",{hour:"2-digit",minute:"2-digit"}):""} · Izpildīja: ${escapeHtml(completed)} ${new Date(item.completedAt).toLocaleTimeString("lv-LV",{hour:"2-digit",minute:"2-digit"})}</small></span></div>`;}).join("")}</section>`:""}</main>`, "Darbu plāns");
}

function workUrgency(item) {
  const date = rigaDateKey(item.dueAt);
  if (date < today()) return "overdue";
  if (date === today()) return "today";
  return date <= addDays(today(),3) ? "info" : "planned";
}

function renderTimeline(items, emptyMessage) {
  if (!items.length) return `<div class="empty-state compact">${icon("CalendarCheck", 32)}<p>${emptyMessage}</p></div>`;
  const groups = items.reduce((result, item) => {
    (result[item.date] ||= []).push(item);
    return result;
  }, {});
  return `<div class="work-timeline">${Object.entries(groups).map(([date, tasks]) => `<section class="timeline-day"><div class="timeline-date"><strong>${date === today() ? "Šodien" : new Intl.DateTimeFormat("lv-LV", { weekday: "long", day: "2-digit", month: "2-digit" }).format(new Date(`${date}T12:00:00`))}</strong><small>${formatDate(date)}</small></div><div class="timeline-items">${tasks.map((task) => timelineTask(task)).join("")}</div></section>`).join("")}</div>`;
}

function timelineTask(task) {
  const batch = state.batches.find((item) => item.id === task.batchId);
  const beer = batch && state.beerTypes.find((item) => item.id === batch.beerTypeId);
  const status = task.status === "accepted" ? `Pieņēma: ${state.operators.find((operator) => operator.id === task.acceptedBy)?.name || "operators"}` : task.status === "postponed" ? "Atlikts" : "Jāizdara";
  return `<button class="timeline-task ${task.tone}" data-open-work-item="${task.id}"><span class="tank-number">${batch?.fermenterNumber || "?"}</span><span><strong>${escapeHtml(task.label)}</strong><small>${escapeHtml(beer?.name || "Nezināms alus")} · #${escapeHtml(batch?.batchNumber || "—")} · ${escapeHtml(status)}</small></span><span class="urgency-badge ${task.tone}">${task.tone === "overdue" ? "Kavēts" : task.tone === "today" ? "Šodien" : task.tone === "info" ? "Drīzumā" : "Plānots"}</span>${icon("ChevronRight")}</button>`;
}

function workItemDialog(workItemId) {
  const item = (state.workItems || []).find((candidate) => candidate.id === workItemId);
  if (!item) return;
  const batch = state.batches.find((candidate) => candidate.id === item.batchId);
  const beer = state.beerTypes.find((candidate) => candidate.id === batch?.beerTypeId);
  const acceptedName = state.operators.find((operator) => operator.id === item.acceptedBy)?.name;
  const events = (state.workItemEvents || []).filter((entry) => entry.workItemId === item.id).slice(-6).reverse();
  const dialog = document.createElement("dialog");
  dialog.innerHTML = `<div class="dialog-card work-dialog"><button class="dialog-close" data-close-work>${icon("X")}</button><p class="eyebrow">${workUrgency(item) === "overdue" ? "Kavēts darbs" : "Procesa darbs"}</p><h2>${escapeHtml(item.label)}</h2><p>${escapeHtml(beer?.name || "Alus")} · ${batch ? `Tvertne ${batch.fermenterNumber} · #${escapeHtml(batch.batchNumber)}` : ""}</p><div class="work-meta"><span>Termiņš <strong>${formatDate(item.dueAt)}</strong></span><span>Statuss <strong>${item.status === "accepted" ? `Pieņēma ${escapeHtml(acceptedName || "operators")}` : item.status === "postponed" ? "Atlikts" : "Jāizdara"}</strong></span></div><div class="dialog-actions work-actions">${item.status !== "accepted" ? `<button class="primary" data-work-transition="accept">${icon("CheckCheck",17)} Pieņemt</button>` : `<button class="primary" data-work-open-batch>${icon("CircleCheck",17)} Izpildīt un apstiprināt</button>`}<button class="secondary" data-work-transition="postpone">Atlikt</button><button class="text-button" data-work-transition="skip">Izlaist</button></div>${events.length ? `<div class="work-event-list"><h3>Vēsture</h3>${events.map((entry) => `<small>${formatDate(entry.createdAt)} · ${escapeHtml(workEventLabel(entry.type))}${entry.reason ? ` · ${escapeHtml(entry.reason)}` : ""}</small>`).join("")}</div>` : ""}</div>`;
  document.body.append(dialog); dialog.showModal();
  dialog.addEventListener("close",()=>dialog.remove());
  dialog.addEventListener("click",async(event)=>{
    if(event.target===dialog || event.target.closest("[data-close-work]")){dialog.close();return;}
    if(event.target.closest("[data-work-open-batch]")){selectedBatchId=item.batchId;route="batch";dialog.close();render();return;}
    const button=event.target.closest("[data-work-transition]");
    if(!button)return;
    const transition=button.dataset.workTransition;
    let reason=null,newDueAt=null;
    if(["postpone","skip"].includes(transition)){
      const result=await workReasonDialog(transition);
      if(!result)return;
      ({reason,newDueAt}=result);
    }
    try { await transitionWorkItem(item,transition,{reason,newDueAt}); dialog.close(); render(); }
    catch(error){alert(`Darbu neizdevās mainīt: ${friendlySyncError(error)}`);}
  });
}

function workEventLabel(type) {
  return ({created:"Izveidots",accepted:"Pieņemts",completed:"Izpildīts",postponed:"Atlikts",skipped:"Izlaists",reopened:"Atvērts no jauna"})[type] || type;
}

function workReasonDialog(transition) {
  return new Promise((resolve) => {
    const postpone=transition==="postpone";
    const dialog=document.createElement("dialog");
    dialog.innerHTML=`<form method="dialog" class="dialog-card work-reason-dialog"><button class="dialog-close" value="cancel">${icon("X")}</button><p class="eyebrow">${postpone?"Atlikt darbu":"Izlaist darbu"}</p><h2>${postpone?"Norādi jauno termiņu":"Paskaidro iemeslu"}</h2><div class="measurement-form"><div class="field full"><label>Iemesls</label><textarea name="reason" rows="3" required></textarea></div>${postpone?`<div class="field full"><label>Jaunais datums un laiks</label><input name="dueAt" type="datetime-local" value="${addDays(today(),1)}T07:00" required></div>`:""}<div class="form-error full" data-work-reason-error></div><button class="primary full" value="default">${postpone?"Atlikt":"Izlaist"}</button></div></form>`;
    document.body.append(dialog);dialog.showModal();
    dialog.addEventListener("close",()=>{
      if(dialog.returnValue!=="default"){dialog.remove();resolve(null);return;}
      const data=Object.fromEntries(new FormData(dialog.querySelector("form")));
      const reason=data.reason?.trim();
      if(!reason){dialog.querySelector("[data-work-reason-error]").textContent="Iemesls ir obligāts.";dialog.showModal();return;}
      const newDueAt=postpone?rigaLocalDateTimeToIso(data.dueAt.slice(0,10),Number(data.dueAt.slice(11,13)),Number(data.dueAt.slice(14,16))):null;
      dialog.remove();resolve({reason,newDueAt});
    });
  });
}

async function transitionWorkItem(item, transition, { reason=null, newDueAt=null, measurementId=null, actionId=null }={}) {
  if(!navigator.onLine) throw new Error("Darba pieņemšanai vai statusa maiņai nepieciešams internets, lai divi operatori to nepaņemtu reizē.");
  const { error }=await supabase.rpc("transition_work_item",{session_token:operatorSessionToken(),target_work_item_id:item.id,transition,expected_version:item.version,reason,new_due_at:newDueAt,measurement_id:measurementId,action_id:actionId});
  if(error)throw error;
  await refreshRemoteState();
}

function acceptedWorkItem(batchId,type){
  const item=(state.workItems || []).find((candidate)=>candidate.batchId===batchId && candidate.type===type && candidate.status==="accepted");
  if(!item)throw new Error("Darbs vispirms jāpieņem.");
  return item;
}

async function ensureAcceptedWork(batchId, type) {
  const open=(state.workItems || []).find((candidate)=>candidate.batchId===batchId && candidate.type===type && !["completed","skipped"].includes(candidate.status));
  if(!open){alert("Šim procesam nav izveidots darba ieraksts. Atjauno Darbu sadaļu un mēģini vēlreiz.");return false;}
  if(open.status==="accepted")return true;
  if(!navigator.onLine){alert("Pirms izpildes darbs ir jāpieņem tiešsaistē.");return false;}
  if(!confirm(`Pirms izpildes pieņemt darbu “${open.label}”?`))return false;
  try{await transitionWorkItem(open,"accept");return true;}
  catch(error){alert(`Darbu neizdevās pieņemt: ${friendlySyncError(error)}`);return false;}
}

function chartSvg(seriesList, average, metric) {
  const all = [...seriesList.flat(), ...average].filter((point) => point?.value != null);
  if (all.length < 2) return `<div class="analysis-no-data">Nav pietiekamu ${escapeHtml(ANALYSIS_METRICS[metric].label)} mērījumu līknei.</div>`;
  const min = Math.min(...all.map((point) => point.value));
  const max = Math.max(...all.map((point) => point.value));
  const maxDay = Math.max(1, ...all.map((point) => point.day));
  const y = (value) => 100 - ((value - min) / Math.max(0.0001, max - min)) * 88 - 6;
  const line = (points) => points.map((point, index) => `${index ? "L" : "M"}${(point.day / maxDay) * 100} ${y(point.value)}`).join(" ");
  const band = average.filter((point) => point.count >= 5 && point.lower != null);
  const bandPath = band.length > 1 ? `${line(band.map((point) => ({ ...point, value: point.upper })))} ${[...band].reverse().map((point) => `L${(point.day / maxDay) * 100} ${y(point.lower)}`).join(" ")} Z` : "";
  return `<div class="analysis-chart" role="img" aria-label="${escapeHtml(ANALYSIS_METRICS[metric].label)} pēc fermentācijas dienas"><svg viewBox="0 0 100 100" preserveAspectRatio="none">${bandPath ? `<path class="control-band" d="${bandPath}"/>` : ""}${seriesList.map((points, index) => `<path class="batch-line ${index === seriesList.length - 1 ? "current" : ""}" d="${line(points)}"/>`).join("")}${average.length > 1 ? `<path class="average-line" d="${line(average)}"/>` : ""}</svg><div class="chart-axis"><span>${min.toFixed(metric === "gravity" ? 0 : 1)}</span><span>${max.toFixed(metric === "gravity" ? 0 : 1)}</span><span>Fermentācijas diena 0–${maxDay}</span></div></div>`;
}

function metricCard(metric, visibleBatches, allBatches) {
  const latest = visibleBatches.at(-1);
  const lines = visibleBatches.map((batch) => seriesForBatch(batch, metric));
  const average = averageCurve(allBatches, metric);
  const sampleCount = allBatches.filter((batch) => seriesForBatch(batch, metric).length > 0).length;
  const enoughBand = average.some((point) => point.count >= 5 && point.sd != null);
  const current = seriesForBatch(latest, metric).at(-1);
  const precision = metric === "gravity" ? 0 : 1;
  const summary = current ? `Jaunākā vērtība: ${current.value.toFixed(precision)} ${ANALYSIS_METRICS[metric].unit}, ${current.day}. fermentācijas dienā; ${seriesForBatch(latest, metric).length} datu punkti.` : "Jaunākajā partijā šim rādītājam datu nav.";
  return `<article class="analysis-metric-card"><div class="panel-title"><h3>${escapeHtml(ANALYSIS_METRICS[metric].label)} ${ANALYSIS_METRICS[metric].unit}</h3><span>${enoughBand ? "Normālais diapazons: ±1 SD" : `Diapazonam vajag vēl ${Math.max(0, 5 - sampleCount)} partijas ar šo mērījumu`}</span></div>${chartSvg(lines, average, metric)}<p class="chart-summary">${summary}</p><p class="chart-note">Plānās līnijas: pēdējās ${visibleBatches.length} partijas. Oranžā: visu pabeigto partiju vidējais. Punkti starp mērījumiem ir lineāri savienoti tikai attēlošanai; tukši vēsturiskie lauki netiek aizvietoti.</p>${latest ? `<small>Jaunākā: #${escapeHtml(latest.batchNumber)}</small>` : ""}</article>`;
}

function analysisSummary(batch, baseline) {
  const stats = fermentationMetrics(batch, baseline);
  const day = stats.predictedFgDay == null ? "Nav pietiekamu datu" : `${Math.ceil(stats.predictedFgDay)}. fermentācijas diena`;
  return `<section class="analysis-summary-grid"><article><small>Blīvuma ātrums</small><strong>${stats.gravityRate == null ? "—" : `${stats.gravityRate.toFixed(1)} punkti/dienā`}</strong></article><article><small>pH ātrums</small><strong>${stats.phRate == null ? "—" : `${stats.phRate.toFixed(2)} pH/dienā`}</strong></article><article><small>Šķietamais norūgums</small><strong>${stats.apparentAttenuation == null ? "—" : `${stats.apparentAttenuation.toFixed(1)} %`}</strong></article><article><small>Prognozēts FG</small><strong>${day}</strong></article><article><small>Novirze no vidējā</small><strong>${stats.deviationPercent == null ? "Nepietiek datu" : `${stats.deviationPercent.toFixed(0)} %`}</strong></article><article><small>Pirmā būtiskā atšķirība</small><strong>${stats.firstDifference == null ? "Nav noteikta" : `${stats.firstDifference}. dienā`}</strong></article></section>`;
}

function carbonationAdvisor(batch) {
  const config = state.carbonationAdvisories?.[batch.id] || {};
  const readiness = carbonationReadiness(batch, config);
  const blockers = readiness.blockers.map((blocker) => `<li>${escapeHtml(blocker)}</li>`).join("");
  const diagnostic = readiness.ready ? `<p><strong>CO₂ starpība:</strong> ${readiness.co2Deficit.toFixed(2)} vol · <strong>Atlikušais blīvums līdz apstiprinātam FG:</strong> ${readiness.residualGravityPoints} punkti. Tie ir procesa rādītāji, nevis spiediena iestatījums.</p>` : "";
  return `<section class="panel carbonation-advisor"><div class="panel-title"><div><p class="eyebrow">Drošības palīgs</p><h2>Karbonizācijas padomdevējs</h2></div><span class="analysis-status">${readiness.ready ? "Dati pilni — manuāla pārbaude obligāta" : "Bloķēts: trūkst datu"}</span></div><p>Šis rīks nekontrolē vārstu un nedod automātisku spiediena iestatījumu. Maksimālā darba robeža ir zemākā no ievadītajām iekārtas robežām un 2 bar operacionālās robežas.</p>${readiness.ready ? `<div class="carbonation-ready"><strong>Manuālai pārbaudei pieejamā augšējā robeža: ${readiness.ceiling.toFixed(2)} bar (gauge)</strong>${diagnostic}<p>Aprēķinātais iestatījums netiek dots automātiski: pirms spundes iestatīšanas apstiprini terminālo blīvumu un pārbaudi ražotāja/PRV specifikāciju.</p></div>` : `<div class="carbonation-blockers"><strong>Lai atbloķētu drošu izvērtēšanu, ievadi:</strong><ul>${blockers}</ul></div>`}<form id="carbonation-advisory-form" class="form-card compact-form" data-batch-id="${batch.id}"><div class="field"><label>Apstiprināts gala blīvums</label><input name="confirmedTerminalGravity" inputmode="numeric" value="${config.confirmedTerminalGravity ?? ""}" placeholder="1012"></div><div class="field"><label>CO₂ mērīšanas metode/ierīce</label><input name="co2MeasurementMethod" value="${escapeHtml(config.co2MeasurementMethod ?? "")}" placeholder="Piem., CBox / manometrs"></div><div class="field"><label>Alus tilpums, l</label><input name="beerVolumeLiters" type="number" min="1" step="1" value="${config.beerVolumeLiters ?? ""}"></div><div class="field"><label>Galvas telpa, l</label><input name="headspaceLiters" type="number" min="1" step="1" value="${config.headspaceLiters ?? ""}"></div><div class="field"><label>Tvertnes sertificētā robeža, bar</label><input name="hardwareMaxBar" type="number" min="0.01" max="2" step="0.01" value="${config.hardwareMaxBar ?? ""}"></div><div class="field"><label>PRV robeža, bar</label><input name="prvLimitBar" type="number" min="0.01" max="2" step="0.01" value="${config.prvLimitBar ?? ""}"></div><div class="field"><label>Spundes/manometra robeža, bar</label><input name="deviceLimitBar" type="number" min="0.01" max="2" step="0.01" value="${config.deviceLimitBar ?? ""}"></div><div class="field"><label>Augstums v.j.l., m</label><input name="altitudeMeters" type="number" step="1" value="${config.altitudeMeters ?? ""}"></div><div class="field"><label>Spiediena pamats</label><select name="pressureBasis"><option value="">Izvēlies</option><option value="gauge" ${config.pressureBasis === "gauge" ? "selected" : ""}>Manometra spiediens (gauge)</option></select></div>${batch.hasDryHop ? `<label class="check full"><input name="hopCreepAcknowledged" type="checkbox" ${config.hopCreepAcknowledged ? "checked" : ""}><span>Es apzinos, ka Dry Hop/hop creep var turpināt fermentāciju un paaugstināt spiedienu.</span></label>` : ""}<button class="secondary full" type="submit">Saglabāt padomdevēja datus</button></form></section>`;
}

function analyticsPage() {
  const eligible = state.beerTypes.map((beer) => {
    const completed = comparableBatches(state.batches, beer.id);
    const active = state.batches.filter((batch) => batch.beerTypeId === beer.id && batch.status !== BATCH_STATUS.FINISHED && (batch.measurements || []).length)
      .sort((a, b) => new Date(a.brewDate) - new Date(b.brewDate)).at(-1) || null;
    return { beer, completed, active };
  }).filter((entry) => entry.completed.length || entry.active);
  if (!selectedAnalysisBeerId || !eligible.some((entry) => entry.beer.id === selectedAnalysisBeerId)) selectedAnalysisBeerId = eligible[0]?.beer.id || null;
  const selected = eligible.find((entry) => entry.beer.id === selectedAnalysisBeerId);
  if (!selected) { shell(`<main><section class="empty-state analysis-empty">${icon("ChartNoAxesCombined",44)}<h1>Analīzei vēl nav pabeigtu partiju ar mērījumiem</h1><p>Vēsturiskos importus ar nepilniem laukiem rādīsim kā nepilnas līknes — dati netiks izdomāti.</p></section></main>`, "Alus analīze"); return; }
  const baseCompleted = selected.completed;
  const latest = selected.active || baseCompleted.at(-1);
  const all = sameProfileBatches(baseCompleted, latest);
  const visible = selected.active ? [...all.slice(-4), selected.active] : all.slice(-5);
  shell(`<main><section class="page-heading"><div><p class="eyebrow">Vēsturisko datu salīdzinājums</p><h1>${escapeHtml(selected.beer.name)} analīze</h1><p>${selected.active ? `Aktīvā partija #${escapeHtml(selected.active.batchNumber)} salīdzināta ar pēdējām 4 pabeigtajām.` : "Pēdējās 5 pabeigtās partijas salīdzinātas."} Vidējais izmanto visas ${all.length} pabeigtās šī alus partijas.</p></div><select class="analysis-select" data-analysis-beer>${eligible.map((entry) => `<option value="${escapeHtml(entry.beer.id)}" ${entry.beer.id === selected.beer.id ? "selected" : ""}>${escapeHtml(entry.beer.name)} · ${entry.completed.length} pabeigtas</option>`).join("")}</select></section>${analysisSummary(latest, all)}<section class="analysis-metric-grid">${Object.keys(ANALYSIS_METRICS).map((metric) => metricCard(metric, visible, all)).join("")}</section><section class="panel analysis-method"><h2>Kā lasīt analīzi</h2><p>Līknes apraksta procesu, nevis garšas cēloni. Jaunākā partija ir salīdzināma ar vēsturi tikai tad, ja abās ir līdzīgi mērījumi. Kontroles diapazons parādās no 5 partiju parauga; mazākam paraugam rādām vidējo bez “normas” apgalvojuma.</p></section>${carbonationAdvisor(latest)}</main>`, "Alus analīze");
}

function historyPage() {
  const finished = state.batches.filter((batch) => batch.status === BATCH_STATUS.FINISHED).reverse();
  const deleted = state.deletedBatches || [];
  const lossByBeer = [...new Set(finished.map((batch) => batch.beerTypeId))].map((beerTypeId) => {
    const beer = state.beerTypes.find((item) => item.id === beerTypeId);
    const ledgers = finished.filter((batch) => batch.beerTypeId === beerTypeId).map(calculateLossLedger);
    const average = (key) => { const values=ledgers.map((item)=>item[key]).filter((value)=>value!=null); return values.length ? values.reduce((sum,value)=>sum+value,0)/values.length : null; };
    return `<article><h3>${escapeHtml(beer?.name || "Nezināms alus")}</h3><small>${ledgers.length} pabeigtas partijas · tikai ar mērītām robežām</small><div><span>Vidēji uz centrifūgu → Dzidra: <strong>${liters(average("sourceToBriteLossLiters"))}</strong></span><span>Vidēji Dzidra → pildīšana: <strong>${liters(average("briteToPackageLossLiters"))}</strong></span><span>Vidēji sapildīts: <strong>${liters(average("packagedLiters"))}</strong></span></div></article>`;
  }).join("");
  shell(`<main><section class="page-heading"><div><p class="eyebrow">Pabeigtās partijas</p><h1>Vēsture</h1></div></section>${lossByBeer ? `<section class="panel loss-summary"><div class="panel-title"><div><p class="eyebrow">Procesa salīdzinājums</p><h2>Zudumi pēc alus</h2></div><span>Nav operatoru salīdzinājuma</span></div><p class="ledger-note">Vidējie rādītāji izmanto tikai tās partijas, kurām ir abi attiecīgā posma mērījumi.</p><div class="loss-summary-grid">${lossByBeer}</div></section>` : ""}<section class="history-list">${finished.length ? finished.map((batch) => { const beer = state.beerTypes.find((item) => item.id === batch.beerTypeId); const ledger=calculateLossLedger(batch); return `<button class="history-row" data-open-batch="${batch.id}"><span class="tank-number">${batch.fermenterNumber}</span><span><strong>${escapeHtml(beer.name)} · ${batch.volumeTons} t</strong><small>#${escapeHtml(batch.batchNumber)} · ${formatDate(batch.brewDate)} · ${batch.measurements.length} mērījumi${ledger.packagedLiters != null ? ` · sapildīts ${Math.round(ledger.packagedLiters)} l` : ""}</small></span>${icon("ChevronRight")}</button>`; }).join("") : `<div class="empty-state">${icon("History", 38)}<h2>Vēsture vēl ir tukša</h2><p>Pabeigtās partijas būs redzamas šeit.</p></div>`}</section><section class="panel trash-panel"><div class="panel-title"><div><p class="eyebrow">Atjaunošana</p><h2>Miskaste</h2></div><span>${deleted.length} partijas</span></div>${deleted.length ? `<div class="history-list">${deleted.map((batch) => `<div class="history-row trash-row"><span class="tank-number">${icon("Trash2",18)}</span><span><strong>${escapeHtml(batch.beerName)} · #${escapeHtml(batch.batchNumber)}</strong><small>${formatDate(batch.brewDate)} · ${escapeHtml(batch.deleteReason || "Iemesls nav norādīts")} · ${escapeHtml(batch.deletedByName || "Operators")}</small></span><button class="secondary" data-restore-batch="${batch.id}">${icon("Undo2",16)} Atjaunot</button></div>`).join("")}</div>` : `<div class="empty-state compact"><p>Dzēstu partiju nav.</p></div>`}</section></main>`, "Vēsture");
}

async function restoreBatch(batchId) {
  if (!navigator.onLine) { alert("Partiju var atjaunot, kad ir interneta savienojums."); return; }
  const deleted = (state.deletedBatches || []).find((item) => item.id === batchId);
  if (!deleted) return;
  const event = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), entity: "batch", operation: "restore", entityId: batchId, expectedVersion: deleted.version, reason: "Partija atjaunota no miskastes", operatorId: state.activeOperatorId };
  try {
    await syncEvent(state, event, brewery.id, operatorSessionToken());
    await refreshRemoteState();
    render();
  } catch (error) {
    if (/VERSION_CONFLICT/i.test(error.message || "")) {
      await reloadRemotePreservingQueue(operatorSessionToken());
      render();
    }
    alert(`Partiju neizdevās atjaunot: ${friendlySyncError(error)}`);
  }
}

function settingsPage() {
  shell(`<main class="narrow"><section class="page-heading"><div><p class="eyebrow">Konfigurācija</p><h1>Iestatījumi</h1></div></section><section class="panel"><div class="panel-title"><h2>Operatori</h2><span>Katram operatoram ir savs PIN</span></div><div class="operator-list">${state.operators.map((operator) => `<div class="operator-row"><span class="avatar">${escapeHtml(operator.name.slice(0, 1).toUpperCase())}</span><strong>${escapeHtml(operator.name)}</strong>${operator.id === state.activeOperatorId ? `<span class="current-label">Aktīvs</span>` : ""}</div>`).join("")}<form id="operator-form" class="inline-form"><input name="name" placeholder="Jauna operatora vārds" required><input name="pin" type="password" inputmode="numeric" pattern="[0-9]{4,8}" placeholder="PIN (4–8 cipari)" required><button class="secondary">${icon("UserPlus")} Pievienot</button></form></div></section><section class="panel pin-panel"><div class="panel-title"><div><h2>Mainīt savu PIN</h2><p>Aktīvais operators: ${escapeHtml(currentOperator()?.name || "—")}</p></div><span>PIN netiek glabāts atklātā tekstā</span></div><form id="change-pin-form" class="pin-form"><div class="field"><label>Pašreizējais PIN</label><input name="currentPin" type="password" inputmode="numeric" pattern="[0-9]{4,8}" required></div><div class="field"><label>Jaunais PIN</label><input name="newPin" type="password" inputmode="numeric" pattern="[0-9]{4,8}" required></div><div class="field"><label>Atkārto jauno PIN</label><input name="newPinConfirm" type="password" inputmode="numeric" pattern="[0-9]{4,8}" required></div><div class="auth-message full" id="pin-message"></div><button class="secondary full">${icon("KeyRound")} Nomainīt PIN</button></form></section><section class="panel notification-panel"><div><h2>${icon("BellRing")} Darbu paziņojumi</h2><p>Atverot aplikāciju un ieejot operatora profilā, parādīsies šodienas obligātie mērījumi un procesa darbības.</p></div><button class="secondary" data-enable-notifications>${"Notification" in window && Notification.permission === "granted" ? `${icon("CircleCheck")} Sistēmas paziņojumi ieslēgti` : `${icon("Bell")} Ieslēgt sistēmas paziņojumus`}</button></section><section class="panel notice"><h2>${icon(isSupabaseConfigured ? "CloudCog" : "CloudOff")} ${isSupabaseConfigured ? "Supabase sinhronizācija aktīva" : "Lokālais režīms"}</h2><p>${isSupabaseConfigured ? "Tiešsaistē izmaiņas tiek nosūtītas uz kopīgo datubāzi. Bezsaistē tās paliek šajā ierīcē un tiks nosūtītas pēc interneta atjaunošanās." : "Dati droši glabājas šajā ierīcē ar IndexedDB."}</p><strong>${state.pendingSync.length} ieraksti gaida sinhronizāciju</strong></section><section class="panel reset-panel"><div><p class="eyebrow danger-text">Bīstamā zona</p><h2>Dzēst visus alus datus</h2><p>Neatgriezeniski dzēsīs visas partijas, mērījumus, darbības, filtrēšanas un pildīšanas vēsturi un alus tipus. Operatori, konts un tvertnes paliks.</p></div><button class="danger-button solid" data-reset-brewing-data>${icon("Trash2", 17)} Dzēst visu alus vēsturi</button></section></main>`, "Iestatījumi");
}

function resetBrewingDataDialog() {
  const dialog = document.createElement("dialog");
  dialog.innerHTML = `<form method="dialog" class="dialog-card delete-dialog" id="reset-data-form"><button class="dialog-close" value="cancel">${icon("X")}</button><p class="eyebrow danger-text">Neatgriezeniska darbība</p><h2>Dzēst visu alus vēsturi?</h2><p>Tiks neatgriezeniski dzēstas visas partijas un ar tām saistītā statistika visās ierīcēs. Operatori un tvertnes paliks.</p><div class="field"><label>Lai apstiprinātu, ieraksti <strong>DZĒST VISU</strong></label><input name="confirmation" autocomplete="off" required></div><div class="auth-message error" id="reset-message"></div><div class="dialog-actions"><button class="secondary" value="cancel">Atcelt</button><button class="danger-button solid" value="reset">${icon("Trash2", 17)} Dzēst visu</button></div></form>`;
  document.body.append(dialog); dialog.showModal();
  dialog.addEventListener("close", async () => {
    if (dialog.returnValue === "reset") {
      const confirmation = new FormData(dialog.querySelector("form")).get("confirmation");
      if (confirmation !== "DZĒST VISU") {
        dialog.remove();
        alert("Dzēšana atcelta: apstiprinājuma teksts nebija pareizs.");
        return;
      }
      await resetAllBrewingData();
    }
    dialog.remove();
  });
}

async function resetAllBrewingData() {
  const { data: newVersion, error } = await supabase.rpc("reset_brewing_data_with_session", {
    session_token: operatorSessionToken(), confirmation_text: "DZĒST VISU",
  });
  if (error) { alert(`Neizdevās dzēst datus: ${error.message}`); return; }
  state.beerTypes = [];
  state.batches = [];
  state.pendingSync = [];
  state.breweryDataVersion = newVersion;
  state = await saveState(state);
  route = "dashboard";
  render();
  alert("Visa alus vēsture ir izdzēsta. Var sākt datu ievadi no jauna.");
}

async function changeOperatorPin(form) {
  const data = Object.fromEntries(new FormData(form));
  const message = form.querySelector("#pin-message");
  if (data.newPin !== data.newPinConfirm) {
    message.className = "auth-message error full";
    message.textContent = "Jaunie PIN kodi nesakrīt.";
    return;
  }
  const button = form.querySelector("button");
  button.disabled = true; button.textContent = "Maina PIN…";
  const { data: changed, error } = await supabase.rpc("change_operator_pin_with_session", {
    session_token: operatorSessionToken(),
    current_pin: data.currentPin,
    new_pin: data.newPin,
  });
  button.disabled = false; button.innerHTML = `${icon("KeyRound")} Nomainīt PIN`;
  if (error || !changed) {
    message.className = "auth-message error full";
    message.textContent = error ? error.message : "Pašreizējais PIN nav pareizs.";
    return;
  }
  form.reset();
  await revokeCurrentOperatorSession();
  operatorUnlockPage("PIN veiksmīgi nomainīts. Drošības dēļ ienāc vēlreiz ar jauno PIN.");
}

async function operatorDialog() {
  try {
    await revokeCurrentOperatorSession();
    operatorUnlockPage();
  } catch (error) {
    alert(`Operatora sesiju neizdevās droši beigt: ${error.message}`);
  }
}

function render() {
  if (route === "dashboard") dashboard();
  else if (route === "new-batch") newBatchForm();
  else if (route === "batch") batchDetail();
  else if (route === "tasks") tasksPage();
  else if (route === "history") historyPage();
  else if (route === "analytics") analyticsPage();
  else settingsPage();
}

document.addEventListener("click", async (event) => {
  if (event.target.closest("[data-auth-logout]")) {
    try {
      await revokeCurrentOperatorSession();
      await supabase.auth.signOut();
    } catch (error) {
      alert(`Sesiju neizdevās droši beigt: ${error.message}`);
    }
    return;
  }
  const authModeButton = event.target.closest("[data-auth-mode]");
  if (authModeButton) { authMode = authModeButton.dataset.authMode; authPage(); return; }
  const routeButton = event.target.closest("[data-route]");
  if (routeButton) { route = routeButton.dataset.route; render(); return; }
  const newButton = event.target.closest('[data-action="new-batch"]');
  if (newButton) { route = "new-batch"; newBatchForm(newButton.dataset.tank || ""); return; }
  const vesselCleaningButton = event.target.closest("[data-vessel-cleaning]");
  if (vesselCleaningButton) { vesselCleaningDialog(Number(vesselCleaningButton.dataset.vesselCleaning)); return; }
  const batchButton = event.target.closest("[data-open-batch]");
  if (batchButton) { selectedBatchId = batchButton.dataset.openBatch; route = "batch"; render(); return; }
  const workItemButton = event.target.closest("[data-open-work-item]");
  if (workItemButton) { workItemDialog(workItemButton.dataset.openWorkItem); return; }
  const actionButton = event.target.closest("[data-batch-action]");
  if (actionButton) { if(await ensureAcceptedWork(selectedBatchId,actionButton.dataset.batchAction))actionDialog(actionButton.dataset.batchAction); return; }
  if (event.target.closest("[data-filter-to-brite]")) { if(await ensureAcceptedWork(selectedBatchId,"filter"))filterToBriteDialog(); return; }
  const finishPackagingButton = event.target.closest("[data-finish-packaging]");
  if (finishPackagingButton) { if(await ensureAcceptedWork(selectedBatchId,"package"))finishPackagingDialog(finishPackagingButton.dataset.finishPackaging); return; }
  const deleteBatchButton = event.target.closest("[data-delete-batch]");
  if (deleteBatchButton) { deleteBatchDialog(deleteBatchButton.dataset.deleteBatch); return; }
  const restoreBatchButton = event.target.closest("[data-restore-batch]");
  if (restoreBatchButton) { await restoreBatch(restoreBatchButton.dataset.restoreBatch); return; }
  if (event.target.closest("[data-reset-brewing-data]")) { resetBrewingDataDialog(); return; }
  if (event.target.closest("[data-show-daily-tasks]")) { showDailyTasks(); return; }
  if (event.target.closest("[data-enable-notifications]")) { enableNotifications(); return; }
  if (event.target.closest('[data-action="operators"]')) await operatorDialog();
});

document.addEventListener("change", (event) => {
  if (event.target.matches("[data-analysis-beer]")) {
    selectedAnalysisBeerId = event.target.value;
    render();
  }
});

document.addEventListener("submit", async (event) => {
  if (event.target.method === "dialog") return;
  event.preventDefault();
  if (event.target.id === "auth-form") { await submitAuth(event.target); return; }
  if (event.target.id === "onboarding-form") { await submitOnboarding(event.target); return; }
  if (event.target.id === "operator-unlock-form") { await submitOperatorUnlock(event.target); return; }
  if (event.target.id === "batch-form") await submitBatch(event.target);
  if (event.target.id === "measurement-form") await submitMeasurement(event.target);
  if (event.target.id === "operator-form") {
    const data = Object.fromEntries(new FormData(event.target));
    const { data: operator, error } = await supabase.rpc("create_operator_with_session", {
      session_token: operatorSessionToken(), operator_name: data.name.trim(), operator_pin: data.pin,
    });
    if (error) { alert(error.message); return; }
    state.operators.push(operator); state = await saveState(state); render();
  }
  if (event.target.id === "change-pin-form") { await changeOperatorPin(event.target); }
  if (event.target.id === "carbonation-advisory-form") { await saveCarbonationAdvisory(event.target); }
});

async function saveCarbonationAdvisory(form) {
  if (!navigator.onLine) { alert("Karbonizācijas drošības datus var saglabāt tikai tiešsaistē."); return; }
  const data = Object.fromEntries(new FormData(form));
  const numberOrNull = (value) => value === "" || value == null ? null : Number(value);
  const { data: row, error } = await supabase.rpc("upsert_batch_carbonation_advisory", {
    session_token: operatorSessionToken(), target_batch_id: form.dataset.batchId,
    terminal_gravity: numberOrNull(data.confirmedTerminalGravity), beer_liters: numberOrNull(data.beerVolumeLiters),
    headspace: numberOrNull(data.headspaceLiters), hardware_limit: numberOrNull(data.hardwareMaxBar),
    prv_limit: numberOrNull(data.prvLimitBar), device_limit: numberOrNull(data.deviceLimitBar), co2_method: data.co2MeasurementMethod?.trim() || null,
    basis: data.pressureBasis || null, altitude: numberOrNull(data.altitudeMeters),
    acknowledge_hop_creep: data.hopCreepAcknowledged === "on",
  });
  if (error) { alert(`Datus neizdevās saglabāt: ${friendlySyncError(error)}`); return; }
  state.carbonationAdvisories ||= {};
  state.carbonationAdvisories[form.dataset.batchId] = {
    confirmedTerminalGravity: row.confirmed_terminal_gravity,
    beerVolumeLiters: row.beer_volume_liters == null ? null : Number(row.beer_volume_liters),
    headspaceLiters: row.headspace_liters == null ? null : Number(row.headspace_liters),
    hardwareMaxBar: row.hardware_max_bar == null ? null : Number(row.hardware_max_bar),
    prvLimitBar: row.prv_limit_bar == null ? null : Number(row.prv_limit_bar),
    deviceLimitBar: row.device_limit_bar == null ? null : Number(row.device_limit_bar),
    co2MeasurementMethod: row.co2_measurement_method || null,
    pressureBasis: row.pressure_basis, altitudeMeters: row.altitude_meters == null ? null : Number(row.altitude_meters),
    hopCreepAcknowledged: row.hop_creep_acknowledged,
  };
  state = await saveState(state);
  render();
}

window.addEventListener("online", async () => { await refreshRemoteState(); render(); });
window.addEventListener("offline", render);
window.addEventListener("focus", revalidateOpenOperatorSession);
setInterval(revalidateOpenOperatorSession, 60_000);

async function initializeApp() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch((error) => console.error("Service worker registration failed", error));
  if (!isSupabaseConfigured) { render(); return; }
  const { data, error } = await supabase.auth.getSession();
  if (error) { authPage("Neizdevās pārbaudīt sesiju. Pārbaudi interneta savienojumu.", true); return; }
  authSession = data.session;
  if (authSession) await loadWorkspace(); else authPage();
  supabase.auth.onAuthStateChange((_event, session) => {
    authSession = session;
    if (!session) { clearOperatorSession(); authPage(); }
  });
}

initializeApp();
