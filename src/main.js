import "./styles.css";
import { icons, createElement } from "lucide";
import { ACTION_LABELS, ACTION_TYPES, BATCH_STATUS, FERMENTERS, addDays, buildWorkTimeline, calculateHistoryStats, completedPackagingVolume, formatBatchNumber, getDailyTasks, getFermenter, getRecommendedAction, remainingInFermenter, requiredPackagingRuns, validateGravity, validatePh, validatePressure, validateTemperature } from "./domain.js";
import { loadState, saveState } from "./store.js";
import { isSupabaseConfigured, supabase } from "./supabase.js";
import { fetchRemoteState, syncEvent } from "./sync.js";

const app = document.querySelector("#app");
let state = await loadState();
let route = "dashboard";
let selectedBatchId = null;
let authSession = null;
let authMode = "login";
let brewery = null;
let operatorUnlocked = false;

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
    state = await saveState(state);
  } catch (error) {
    console.error("Supabase synchronization failed", error);
    if (!isTransientSyncError(error)) alert(`Datu ielāde neizdevās: ${friendlySyncError(error)}`);
  }
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
    return true;
  } catch (error) {
    console.error("Change synchronization failed", error);
    if (/VERSION_CONFLICT/i.test(error.message || "")) {
      state.pendingSync = state.pendingSync.filter((item) => item.id !== queued.id);
      state = await saveState(state);
      alert("Šo ierakstu citā ierīcē jau mainīja. Tiks ielādēta jaunākā servera versija; pārbaudi datus un atkārto darbību.");
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
function currentOperator() { return state.operators.find((operator) => operator.id === state.activeOperatorId) || state.operators[0]; }
function today() { return localDateTimeValue().slice(0, 10); }
function localDateTimeValue(value = new Date()) {
  const date = new Date(value);
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}
function formatDate(value) { return new Intl.DateTimeFormat("lv-LV", { day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(`${value.slice(0, 10)}T00:00:00`)); }

function dailyTaskItems() {
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
  dialog.innerHTML = `<div class="dialog-card daily-dialog"><button class="dialog-close" data-close-daily>${icon("X")}</button><p class="eyebrow">Šodienas darbi</p><h2>${tasks.length} ${tasks.length === 1 ? "uzdevums" : "uzdevumi"}</h2><p>Pārbaudi un izpildi darbus, kas šodien gaida fermentorveikalā.</p><div class="daily-task-list">${tasks.map((task) => `<button data-daily-batch="${escapeHtml(task.batch.id)}" class="daily-task ${escapeHtml(task.tone)}"><span class="tank-number">${escapeHtml(task.batch.fermenterNumber)}</span><span><strong>${escapeHtml(task.beerName)}</strong><small>#${escapeHtml(task.batch.batchNumber)} · ${escapeHtml(task.label)}</small></span>${icon("ChevronRight")}</button>`).join("")}</div><button class="secondary full" data-close-daily>Aizvērt</button></div>`;
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
}

function dashboard() {
  const batches = activeBatches();
  shell(`<main><section class="page-heading"><div><p class="eyebrow">Fermentācijas pārskats</p><h1>Kas jādara šodien?</h1></div><button class="primary" data-action="new-batch">${icon("Plus")} Jauna partija</button></section><section class="summary"><article><strong>${batches.length}</strong><span>aktīvas partijas</span></article><article><strong>${12 - batches.length}</strong><span>brīvas fermentācijas tvertnes</span></article><article><strong>${batches.filter((batch) => getRecommendedAction(batch).tone === "urgent").length}</strong><span>steidzamas darbības</span></article></section><section class="tank-grid">${FERMENTERS.map((tank) => tankCard(tank.number)).join("")}</section></main>`, "BrewTracker Pro");
}

function tankCard(number) {
  const vessel = getFermenter(number);
  if (vessel.type === "brite") {
    const activeRun = activePackagingRun();
    const beer = activeRun && state.beerTypes.find((item) => item.id === activeRun.batch.beerTypeId);
    return activeRun
      ? `<article class="tank-card brite occupied" data-open-batch="${activeRun.batch.id}"><div class="tank-number">D</div><div class="tank-main"><div class="card-top"><span class="batch-no">DZIDRA · ${activeRun.volumeTons} t</span><span class="days">Cikls ${activeRun.runNumber}</span></div><h2>${escapeHtml(beer?.name || "Alus")}</h2><p>Izfiltrēts, gaida pildīšanu</p><div class="recommendation urgent">${icon("PackageCheck", 18)} Sapildīt no Dzidras</div></div>${icon("ChevronRight")}</article>`
      : `<article class="tank-card brite empty"><div class="tank-number">D</div><div><h2>Dzidra</h2><p>4 t Brite Tank · brīva</p></div></article>`;
  }
  const batch = activeBatches().find((item) => item.fermenterNumber === number);
  if (!batch) return `<article class="tank-card empty"><div class="tank-number">${number}</div><div><h2>Brīva tvertne</h2><p>Kapacitāte ${vessel.capacityTons} t</p></div><button data-action="new-batch" data-tank="${number}">${icon("Plus")}</button></article>`;
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
  shell(`<main class="narrow"><button class="text-button" data-route="dashboard">${icon("ArrowLeft")} Atpakaļ</button><section class="page-heading"><div><p class="eyebrow">Jauna fermentācija</p><h1>Izveidot partiju</h1></div></section><form id="batch-form" class="form-card"><div class="field full"><label>Alus nosaukums</label><input name="beerName" list="beer-types" required autocomplete="off"><datalist id="beer-types">${beerOptions}</datalist><small>Esošam nosaukumam tiks izmantoti saglabātie sliekšņi.</small></div><div class="field"><label>Tilpums, tonnas</label><input name="volumeTons" type="number" min="0.1" step="0.1" required></div><div class="field"><label>Vārīšanas datums</label><input name="brewDate" type="date" value="${today()}" required></div><div class="field"><label>Kārtas numurs gadā</label><input name="sequence" type="number" min="1" max="999" value="${nextSequence}" required></div><div class="field"><label>Fermentācijas tvertne</label><select name="fermenterNumber" required><option value="">Izvēlies</option>${FERMENTERS.filter((item) => item.type === "fermenter").map((item) => `<option value="${item.number}" ${String(item.number) === String(tank) ? "selected" : ""} ${activeBatches().some((batch) => batch.fermenterNumber === item.number) ? "disabled" : ""}>${item.name} · max ${item.capacityTons} t${activeBatches().some((batch) => batch.fermenterNumber === item.number) ? " — aizņemta" : ""}</option>`).join("")}</select></div><hr><h2 class="full">Procesa sliekšņi</h2><div class="field"><label>Sākotnējais blīvums (OG)</label><input name="ogTarget" inputmode="numeric" placeholder="1056" required></div><div class="field"><label>Gala blīvums (FG)</label><input name="fgTarget" inputmode="numeric" placeholder="1012" required></div><div class="field"><label>Vārstu aizgriezt pie</label><input name="spundGravity" inputmode="numeric" placeholder="1026" required></div><div class="field"><label>Dzesēt uz 0 °C pie</label><input name="coolingGravity" inputmode="numeric" placeholder="1018" required></div><label class="check full"><input name="hasDryHop" type="checkbox"><span>Šim alum ir Dry Hop</span></label><div class="field" id="dry-hop-field" hidden><label>Dry Hop pie blīvuma</label><input name="dryHopGravity" inputmode="numeric" placeholder="1022"></div><div class="field"><label>Mērķa CO₂, vol</label><input name="co2Target" type="number" min="1" max="4" step="0.1" value="2.4" required></div><div class="form-error full" id="form-error"></div><button class="primary full" type="submit">Izveidot partiju</button></form></main>`, "Jauna partija");
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
    const data = Object.fromEntries(new FormData(form));
    const year = Number(data.brewDate.slice(0, 4));
    const sequence = Number(data.sequence);
    const fermenterNumber = Number(data.fermenterNumber);
    const vessel = getFermenter(fermenterNumber);
    if (!vessel || vessel.type !== "fermenter") throw new Error("Izvēlies fermentācijas tvertni no 1 līdz 12.");
    if (Number(data.volumeTons) > vessel.capacityTons) throw new Error(`${vessel.name} maksimālā ietilpība ir ${vessel.capacityTons} t.`);
    const batchNumber = formatBatchNumber(year, sequence, fermenterNumber);
    if (state.batches.some((batch) => batch.batchNumber === batchNumber)) throw new Error(`Partija ${batchNumber} jau eksistē.`);
    if (activeBatches().some((batch) => batch.fermenterNumber === fermenterNumber)) throw new Error(`Tvertne ${fermenterNumber} jau ir aizņemta.`);
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
  shell(`<main class="narrow"><button class="text-button" data-route="dashboard">${icon("ArrowLeft")} Visas tvertnes</button><section class="batch-hero"><div><span class="batch-no">#${escapeHtml(batch.batchNumber)} · Tvertne ${escapeHtml(batch.fermenterNumber)}</span><h1>${escapeHtml(beer.name)} <small>${remainingInFermenter(batch)} t tvertnē no ${batch.volumeTons} t</small></h1><p>Sākts ${formatDate(batch.brewDate)}</p></div><div class="hero-actions"><span class="status">${batch.status === BATCH_STATUS.FINISHED ? "Pabeigts" : "Aktīvs"}</span><button class="danger-button" data-delete-batch="${batch.id}">${icon("Trash2", 17)} Dzēst partiju</button></div></section><section class="action-banner ${recommendation.tone}"><div>${icon("Sparkles", 24)}<span><small>Ieteicamā darbība</small><strong>${recommendation.label}</strong></span></div></section>${predictionPanel(batch, stats)}<section class="detail-grid"><article class="panel"><div class="panel-title"><h2>Jauns mērījums</h2><span>Var saglabāt bez interneta</span></div><form id="measurement-form" class="measurement-form"><div class="field full"><label>Mērījuma datums un laiks</label><input name="measuredAt" type="datetime-local" value="${localDateTimeValue()}" required></div><div class="field"><label>Blīvums</label><input name="gravity" inputmode="numeric" placeholder="1054" required></div><div class="field"><label>pH</label><input name="ph" type="number" min="0" max="14" step="0.01" placeholder="4.20" required></div><div class="field"><label>Temperatūra °C</label><input name="temperature" type="number" min="-5" max="50" step="0.1" placeholder="19.5" required></div><div class="field"><label>Spiediens bar</label><input name="pressure" type="number" min="0" max="5" step="0.01" placeholder="0.80"></div><div class="field full"><label>Saistītā fermentācijas darbība</label><select name="actionType"><option value="">Nav — tikai mērījums</option><option value="spund">Aizgriezts vārsts</option>${batch.hasDryHop ? `<option value="dry_hop">Pievienots Dry Hop</option>` : ""}<option value="cool">Iestatīta dzesēšana uz 0 °C</option></select></div><div class="field full"><label>Piezīme</label><input name="note" placeholder="Neobligāta piezīme"></div><div class="form-error full" id="measurement-error"></div><button class="primary full">${icon("Save")} Saglabāt mērījumu</button></form></article><article class="panel"><div class="panel-title"><h2>Fermentācijas darbības</h2></div><div class="action-list">${[ACTION_TYPES.SPUND, ...(batch.hasDryHop ? [ACTION_TYPES.DRY_HOP] : []), ACTION_TYPES.COOL].map((type) => actionButton(batch, type)).join("")}</div></article></section>${packagingPanel(batch)}<section class="panel"><div class="panel-title"><h2>Mērījumu vēsture</h2><span>${batch.measurements.length} ieraksti</span></div>${measurementTable(batch)}</section></main>`, beer.name);
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
  return `<section class="panel packaging-panel"><div class="panel-title"><div><h2>Filtrēšana un pildīšana</h2><p>${packaged} no ${batch.volumeTons} t sapildītas · tvertnē palikušas ${remainingInFermenter(batch)} t</p></div>${canFilter ? `<button class="primary" data-filter-to-brite>${icon("ArrowRightLeft")} Filtrēt uz Dzidru</button>` : ""}</div><div class="packaging-runs">${runs.length ? runs.map((run) => `<article class="packaging-run ${run.status}"><div><span>Cikls ${run.runNumber} no ${required}</span><strong>${run.volumeTons} t · ${run.status === "filtered" ? "Dzidrā" : "Sapildīts"}</strong><small>${formatDate(run.filteredAt)}${run.packagedAt ? ` → ${formatDate(run.packagedAt)}` : ""}${run.centrifugeLiters != null ? ` · centrifūga ${run.centrifugeLiters} l` : ""}</small></div>${run.status === "filtered" ? `<button class="primary" data-finish-packaging="${run.id}">${icon("PackageCheck")} Sapildīts</button>` : icon("CircleCheckBig", 28)}</article>`).join("") : `<div class="empty-state compact"><p>${coolingDone ? (briteBusy ? "Dzidra pašlaik ir aizņemta ar citu partiju." : "Alus gatavs filtrēšanai uz Dzidru.") : "Pirms filtrēšanas pabeidz dzesēšanu uz 0 °C."}</p></div>`}</div></section>`;
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
  return `<div class="table-wrap"><table><thead><tr><th>Laiks</th><th>Darbība</th><th>Blīvums</th><th>pH</th><th>°C</th><th>bar</th><th>Operators</th></tr></thead><tbody>${[...batch.measurements].reverse().map((item) => `<tr><td>${new Date(item.measuredAt).toLocaleString("lv-LV", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })}</td><td>${item.actionType ? `<span class="action-tag">${ACTION_LABELS[item.actionType]}</span>` : "—"}</td><td><strong>${item.gravity}</strong></td><td>${item.ph}</td><td>${item.temperature}</td><td>${item.pressure ?? "—"}</td><td>${escapeHtml(state.operators.find((op) => op.id === item.operatorId)?.name || "—")}</td></tr>`).join("")}</tbody></table></div>`;
}

async function submitMeasurement(form) {
  try {
    const data = Object.fromEntries(new FormData(form));
    const batch = state.batches.find((item) => item.id === selectedBatchId);
    const measuredAt = new Date(data.measuredAt).toISOString();
    let processActionId = null;
    if (data.actionType) {
      const previousAction = batch.actions.find((item) => item.type === data.actionType);
      const action = { id: previousAction?.id || crypto.randomUUID(), version: previousAction?.version || 0, type: data.actionType, performedAt: measuredAt, gravity: validateGravity(data.gravity), ph: validatePh(data.ph), temperature: validateTemperature(data.temperature), pressure: validatePressure(data.pressure), note: data.note.trim(), operatorId: currentOperator().id };
      batch.actions = batch.actions.filter((item) => item.type !== data.actionType);
      batch.actions.push(action);
      if (data.actionType === ACTION_TYPES.DRY_HOP) batch.status = BATCH_STATUS.DRY_HOP;
      if (data.actionType === ACTION_TYPES.COOL) batch.status = BATCH_STATUS.COOLING;
      processActionId = action.id;
    }
    const measurement = { id: crypto.randomUUID(), version: 0, measuredAt, gravity: validateGravity(data.gravity), ph: validatePh(data.ph), temperature: validateTemperature(data.temperature), pressure: validatePressure(data.pressure), note: data.note.trim(), operatorId: currentOperator().id, processActionId, actionType: data.actionType || null };
    batch.measurements.push(measurement);
    if (data.actionType) {
      if (!await saveAndSync({ entity: "processBundle", operation: "apply", batchId: batch.id, actionId: processActionId, measurementId: measurement.id })) return;
    } else if (!await saveAndSync({ entity: "measurement", operation: "create", entityId: measurement.id })) return;
    render();
  } catch (error) { document.querySelector("#measurement-error").textContent = error.message; }
}

function actionDialog(type) {
  const batch = state.batches.find((item) => item.id === selectedBatchId);
  const latest = batch.measurements.at(-1);
  const dialog = document.createElement("dialog");
  dialog.innerHTML = `<form method="dialog" id="action-form" class="dialog-card"><button class="dialog-close" value="cancel">${icon("X")}</button><p class="eyebrow">Procesa darbība</p><h2>${ACTION_LABELS[type]}</h2><p>Fiksē mērījumus darbības izpildes brīdī.</p><div class="measurement-form"><div class="field full"><label>Darbības datums un laiks</label><input name="performedAt" type="datetime-local" value="${localDateTimeValue()}" required></div><div class="field"><label>Blīvums</label><input name="gravity" value="${latest?.gravity ?? ""}" required></div><div class="field"><label>pH</label><input name="ph" type="number" step="0.01" value="${latest?.ph ?? ""}" required></div><div class="field"><label>Temperatūra °C</label><input name="temperature" type="number" step="0.1" value="${latest?.temperature ?? ""}" required></div><div class="field"><label>Spiediens bar</label><input name="pressure" type="number" step="0.01" value="${latest?.pressure ?? ""}"></div><div class="form-error full" id="action-error"></div><button class="primary full" value="default">Apstiprināt darbību</button></div></form>`;
  document.body.append(dialog); dialog.showModal();
  dialog.addEventListener("close", async () => { if (dialog.returnValue === "default") await completeAction(type, dialog.querySelector("form")); dialog.remove(); });
}

function filterToBriteDialog() {
  const batch = state.batches.find((item) => item.id === selectedBatchId);
  const latest = batch.measurements.at(-1);
  const remaining = remainingInFermenter(batch);
  const volume = Math.min(4, remaining);
  const dialog = document.createElement("dialog");
  dialog.innerHTML = `<form method="dialog" id="filter-form" class="dialog-card"><button class="dialog-close" value="cancel">${icon("X")}</button><p class="eyebrow">Dzidra · Brite Tank</p><h2>Filtrēt uz Dzidru</h2><p>Fermentācijas tvertne paliks aizņemta, līdz šis alus būs sapildīts pilnā apjomā.</p><div class="measurement-form"><div class="field full"><label>Filtrēšanas datums un laiks</label><input name="filteredAt" type="datetime-local" value="${localDateTimeValue()}" required></div><div class="field"><label>No tvertnes paņemtais apjoms, t</label><input name="volumeTons" type="number" min="0.1" max="4" step="0.1" value="${volume}" required></div><div class="field"><label>Centrifūgas rādījums, litri</label><input name="centrifugeLiters" type="number" min="0" step="1" placeholder="Neobligāts"></div><div class="field"><label>Blīvums</label><input name="gravity" value="${latest?.gravity ?? ""}" required></div><div class="field"><label>pH</label><input name="ph" type="number" step="0.01" value="${latest?.ph ?? ""}" required></div><div class="field"><label>Temperatūra °C</label><input name="temperature" type="number" step="0.1" value="${latest?.temperature ?? ""}" required></div><div class="field"><label>Spiediens bar</label><input name="pressure" type="number" step="0.01" value="${latest?.pressure ?? ""}"></div><div class="form-error full" id="filter-error"></div><button class="primary full" value="default">Apstiprināt filtrēšanu</button></div></form>`;
  document.body.append(dialog); dialog.showModal();
  dialog.addEventListener("close", async () => { if (dialog.returnValue === "default") await createPackagingRun(dialog.querySelector("form")); dialog.remove(); });
}

async function createPackagingRun(form) {
  try {
    const data = Object.fromEntries(new FormData(form));
    const batch = state.batches.find((item) => item.id === selectedBatchId);
    if (activePackagingRun()) throw new Error("Dzidra pašlaik ir aizņemta.");
    const remaining = remainingInFermenter(batch);
    const volumeTons = Number(data.volumeTons);
    if (volumeTons <= 0 || volumeTons > 4 || volumeTons > remaining) throw new Error(`Atļauts filtrēt ne vairāk kā ${Math.min(4, remaining)} t.`);
    const run = { id: crypto.randomUUID(), version: 0, clientId: crypto.randomUUID(), runNumber: (batch.packagingRuns || []).length + 1, volumeTons, centrifugeLiters: data.centrifugeLiters === "" ? null : Number(data.centrifugeLiters), status: "filtered", filteredAt: new Date(data.filteredAt).toISOString(), packagedAt: null, gravity: validateGravity(data.gravity), ph: validatePh(data.ph), temperature: validateTemperature(data.temperature), pressure: validatePressure(data.pressure), co2Vol: null, operatorId: currentOperator().id };
    batch.packagingRuns ||= []; batch.packagingRuns.push(run);
    if (!await saveAndSync({ entity: "packagingRun", operation: "create", entityId: run.id })) return;
    render();
  } catch (error) { alert(error.message); }
}

function finishPackagingDialog(runId) {
  const batch = state.batches.find((item) => item.id === selectedBatchId);
  const run = batch.packagingRuns.find((item) => item.id === runId);
  const dialog = document.createElement("dialog");
  dialog.innerHTML = `<form method="dialog" class="dialog-card"><button class="dialog-close" value="cancel">${icon("X")}</button><p class="eyebrow">Pildīšana · cikls ${run.runNumber}</p><h2>Apstiprināt pildīšanu</h2><p>Pēc apstiprināšanas Dzidra būs brīva nākamajam filtrēšanas ciklam.</p><div class="measurement-form"><div class="field full"><label>Pildīšanas datums un laiks</label><input name="packagedAt" type="datetime-local" value="${localDateTimeValue()}" required></div><div class="field"><label>Gala blīvums</label><input name="gravity" value="${run.gravity}" required></div><div class="field"><label>pH</label><input name="ph" type="number" step="0.01" value="${run.ph}" required></div><div class="field"><label>Temperatūra °C</label><input name="temperature" type="number" step="0.1" value="${run.temperature}" required></div><div class="field"><label>CO₂, vol</label><input name="co2Vol" type="number" min="0" max="5" step="0.1" value="${batch.co2Target}" required></div><button class="primary full" value="default">Sapildīts</button></div></form>`;
  document.body.append(dialog); dialog.showModal();
  dialog.addEventListener("close", async () => { if (dialog.returnValue === "default") await finishPackagingRun(runId, dialog.querySelector("form")); dialog.remove(); });
}

async function finishPackagingRun(runId, form) {
  try {
    const data = Object.fromEntries(new FormData(form));
    const batch = state.batches.find((item) => item.id === selectedBatchId);
    const run = batch.packagingRuns.find((item) => item.id === runId);
    Object.assign(run, { status: "packaged", packagedAt: new Date(data.packagedAt).toISOString(), gravity: validateGravity(data.gravity), ph: validatePh(data.ph), temperature: validateTemperature(data.temperature), pressure: null, co2Vol: Number(data.co2Vol), operatorId: currentOperator().id });
    if (completedPackagingVolume(batch) >= Number(batch.volumeTons)) {
      batch.status = BATCH_STATUS.FINISHED;
      batch.finishedAt = run.packagedAt;
      batch.actions = batch.actions.filter((item) => item.type !== ACTION_TYPES.FINISH);
      batch.actions.push({ id: crypto.randomUUID(), version: 0, type: ACTION_TYPES.FINISH, performedAt: run.packagedAt, gravity: run.gravity, ph: run.ph, temperature: run.temperature, pressure: run.pressure, operatorId: run.operatorId });
    }
    if (batch.status === BATCH_STATUS.FINISHED) {
      const finishAction = batch.actions.find((item) => item.type === ACTION_TYPES.FINISH);
      if (!await saveAndSync({ entity: "packagingCompletion", operation: "apply", batchId: batch.id, packagingRunId: run.id, actionId: finishAction.id })) return;
    } else if (!await saveAndSync({ entity: "packagingRun", operation: "update", entityId: run.id })) return;
    render();
  } catch (error) { alert(error.message); }
}

async function completeAction(type, form) {
  try {
    const data = Object.fromEntries(new FormData(form));
    const batch = state.batches.find((item) => item.id === selectedBatchId);
    const previousAction = batch.actions.find((item) => item.type === type);
    const action = { id: previousAction?.id || crypto.randomUUID(), version: previousAction?.version || 0, type, performedAt: new Date(data.performedAt).toISOString(), gravity: validateGravity(data.gravity), ph: validatePh(data.ph), temperature: validateTemperature(data.temperature), pressure: validatePressure(data.pressure), operatorId: currentOperator().id };
    batch.actions = batch.actions.filter((item) => item.type !== type); batch.actions.push(action);
    if (type === ACTION_TYPES.DRY_HOP) batch.status = BATCH_STATUS.DRY_HOP;
    if (type === ACTION_TYPES.COOL) batch.status = BATCH_STATUS.COOLING;
    if (type === ACTION_TYPES.FINISH) batch.status = BATCH_STATUS.FINISHED;
    const actionMeasurement = { id: crypto.randomUUID(), version: 0, measuredAt: action.performedAt, gravity: action.gravity, ph: action.ph, temperature: action.temperature, pressure: action.pressure, note: ACTION_LABELS[type], operatorId: action.operatorId, processActionId: action.id, actionType: type };
    batch.measurements.push(actionMeasurement);
    if (!await saveAndSync({ entity: "processBundle", operation: "apply", batchId: batch.id, actionId: action.id, measurementId: actionMeasurement.id })) return;
    render();
  } catch (error) { alert(error.message); }
}

function tasksPage() {
  const timeline = buildWorkTimeline(state.batches);
  const horizon = addDays(today(), 3);
  const upcoming = timeline.filter((task) => task.date <= horizon);
  const later = timeline.filter((task) => task.date > horizon);
  shell(`<main><section class="page-heading"><div><p class="eyebrow">Procesa kalendārs</p><h1>Darbu plāns</h1><p>Šodienas darbi un prognoze uz priekšu pēc iepriekšējām tā paša alus partijām.</p></div></section><section class="planning-summary"><article><strong>${timeline.filter((task) => task.date === today()).length}</strong><span>darbi šodien</span></article><article><strong>${upcoming.filter((task) => task.date > today()).length}</strong><span>nākamajās 3 dienās</span></article><article><strong>${later.length}</strong><span>ieplānoti vēlāk</span></article></section><section class="timeline-panel"><div class="panel-title"><div><h2>Šodiena un nākamās trīs dienas</h2><p>Piektdien pārbaudi šo sarakstu pirms došanās prom.</p></div></div>${renderTimeline(upcoming, "Tuvākajās dienās prognozētu darbu nav.")}</section><section class="timeline-panel later-timeline"><div class="panel-title"><div><h2>Vēlākie darbi</h2><p>Hronoloģiska prognoze visām aktīvajām partijām.</p></div></div>${renderTimeline(later, "Vēlāku darbu prognozei vēl nepietiek vēsturisko datu.")}</section></main>`, "Darbu plāns");
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
  return `<button class="timeline-task ${task.tone}" data-open-batch="${task.batchId}"><span class="tank-number">${batch?.fermenterNumber || "?"}</span><span><strong>${task.label}</strong><small>${escapeHtml(beer?.name || "Nezināms alus")} · #${batch?.batchNumber || "—"}${task.source === "history" ? ` · prognoze no ${task.sampleCount} ${task.sampleCount === 1 ? "partijas" : "partijām"}` : ""}</small></span>${icon("ChevronRight")}</button>`;
}

function analyticsPage() {
  const beers = state.beerTypes.map((beer) => ({
    ...beer,
    batches: state.batches.filter((batch) => batch.beerTypeId === beer.id && batch.status === BATCH_STATUS.FINISHED),
  })).sort((a, b) => b.batches.length - a.batches.length);
  shell(`<main><section class="page-heading"><div><p class="eyebrow">Vēsturisko datu salīdzinājums</p><h1>Alus analīze</h1><p>Katrs alus veids tiks analizēts atsevišķi pēc fermentācijas dienas. Jaunāko partiju salīdzināsim ar četrām iepriekšējām un visu šī alus partiju vidējo procesu.</p></div></section><section class="analysis-metrics">${["Blīvums", "pH", "Temperatūra", "Spiediens", "CO₂"].map((metric) => `<span>${icon(metric === "Temperatūra" ? "Thermometer" : metric === "Spiediens" ? "Gauge" : "ChartSpline", 17)} ${metric}</span>`).join("")}</section><section class="analysis-grid">${beers.length ? beers.map((beer) => analysisBeerCard(beer)).join("") : `<div class="empty-state analysis-empty">${icon("ChartNoAxesCombined", 44)}<h2>Analīzei vēl nav alus datu</h2><p>Pēc pabeigtu partiju uzkrāšanas katram alum šeit būs savas līknes.</p></div>`}</section><section class="panel analysis-note"><div><p class="eyebrow">Plānotā analīze</p><h2>Procesa vienādības kontrole</h2><p>Vienāds fermentācijas profils palīdzēs laikus pamanīt, ka jaunākā partija uzvedas citādi.</p></div><ul><li>Jaunākā partija — izcelta galvenā līkne</li><li>Četras iepriekšējās tā paša alus partijas — salīdzinājuma līknes</li><li>Visu šī alus vēsturisko partiju kopējā vidējā līkne</li><li>Blīvums, pH, temperatūra, spiediens un CO₂ pēc fermentācijas dienas</li><li>Vārsta, Dry Hop, dzesēšanas, filtrēšanas un pildīšanas punkti</li><li>Novirze no vidējā un brīdinājums par neparastu fermentācijas gaitu</li></ul></section></main>`, "Alus analīze");
}

function analysisBeerCard(beer) {
  const count = beer.batches.length;
  const readiness = count >= 5 ? "Gatavs: jaunākā + 4 iepriekšējās" : count >= 2 ? "Var sākt salīdzināšanu" : "Vajadzīgas vismaz 2 pabeigtas partijas";
  return `<article class="analysis-beer-card"><div class="analysis-card-head"><div><span>${count} pabeigtas partijas</span><h2>${escapeHtml(beer.name)}</h2></div><span class="analysis-status ${count >= 2 ? "ready" : ""}">${readiness}</span></div><div class="chart-placeholder" aria-hidden="true"><svg viewBox="0 0 420 110" preserveAspectRatio="none"><path d="M0 18 C65 25 80 52 140 48 S220 73 280 70 S350 91 420 92"/><path d="M0 27 C55 34 95 40 145 57 S230 62 285 78 S360 82 420 98"/><path class="average" d="M0 22 C60 30 90 46 143 52 S225 68 282 74 S355 87 420 95"/></svg></div><div class="analysis-legend"><span><i></i>Jaunākā + 4 iepriekšējās</span><span><i class="average"></i>Visu partiju vidējais</span></div></article>`;
}

function historyPage() {
  const finished = state.batches.filter((batch) => batch.status === BATCH_STATUS.FINISHED).reverse();
  const deleted = state.deletedBatches || [];
  shell(`<main><section class="page-heading"><div><p class="eyebrow">Pabeigtās partijas</p><h1>Vēsture</h1></div></section><section class="history-list">${finished.length ? finished.map((batch) => { const beer = state.beerTypes.find((item) => item.id === batch.beerTypeId); return `<button class="history-row" data-open-batch="${batch.id}"><span class="tank-number">${batch.fermenterNumber}</span><span><strong>${escapeHtml(beer.name)} · ${batch.volumeTons} t</strong><small>#${escapeHtml(batch.batchNumber)} · ${formatDate(batch.brewDate)} · ${batch.measurements.length} mērījumi</small></span>${icon("ChevronRight")}</button>`; }).join("") : `<div class="empty-state">${icon("History", 38)}<h2>Vēsture vēl ir tukša</h2><p>Pabeigtās partijas būs redzamas šeit.</p></div>`}</section><section class="panel trash-panel"><div class="panel-title"><div><p class="eyebrow">Atjaunošana</p><h2>Miskaste</h2></div><span>${deleted.length} partijas</span></div>${deleted.length ? `<div class="history-list">${deleted.map((batch) => `<div class="history-row trash-row"><span class="tank-number">${icon("Trash2",18)}</span><span><strong>${escapeHtml(batch.beerName)} · #${escapeHtml(batch.batchNumber)}</strong><small>${formatDate(batch.brewDate)} · ${escapeHtml(batch.deleteReason || "Iemesls nav norādīts")} · ${escapeHtml(batch.deletedByName || "Operators")}</small></span><button class="secondary" data-restore-batch="${batch.id}">${icon("Undo2",16)} Atjaunot</button></div>`).join("")}</div>` : `<div class="empty-state compact"><p>Dzēstu partiju nav.</p></div>`}</section></main>`, "Vēsture");
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
  const batchButton = event.target.closest("[data-open-batch]");
  if (batchButton) { selectedBatchId = batchButton.dataset.openBatch; route = "batch"; render(); return; }
  const actionButton = event.target.closest("[data-batch-action]");
  if (actionButton) { actionDialog(actionButton.dataset.batchAction); return; }
  if (event.target.closest("[data-filter-to-brite]")) { filterToBriteDialog(); return; }
  const finishPackagingButton = event.target.closest("[data-finish-packaging]");
  if (finishPackagingButton) { finishPackagingDialog(finishPackagingButton.dataset.finishPackaging); return; }
  const deleteBatchButton = event.target.closest("[data-delete-batch]");
  if (deleteBatchButton) { deleteBatchDialog(deleteBatchButton.dataset.deleteBatch); return; }
  const restoreBatchButton = event.target.closest("[data-restore-batch]");
  if (restoreBatchButton) { await restoreBatch(restoreBatchButton.dataset.restoreBatch); return; }
  if (event.target.closest("[data-reset-brewing-data]")) { resetBrewingDataDialog(); return; }
  if (event.target.closest("[data-show-daily-tasks]")) { showDailyTasks(); return; }
  if (event.target.closest("[data-enable-notifications]")) { enableNotifications(); return; }
  if (event.target.closest('[data-action="operators"]')) await operatorDialog();
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
});

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
