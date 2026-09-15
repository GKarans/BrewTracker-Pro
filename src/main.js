import "./styles.css";
import { icons, createElement } from "lucide";
import { ACTION_LABELS, ACTION_TYPES, BATCH_STATUS, addDays, calculateHistoryStats, formatBatchNumber, getRecommendedAction, validateGravity, validatePh, validatePressure, validateTemperature } from "./domain.js";
import { loadState, saveState } from "./store.js";
import { isSupabaseConfigured, supabase } from "./supabase.js";

const app = document.querySelector("#app");
let state = await loadState();
let route = "dashboard";
let selectedBatchId = null;
let authSession = null;
let authMode = "login";
let brewery = null;
let operatorUnlocked = false;

function icon(name, size = 20) {
  return createElement(icons[name], { width: size, height: size, "stroke-width": 2.2 }).outerHTML;
}

function authPage(message = "", isError = false) {
  app.innerHTML = `<main class="auth-page"><section class="auth-card"><div class="auth-brand"><span class="brand-mark">BT</span><div><h1>BrewTracker Pro</h1><p>Alus fermentācijas procesa asistents</p></div></div><div class="auth-tabs"><button type="button" data-auth-mode="login" class="${authMode === "login" ? "active" : ""}">Ieiet</button><button type="button" data-auth-mode="signup" class="${authMode === "signup" ? "active" : ""}">Reģistrēties</button></div><form id="auth-form"><div class="field"><label>E-pasts</label><input name="email" type="email" autocomplete="email" required placeholder="daritava@epasts.lv"></div><div class="field"><label>Parole</label><input name="password" type="password" autocomplete="${authMode === "login" ? "current-password" : "new-password"}" minlength="8" required placeholder="Vismaz 8 rakstzīmes"></div>${authMode === "signup" ? `<div class="field"><label>Atkārto paroli</label><input name="passwordConfirm" type="password" autocomplete="new-password" minlength="8" required></div>` : ""}<div class="auth-message ${isError ? "error" : ""}">${message}</div><button class="primary full" type="submit">${authMode === "login" ? "Ieiet aplikācijā" : "Izveidot kontu"}</button></form><p class="auth-note">Šis būs viens kopīgs alus darītavas konts. Darbinieku darbības tiks nošķirtas ar operatoru profiliem un PIN.</p></section></main>`;
}

function onboardingPage(message = "") {
  app.innerHTML = `<main class="auth-page"><section class="auth-card"><div class="auth-brand"><span class="brand-mark">BT</span><div><h1>Sākotnējā iestatīšana</h1><p>Izveido alus darītavu un pirmo operatoru</p></div></div><form id="onboarding-form"><div class="field"><label>Alus darītavas nosaukums</label><input name="breweryName" required value="Labietis" autocomplete="organization"></div><div class="field"><label>Pirmā operatora vārds</label><input name="operatorName" required autocomplete="name" placeholder="Piemēram, Jānis"></div><div class="field"><label>Operatora PIN</label><input name="pin" type="password" inputmode="numeric" pattern="[0-9]{4,8}" minlength="4" maxlength="8" required placeholder="4–8 cipari"></div><div class="field"><label>Atkārto PIN</label><input name="pinConfirm" type="password" inputmode="numeric" pattern="[0-9]{4,8}" minlength="4" maxlength="8" required></div><div class="auth-message error">${message}</div><button class="primary full" type="submit">Izveidot darba vidi</button></form><p class="auth-note">Tiks automātiski izveidotas 13 fermentācijas tvertnes. Vēlāk varēsi pievienot pārējos operatorus.</p></section></main>`;
}

function operatorUnlockPage(message = "") {
  app.innerHTML = `<main class="auth-page"><section class="auth-card"><div class="auth-brand"><span class="brand-mark">BT</span><div><h1>Kas šobrīd strādā?</h1><p>${brewery?.name || "BrewTracker Pro"}</p></div></div><form id="operator-unlock-form"><div class="field"><label>Operators</label><select name="operatorId" required><option value="">Izvēlies savu profilu</option>${state.operators.filter((operator) => operator.is_active !== false).map((operator) => `<option value="${operator.id}">${operator.name}</option>`).join("")}</select></div><div class="field"><label>PIN</label><input name="pin" type="password" inputmode="numeric" pattern="[0-9]{4,8}" minlength="4" maxlength="8" required placeholder="••••"></div><div class="auth-message error">${message}</div><button class="primary full" type="submit">Turpināt</button><button class="text-button auth-logout" type="button" data-auth-logout>Iziet no kopīgā konta</button></form></section></main>`;
}

async function loadWorkspace() {
  const { data: breweryData, error } = await supabase.from("breweries").select("id, name").maybeSingle();
  if (error) {
    if (error.code === "42P01") onboardingPage("Datubāzes tabulas nav atrastas. Pārbaudi, vai pirmā SQL migrācija ir izpildīta.");
    else onboardingPage(`Neizdevās ielādēt darba vidi: ${error.message}`);
    return;
  }
  brewery = breweryData;
  if (!brewery) { onboardingPage(); return; }
  const { data: operators, error: operatorError } = await supabase.from("operators").select("id, name, is_active").order("created_at");
  if (operatorError) { operatorUnlockPage(`Neizdevās ielādēt operatorus: ${operatorError.message}`); return; }
  state.operators = operators || [];
  const rememberedOperator = sessionStorage.getItem("brewtracker-operator-id");
  if (rememberedOperator && state.operators.some((operator) => operator.id === rememberedOperator)) {
    state.activeOperatorId = rememberedOperator;
  }
  operatorUnlocked = false;
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
  state.activeOperatorId = result.operator_id;
  operatorUnlocked = true;
  sessionStorage.setItem("brewtracker-operator-id", result.operator_id);
  state = await saveState(state);
  render();
}

async function submitOperatorUnlock(form) {
  const data = Object.fromEntries(new FormData(form));
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true; button.textContent = "Pārbauda…";
  const { data: valid, error } = await supabase.rpc("verify_operator", { operator_id: data.operatorId, operator_pin: data.pin });
  if (error || !valid) { operatorUnlockPage(error ? `PIN pārbaudes kļūda: ${error.message}` : "Nepareizs PIN kods."); return; }
  state.activeOperatorId = data.operatorId;
  operatorUnlocked = true;
  sessionStorage.setItem("brewtracker-operator-id", data.operatorId);
  state = await saveState(state);
  render();
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
function currentOperator() { return state.operators.find((operator) => operator.id === state.activeOperatorId) || state.operators[0]; }
function today() { return new Date().toISOString().slice(0, 10); }
function formatDate(value) { return new Intl.DateTimeFormat("lv-LV", { day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(`${value.slice(0, 10)}T00:00:00`)); }

function shell(content, title = "BrewTracker") {
  app.innerHTML = `<div class="app-shell"><header class="topbar"><button class="brand" data-route="dashboard"><span class="brand-mark">BT</span><span>${title}</span></button><div class="network ${navigator.onLine ? "online" : "offline"}">${navigator.onLine ? "Tiešsaistē" : "Bezsaistē"}</div><button class="operator" data-action="operators">${icon("UserRound", 18)} ${currentOperator()?.name || "Operators"}</button></header>${content}<nav class="bottom-nav"><button data-route="dashboard" class="${route === "dashboard" ? "active" : ""}">${icon("LayoutDashboard")}<span>Tvertnes</span></button><button data-route="history" class="${route === "history" ? "active" : ""}">${icon("History")}<span>Vēsture</span></button><button data-route="settings" class="${route === "settings" ? "active" : ""}">${icon("Settings")}<span>Iestatījumi</span></button></nav></div>`;
}

function dashboard() {
  const batches = activeBatches();
  shell(`<main><section class="page-heading"><div><p class="eyebrow">Fermentācijas pārskats</p><h1>Kas jādara šodien?</h1></div><button class="primary" data-action="new-batch">${icon("Plus")} Jauna partija</button></section><section class="summary"><article><strong>${batches.length}</strong><span>aktīvas partijas</span></article><article><strong>${13 - batches.length}</strong><span>brīvas tvertnes</span></article><article><strong>${batches.filter((batch) => getRecommendedAction(batch).tone === "urgent").length}</strong><span>steidzamas darbības</span></article></section><section class="tank-grid">${Array.from({ length: 13 }, (_, index) => tankCard(index + 1)).join("")}</section></main>`, "BrewTracker Pro");
}

function tankCard(number) {
  const batch = activeBatches().find((item) => item.fermenterNumber === number);
  if (!batch) return `<article class="tank-card empty"><div class="tank-number">${number}</div><div><h2>Brīva tvertne</h2><p>Gatava jaunai partijai</p></div><button data-action="new-batch" data-tank="${number}">${icon("Plus")}</button></article>`;
  const beer = state.beerTypes.find((item) => item.id === batch.beerTypeId);
  const latest = batch.measurements.at(-1);
  const recommendation = getRecommendedAction(batch);
  return `<article class="tank-card occupied" data-open-batch="${batch.id}"><div class="tank-number">${number}</div><div class="tank-main"><div class="card-top"><span class="batch-no">#${batch.batchNumber}</span><span class="days">${Math.max(0, Math.floor((Date.now() - new Date(batch.brewDate)) / 86400000))}. diena</span></div><h2>${beer?.name || "Nezināms alus"} <small>${batch.volumeTons} t</small></h2><p>${latest ? `Blīvums ${latest.gravity} · pH ${latest.ph} · ${latest.temperature} °C` : "Vēl nav mērījumu"}</p><div class="recommendation ${recommendation.tone}">${icon(recommendation.tone === "urgent" ? "TriangleAlert" : "CircleCheck", 18)} ${recommendation.label}</div></div>${icon("ChevronRight")}</article>`;
}

function newBatchForm(tank = "") {
  const currentYear = new Date().getFullYear();
  const existingThisYear = state.batches.filter((batch) => batch.year === currentYear);
  const nextSequence = existingThisYear.length ? Math.max(...existingThisYear.map((batch) => batch.sequence)) + 1 : 1;
  shell(`<main class="narrow"><button class="text-button" data-route="dashboard">${icon("ArrowLeft")} Atpakaļ</button><section class="page-heading"><div><p class="eyebrow">Jauna fermentācija</p><h1>Izveidot partiju</h1></div></section><form id="batch-form" class="form-card"><div class="field full"><label>Alus nosaukums</label><input name="beerName" list="beer-types" required autocomplete="off"><datalist id="beer-types">${state.beerTypes.map((beer) => `<option value="${beer.name}">`).join("")}</datalist><small>Esošam nosaukumam tiks izmantoti saglabātie sliekšņi.</small></div><div class="field"><label>Tilpums, tonnas</label><input name="volumeTons" type="number" min="0.1" step="0.1" required></div><div class="field"><label>Vārīšanas datums</label><input name="brewDate" type="date" value="${today()}" required></div><div class="field"><label>Kārtas numurs gadā</label><input name="sequence" type="number" min="1" max="999" value="${nextSequence}" required></div><div class="field"><label>Tvertne</label><select name="fermenterNumber" required><option value="">Izvēlies</option>${Array.from({ length: 13 }, (_, i) => i + 1).map((number) => `<option value="${number}" ${String(number) === String(tank) ? "selected" : ""} ${activeBatches().some((batch) => batch.fermenterNumber === number) ? "disabled" : ""}>Tvertne ${number}${activeBatches().some((batch) => batch.fermenterNumber === number) ? " — aizņemta" : ""}</option>`).join("")}</select></div><hr><h2 class="full">Procesa sliekšņi</h2><div class="field"><label>Sākotnējais blīvums (OG)</label><input name="ogTarget" inputmode="numeric" placeholder="1056" required></div><div class="field"><label>Gala blīvums (FG)</label><input name="fgTarget" inputmode="numeric" placeholder="1012" required></div><div class="field"><label>Vārstu aizgriezt pie</label><input name="spundGravity" inputmode="numeric" placeholder="1026" required></div><div class="field"><label>Dzesēt uz 0 °C pie</label><input name="coolingGravity" inputmode="numeric" placeholder="1018" required></div><label class="check full"><input name="hasDryHop" type="checkbox"><span>Šim alum ir Dry Hop</span></label><div class="field" id="dry-hop-field" hidden><label>Dry Hop pie blīvuma</label><input name="dryHopGravity" inputmode="numeric" placeholder="1022"></div><div class="field"><label>Mērķa CO₂, vol</label><input name="co2Target" type="number" min="1" max="4" step="0.1" value="2.4" required></div><div class="form-error full" id="form-error"></div><button class="primary full" type="submit">Izveidot partiju</button></form></main>`, "Jauna partija");
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
    const batchNumber = formatBatchNumber(year, sequence, fermenterNumber);
    if (state.batches.some((batch) => batch.batchNumber === batchNumber)) throw new Error(`Partija ${batchNumber} jau eksistē.`);
    if (activeBatches().some((batch) => batch.fermenterNumber === fermenterNumber)) throw new Error(`Tvertne ${fermenterNumber} jau ir aizņemta.`);
    let beer = state.beerTypes.find((item) => item.name.toLocaleLowerCase("lv") === data.beerName.trim().toLocaleLowerCase("lv"));
    const targets = { ogTarget: validateGravity(data.ogTarget), fgTarget: validateGravity(data.fgTarget), spundGravity: validateGravity(data.spundGravity), coolingGravity: validateGravity(data.coolingGravity), hasDryHop: data.hasDryHop === "on", dryHopGravity: data.hasDryHop === "on" ? validateGravity(data.dryHopGravity) : null, co2Target: Number(data.co2Target) };
    if (!beer) { beer = { id: crypto.randomUUID(), name: data.beerName.trim(), ...targets }; state.beerTypes.push(beer); }
    else Object.assign(beer, targets);
    const batch = { id: crypto.randomUUID(), batchNumber, year, sequence, fermenterNumber, beerTypeId: beer.id, volumeTons: Number(data.volumeTons), brewDate: data.brewDate, status: BATCH_STATUS.ACTIVE, ...targets, measurements: [], actions: [], createdAt: new Date().toISOString(), createdBy: currentOperator().id };
    state.batches.push(batch);
    state = await saveState(state, { entity: "batch", operation: "create", entityId: batch.id });
    selectedBatchId = batch.id; route = "batch"; render();
  } catch (error) { document.querySelector("#form-error").textContent = error.message; }
}

function batchDetail() {
  const batch = state.batches.find((item) => item.id === selectedBatchId);
  if (!batch) { route = "dashboard"; return dashboard(); }
  const beer = state.beerTypes.find((item) => item.id === batch.beerTypeId);
  const recommendation = getRecommendedAction(batch);
  const stats = calculateHistoryStats(state.batches, batch.beerTypeId);
  shell(`<main class="narrow"><button class="text-button" data-route="dashboard">${icon("ArrowLeft")} Visas tvertnes</button><section class="batch-hero"><div><span class="batch-no">#${batch.batchNumber} · Tvertne ${batch.fermenterNumber}</span><h1>${beer.name} <small>${batch.volumeTons} t</small></h1><p>Sākts ${formatDate(batch.brewDate)}</p></div><span class="status">${batch.status === BATCH_STATUS.FINISHED ? "Pabeigts" : "Aktīvs"}</span></section><section class="action-banner ${recommendation.tone}"><div>${icon("Sparkles", 24)}<span><small>Ieteicamā darbība</small><strong>${recommendation.label}</strong></span></div></section>${predictionPanel(batch, stats)}<section class="detail-grid"><article class="panel"><div class="panel-title"><h2>Jauns mērījums</h2><span>Var saglabāt bez interneta</span></div><form id="measurement-form" class="measurement-form"><div class="field"><label>Blīvums</label><input name="gravity" inputmode="numeric" placeholder="1054" required></div><div class="field"><label>pH</label><input name="ph" type="number" min="0" max="14" step="0.01" placeholder="4.20" required></div><div class="field"><label>Temperatūra °C</label><input name="temperature" type="number" min="-5" max="50" step="0.1" placeholder="19.5" required></div><div class="field"><label>Spiediens bar</label><input name="pressure" type="number" min="0" max="5" step="0.01" placeholder="0.80"></div><div class="field full"><label>Piezīme</label><input name="note" placeholder="Neobligāta piezīme"></div><div class="form-error full" id="measurement-error"></div><button class="primary full">${icon("Save")} Saglabāt mērījumu</button></form></article><article class="panel"><div class="panel-title"><h2>Darbības</h2></div><div class="action-list">${[ACTION_TYPES.SPUND, ...(batch.hasDryHop ? [ACTION_TYPES.DRY_HOP] : []), ACTION_TYPES.COOL, ACTION_TYPES.FINISH].map((type) => actionButton(batch, type)).join("")}</div></article></section><section class="panel"><div class="panel-title"><h2>Mērījumu vēsture</h2><span>${batch.measurements.length} ieraksti</span></div>${measurementTable(batch)}</section></main>`, beer.name);
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
  return `<div class="table-wrap"><table><thead><tr><th>Laiks</th><th>Blīvums</th><th>pH</th><th>°C</th><th>bar</th><th>Operators</th></tr></thead><tbody>${[...batch.measurements].reverse().map((item) => `<tr><td>${new Date(item.measuredAt).toLocaleString("lv-LV", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</td><td><strong>${item.gravity}</strong></td><td>${item.ph}</td><td>${item.temperature}</td><td>${item.pressure ?? "—"}</td><td>${state.operators.find((op) => op.id === item.operatorId)?.name || "—"}</td></tr>`).join("")}</tbody></table></div>`;
}

async function submitMeasurement(form) {
  try {
    const data = Object.fromEntries(new FormData(form));
    const batch = state.batches.find((item) => item.id === selectedBatchId);
    const measurement = { id: crypto.randomUUID(), measuredAt: new Date().toISOString(), gravity: validateGravity(data.gravity), ph: validatePh(data.ph), temperature: validateTemperature(data.temperature), pressure: validatePressure(data.pressure), note: data.note.trim(), operatorId: currentOperator().id };
    batch.measurements.push(measurement);
    state = await saveState(state, { entity: "measurement", operation: "create", entityId: measurement.id });
    render();
  } catch (error) { document.querySelector("#measurement-error").textContent = error.message; }
}

function actionDialog(type) {
  const batch = state.batches.find((item) => item.id === selectedBatchId);
  const latest = batch.measurements.at(-1);
  const dialog = document.createElement("dialog");
  dialog.innerHTML = `<form method="dialog" id="action-form" class="dialog-card"><button class="dialog-close" value="cancel">${icon("X")}</button><p class="eyebrow">Procesa darbība</p><h2>${ACTION_LABELS[type]}</h2><p>Fiksē mērījumus darbības izpildes brīdī.</p><div class="measurement-form"><div class="field"><label>Blīvums</label><input name="gravity" value="${latest?.gravity ?? ""}" required></div><div class="field"><label>pH</label><input name="ph" type="number" step="0.01" value="${latest?.ph ?? ""}" required></div><div class="field"><label>Temperatūra °C</label><input name="temperature" type="number" step="0.1" value="${latest?.temperature ?? ""}" required></div><div class="field"><label>Spiediens bar</label><input name="pressure" type="number" step="0.01" value="${latest?.pressure ?? ""}"></div><div class="form-error full" id="action-error"></div><button class="primary full" value="default">Apstiprināt darbību</button></div></form>`;
  document.body.append(dialog); dialog.showModal();
  dialog.addEventListener("close", async () => { if (dialog.returnValue === "default") await completeAction(type, dialog.querySelector("form")); dialog.remove(); });
}

async function completeAction(type, form) {
  try {
    const data = Object.fromEntries(new FormData(form));
    const batch = state.batches.find((item) => item.id === selectedBatchId);
    const action = { id: crypto.randomUUID(), type, performedAt: new Date().toISOString(), gravity: validateGravity(data.gravity), ph: validatePh(data.ph), temperature: validateTemperature(data.temperature), pressure: validatePressure(data.pressure), operatorId: currentOperator().id };
    batch.actions = batch.actions.filter((item) => item.type !== type); batch.actions.push(action);
    if (type === ACTION_TYPES.DRY_HOP) batch.status = BATCH_STATUS.DRY_HOP;
    if (type === ACTION_TYPES.COOL) batch.status = BATCH_STATUS.COOLING;
    if (type === ACTION_TYPES.FINISH) batch.status = BATCH_STATUS.FINISHED;
    batch.measurements.push({ id: crypto.randomUUID(), measuredAt: action.performedAt, gravity: action.gravity, ph: action.ph, temperature: action.temperature, pressure: action.pressure, note: ACTION_LABELS[type], operatorId: action.operatorId });
    state = await saveState(state, { entity: "action", operation: "create", entityId: action.id }); render();
  } catch (error) { alert(error.message); }
}

function historyPage() {
  const finished = state.batches.filter((batch) => batch.status === BATCH_STATUS.FINISHED).reverse();
  shell(`<main><section class="page-heading"><div><p class="eyebrow">Pabeigtās partijas</p><h1>Vēsture</h1></div></section><section class="history-list">${finished.length ? finished.map((batch) => { const beer = state.beerTypes.find((item) => item.id === batch.beerTypeId); return `<button class="history-row" data-open-batch="${batch.id}"><span class="tank-number">${batch.fermenterNumber}</span><span><strong>${beer.name} · ${batch.volumeTons} t</strong><small>#${batch.batchNumber} · ${formatDate(batch.brewDate)} · ${batch.measurements.length} mērījumi</small></span>${icon("ChevronRight")}</button>`; }).join("") : `<div class="empty-state">${icon("History", 38)}<h2>Vēsture vēl ir tukša</h2><p>Pabeigtās partijas būs redzamas šeit.</p></div>`}</section></main>`, "Vēsture");
}

function settingsPage() {
  shell(`<main class="narrow"><section class="page-heading"><div><p class="eyebrow">Konfigurācija</p><h1>Iestatījumi</h1></div></section><section class="panel"><div class="panel-title"><h2>Operatori</h2><span>PIN autentifikācija tiks pieslēgta ar Supabase</span></div><div class="operator-list">${state.operators.map((operator) => `<label class="operator-row"><input type="radio" name="operator" value="${operator.id}" ${operator.id === state.activeOperatorId ? "checked" : ""}><span class="avatar" style="--avatar:${operator.color}">${operator.name.slice(0, 1).toUpperCase()}</span><strong>${operator.name}</strong></label>`).join("")}<form id="operator-form" class="inline-form"><input name="name" placeholder="Jauna operatora vārds" required><button class="secondary">${icon("UserPlus")} Pievienot</button></form></div></section><section class="panel notice"><h2>${icon(isSupabaseConfigured ? "CloudCog" : "CloudOff")} ${isSupabaseConfigured ? "Supabase pieslēgums konfigurēts" : "Lokālais režīms"}</h2><p>${isSupabaseConfigured ? "Projekta URL un publiskā atslēga ir iestatīti. Līdz datubāzes migrācijas un autorizācijas aktivizēšanai dati turpina droši glabāties šajā ierīcē." : "Dati droši glabājas šajā ierīcē ar IndexedDB. Pievieno Supabase projekta URL un publisko atslēgu, lai aktivizētu kopīgo datubāzi."}</p><strong>${state.pendingSync.length} ieraksti gaida sinhronizāciju</strong></section></main>`, "Iestatījumi");
}

function operatorDialog() { route = "settings"; render(); }

function render() {
  if (route === "dashboard") dashboard();
  else if (route === "new-batch") newBatchForm();
  else if (route === "batch") batchDetail();
  else if (route === "history") historyPage();
  else settingsPage();
}

document.addEventListener("click", (event) => {
  if (event.target.closest("[data-auth-logout]")) { sessionStorage.removeItem("brewtracker-operator-id"); supabase.auth.signOut(); return; }
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
  if (event.target.closest('[data-action="operators"]')) operatorDialog();
});

document.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (event.target.id === "auth-form") { await submitAuth(event.target); return; }
  if (event.target.id === "onboarding-form") { await submitOnboarding(event.target); return; }
  if (event.target.id === "operator-unlock-form") { await submitOperatorUnlock(event.target); return; }
  if (event.target.id === "batch-form") await submitBatch(event.target);
  if (event.target.id === "measurement-form") await submitMeasurement(event.target);
  if (event.target.id === "operator-form") {
    const name = new FormData(event.target).get("name").trim();
    const operator = { id: crypto.randomUUID(), name, color: `hsl(${Math.random() * 360} 65% 48%)` };
    state.operators.push(operator); state.activeOperatorId = operator.id; state = await saveState(state); render();
  }
});

document.addEventListener("change", async (event) => {
  if (event.target.name === "operator") { state.activeOperatorId = event.target.value; state = await saveState(state); render(); }
});

window.addEventListener("online", render);
window.addEventListener("offline", render);

async function initializeApp() {
  if (!isSupabaseConfigured) { render(); return; }
  const { data, error } = await supabase.auth.getSession();
  if (error) { authPage("Neizdevās pārbaudīt sesiju. Pārbaudi interneta savienojumu.", true); return; }
  authSession = data.session;
  if (authSession) await loadWorkspace(); else authPage();
  supabase.auth.onAuthStateChange((_event, session) => {
    authSession = session;
    if (!session) authPage();
  });
}

initializeApp();
