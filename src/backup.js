const ARCHIVE_FORMAT = "brewtracker-pro-backup";
export const BACKUP_SCHEMA_VERSION = 1;

export const EXPORT_TABLES = Object.freeze([
  "beer_types", "fermenters", "operators", "batches", "measurements",
  "process_actions", "packaging_runs", "work_items", "work_item_events",
  "vessel_cleaning_cycles", "vessel_cleaning_events", "volume_events",
  "batch_carbonation_advisories", "audit_log",
]);

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(typeof value === "string" ? value : canonicalJson(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function rigaExportTime(value = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Riga", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(value).replace(" ", "T");
}

export async function createBackupArchive({ brewery, entities, exportedAt = new Date() }) {
  const safeEntities = Object.fromEntries(EXPORT_TABLES.map((table) => [table, entities[table] || []]));
  const payload = {
    format: ARCHIVE_FORMAT,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    timezone: "Europe/Riga",
    exportedAt: rigaExportTime(exportedAt),
    brewery: { id: brewery.id, name: brewery.name, createdAt: brewery.created_at || brewery.createdAt || null },
    entities: safeEntities,
  };
  const checksum = await sha256Hex(payload);
  return {
    ...payload,
    manifest: {
      format: ARCHIVE_FORMAT,
      schemaVersion: BACKUP_SCHEMA_VERSION,
      checksumAlgorithm: "SHA-256",
      payloadChecksum: checksum,
      rowCounts: Object.fromEntries(EXPORT_TABLES.map((table) => [table, safeEntities[table].length])),
      excluded: ["operator_sessions", "operator_auth_attempts", "push_subscriptions", "pin_hash", "auth tokens"],
    },
  };
}

export function archivePayload(archive) {
  const { manifest: _manifest, ...payload } = archive || {};
  return payload;
}

export async function validateBackupArchive(archive, currentBreweryId = null) {
  const problems = [];
  if (!archive || archive.format !== ARCHIVE_FORMAT) problems.push("Fails nav BrewTracker Pro rezerves kopija.");
  if (archive?.schemaVersion !== BACKUP_SCHEMA_VERSION) problems.push("Rezerves kopijas versija šai aplikācijas versijai nav savietojama.");
  if (!archive?.manifest?.payloadChecksum) problems.push("Fails nesatur pārbaudes manifestu.");
  if (!archive?.entities || typeof archive.entities !== "object") problems.push("Rezerves kopijā nav datu sadaļas.");
  for (const table of EXPORT_TABLES) if (!Array.isArray(archive?.entities?.[table])) problems.push(`Trūkst tabulas: ${table}.`);
  if (!problems.length) {
    const checksum = await sha256Hex(archivePayload(archive));
    if (checksum !== archive.manifest.payloadChecksum) problems.push("SHA-256 pārbaude neizdevās — fails ir bojāts vai mainīts.");
  }
  const foreignBrewery = Boolean(currentBreweryId && archive?.brewery?.id && archive.brewery.id !== currentBreweryId);
  const rowCounts = Object.fromEntries(EXPORT_TABLES.map((table) => [table, Array.isArray(archive?.entities?.[table]) ? archive.entities[table].length : 0]));
  return { valid: problems.length === 0, problems, foreignBrewery, rowCounts, checksum: archive?.manifest?.payloadChecksum || null };
}

export function toCsv(rows) {
  const source = Array.isArray(rows) ? rows : [];
  const columns = [...new Set(source.flatMap((row) => Object.keys(row || {})))];
  const cell = (value) => {
    const text = value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
    return `"${text.replaceAll('"', '""')}"`;
  };
  return [columns.map(cell).join(","), ...source.map((row) => columns.map((key) => cell(row[key])).join(","))].join("\r\n");
}

export function downloadText(filename, text, type = "application/json") {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
