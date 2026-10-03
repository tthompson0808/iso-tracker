/** One live workout per origin. A dead tab's claim expires after 4s. */

const KEY = "iso-tracker-lock";
const STALE_MS = 4000;

export function createLock(storage, now, tabId) {
  function read() {
    try {
      const raw = storage.getItem(KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }
  function write(value) {
    if (value == null) storage.removeItem(KEY);
    else storage.setItem(KEY, JSON.stringify(value));
  }
  return {
    tabId,
    heldByOther() {
      const cur = read();
      if (!cur || cur.tab === tabId) return false;
      return now() - cur.at < STALE_MS;
    },
    claim() {
      const cur = read();
      if (cur && cur.tab !== tabId && now() - cur.at < STALE_MS) return false;
      write({ tab: tabId, at: now() });
      return true;
    },
    pulse() {
      const cur = read();
      if (cur && cur.tab !== tabId && now() - cur.at < STALE_MS) return false;
      write({ tab: tabId, at: now() });
      return true;
    },
    release() {
      const cur = read();
      if (cur && cur.tab === tabId) write(null);
    },
  };
}
