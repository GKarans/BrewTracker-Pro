import { openDB } from "idb";

const DB_NAME = "brewtracker-pro";
const STORE_NAME = "app-state";
const STATE_KEY = "current";

const defaultState = {
  operators: [
    { id: crypto.randomUUID(), name: "Operators", color: "#f3a712" },
  ],
  activeOperatorId: null,
  beerTypes: [],
  fermenters: [],
  batches: [],
  pendingSync: [],
};

async function database() {
  return openDB(DB_NAME, 1, {
    upgrade(db) {
      db.createObjectStore(STORE_NAME);
    },
  });
}

export async function loadState() {
  const db = await database();
  const stored = await db.get(STORE_NAME, STATE_KEY);
  if (stored) return stored;
  const initial = structuredClone(defaultState);
  initial.activeOperatorId = initial.operators[0].id;
  await db.put(STORE_NAME, initial, STATE_KEY);
  return initial;
}

export async function saveState(state, syncEvent = null) {
  const db = await database();
  const next = structuredClone(state);
  if (syncEvent) {
    next.pendingSync.push({ id: crypto.randomUUID(), createdAt: new Date().toISOString(), ...syncEvent });
  }
  await db.put(STORE_NAME, next, STATE_KEY);
  return next;
}

export async function clearLocalData() {
  const db = await database();
  await db.delete(STORE_NAME, STATE_KEY);
}
