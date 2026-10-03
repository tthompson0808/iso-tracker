const DB_NAME = "iso-tracker";
const VERSION = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
      if (!db.objectStoreNames.contains("exercises")) db.createObjectStore("exercises", { keyPath: "id" });
      if (!db.objectStoreNames.contains("sessions")) db.createObjectStore("sessions", { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("storage failed"));
    tx.onabort = () => reject(tx.error || new Error("storage aborted"));
  });
}

function req(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function loadAll() {
  const db = await openDb();
  const tx = db.transaction(["kv", "exercises", "sessions"], "readonly");
  const finished = done(tx);
  const [settings, exercises, sessions] = await Promise.all([
    req(tx.objectStore("kv").get("settings")),
    req(tx.objectStore("exercises").getAll()),
    req(tx.objectStore("sessions").getAll()),
  ]);
  await finished;
  return {
    settings: settings || null,
    exercises: exercises || [],
    sessions: sessions || [],
  };
}

export async function saveSettings(settings) {
  const db = await openDb();
  const tx = db.transaction("kv", "readwrite");
  tx.objectStore("kv").put(settings, "settings");
  await done(tx);
}

export async function saveExercises(exercises) {
  const db = await openDb();
  const tx = db.transaction("exercises", "readwrite");
  const store = tx.objectStore("exercises");
  store.clear();
  for (const ex of exercises) store.put(ex);
  await done(tx);
}

export async function saveSession(session) {
  const db = await openDb();
  const tx = db.transaction("sessions", "readwrite");
  tx.objectStore("sessions").put(session);
  await done(tx);
}

export async function deleteSession(id) {
  const db = await openDb();
  const tx = db.transaction("sessions", "readwrite");
  tx.objectStore("sessions").delete(id);
  await done(tx);
}

export async function replaceAll(data) {
  const db = await openDb();
  const tx = db.transaction(["kv", "exercises", "sessions"], "readwrite");
  tx.objectStore("kv").clear();
  tx.objectStore("exercises").clear();
  tx.objectStore("sessions").clear();
  tx.objectStore("kv").put(data.settings, "settings");
  for (const ex of data.exercises) tx.objectStore("exercises").put(ex);
  for (const s of data.sessions) tx.objectStore("sessions").put(s);
  await done(tx);
}
