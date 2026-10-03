/** Wall-clock helpers. Hold timing uses Date.now(), never interval ticks. */

export function round1(n) {
  return Math.round(n * 10) / 10;
}

export function floorTenths(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return 0;
  return Math.floor(sec * 10 + 1e-6);
}

export function splitClock(tenths) {
  const t = Math.max(0, tenths | 0);
  const m = Math.floor(t / 600);
  const rem = t % 600;
  const s = Math.floor(rem / 10);
  const d = rem % 10;
  const main = m > 0 ? `${m}:${String(s).padStart(2, "0")}` : String(s);
  return { main, tenth: String(d) };
}

export function formatSeconds(sec) {
  if (sec == null || Number.isNaN(sec)) return "Skipped";
  const tenths = Math.round(Math.abs(sec) * 10);
  const { main, tenth } = splitClock(tenths);
  return `${sec < 0 ? "-" : ""}${main}.${tenth}`;
}

export function formatClockMs(ms, { countdown = false, limitMs = null } = {}) {
  const elapsed = Math.max(0, ms);
  const shown = countdown && limitMs != null ? Math.max(0, limitMs - elapsed) : elapsed;
  return splitClock(Math.floor(shown / 100));
}

export function sessionDay(startedAt, now = new Date()) {
  const d = new Date(startedAt);
  void now;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Hold time with its unit: "30.0 s" under a minute, "1:25.4" after. */
export function formatHold(sec) {
  if (sec == null || Number.isNaN(sec)) return "Skipped";
  return sec >= 60 ? formatSeconds(sec) : `${formatSeconds(sec)} s`;
}

export function formatDay(ts) {
  return new Date(ts).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/** Includes the time so two sessions on one day read differently. */
export function formatWhen(ts) {
  const time = new Date(ts).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `${formatDay(ts)} · ${time}`;
}

/** Holds shorter than this are accidental taps, not holds. */
export const MIN_HOLD_SEC = 1;

export function weekStartMonday(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  const mondayOffset = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - mondayOffset);
  return d.getTime();
}

export function uid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `id-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}
