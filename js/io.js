import { MIN_HOLD_SEC } from "./time.js";

const MAX_BYTES = 20 * 1024 * 1024;

function clip(value, max) {
  const s = String(value ?? "").slice(0, max);
  return s;
}

function cleanExercise(raw, index) {
  if (!raw || typeof raw !== "object") return null;
  const name = clip(raw.name, 80).trim();
  const id = clip(raw.id, 80).trim();
  if (!name || !id) return null;
  const cues = Array.isArray(raw.cues) ? raw.cues.map((c) => clip(c, 120).trim()).filter(Boolean).slice(0, 3) : [];
  return {
    id,
    name,
    cues,
    mode: raw.mode === "max" ? "max" : "target",
    targetSec: Math.max(1, Math.round(Number(raw.targetSec) || 20)),
    unilateral: !!raw.unilateral,
    incrementSec: Math.max(1, Math.round(Number(raw.incrementSec) || 5)),
    enabled: raw.enabled !== false,
    order: Number.isFinite(raw.order) ? raw.order : index,
    archived: !!raw.archived,
  };
}

function cleanHold(raw, session) {
  if (!raw || typeof raw !== "object") return null;
  const status = raw.status === "failed_early" || raw.status === "skipped" ? raw.status : "completed";
  const actual = raw.actualSec == null || raw.actualSec === "" ? null : Math.round(Number(raw.actualSec) * 10) / 10;
  if (status !== "skipped" && !Number.isFinite(actual)) return null;
  return {
    id: clip(raw.id, 80) || `${session.id}-${raw.round}-${raw.side || "x"}`,
    sessionId: session.id,
    sessionStartedAt: session.startedAt,
    exerciseId: clip(raw.exerciseId, 80),
    exerciseName: clip(raw.exerciseName, 80),
    round: Math.max(1, Math.round(Number(raw.round) || 1)),
    side: raw.side === "L" || raw.side === "R" ? raw.side : null,
    mode: raw.mode === "max" ? "max" : "target",
    targetSec: Math.max(0, Math.round(Number(raw.targetSec) || 0)),
    actualSec: status === "skipped" ? null : actual,
    status,
    adjustmentSec: Math.round((Number(raw.adjustmentSec) || 0) * 10) / 10,
    loggedAt: Number(raw.loggedAt) || session.startedAt,
  };
}

function cleanSession(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = clip(raw.id, 80).trim();
  const startedAt = Number(raw.startedAt);
  if (!id || !Number.isFinite(startedAt)) return null;
  const session = {
    id,
    startedAt,
    endedAt: raw.endedAt == null ? null : Number(raw.endedAt),
    status: raw.status === "completed" || raw.status === "abandoned" ? raw.status : "in_progress",
    note: clip(raw.note, 500),
    totalRounds: Math.max(1, Math.round(Number(raw.totalRounds) || 3)),
    steps: Array.isArray(raw.steps) ? raw.steps : [],
    index: Math.max(0, Math.round(Number(raw.index) || 0)),
    phase: typeof raw.phase === "string" ? raw.phase : "summary",
    phaseStartedAt: Number(raw.phaseStartedAt) || startedAt,
    pauseAccumMs: Math.max(0, Number(raw.pauseAccumMs) || 0),
    paused: !!raw.paused,
    pausedAt: raw.pausedAt == null ? null : Number(raw.pausedAt),
    restBonusSec: Math.max(0, Number(raw.restBonusSec) || 0),
    holds: [],
    decisions: raw.decisions && typeof raw.decisions === "object" ? raw.decisions : {},
    priors: raw.priors && typeof raw.priors === "object" ? raw.priors : {},
    maxFrozenSec: raw.maxFrozenSec == null ? null : Number(raw.maxFrozenSec),
  };
  session.holds = (Array.isArray(raw.holds) ? raw.holds : []).map((h) => cleanHold(h, session)).filter(Boolean);
  if (session.status === "in_progress" && !session.steps.length) session.status = "completed";
  return session;
}

export function exportPayload(settings, exercises, sessions, now) {
  return {
    app: "iso-tracker",
    version: 1,
    exportedAt: new Date(now).toISOString(),
    settings: { ...settings, lastExportAt: now },
    exercises,
    sessions,
  };
}

export function parseBackup(text) {
  if (typeof text !== "string" || text.length > MAX_BYTES) {
    return { ok: false, error: "That file is empty or too large." };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "That file is not valid JSON." };
  }
  if (!raw || raw.version !== 1 || raw.app !== "iso-tracker") {
    return { ok: false, error: "This file is not an Iso Tracker backup." };
  }
  if (!Array.isArray(raw.exercises) || !Array.isArray(raw.sessions)) {
    return { ok: false, error: "The backup is missing exercises or sessions." };
  }
  const exercises = raw.exercises.map(cleanExercise).filter(Boolean);
  if (!exercises.length) return { ok: false, error: "The backup has no exercises." };
  const sessions = raw.sessions.map(cleanSession).filter(Boolean);
  const settings = {
    rounds: Math.min(10, Math.max(1, Math.round(Number(raw.settings?.rounds) || 3))),
    restSec: Math.min(300, Math.max(0, Math.round(Number(raw.settings?.restSec ?? 60)))),
    switchSec: Math.min(120, Math.max(0, Math.round(Number(raw.settings?.switchSec ?? 10)))),
    countdownSec: Math.min(30, Math.max(0, Math.round(Number(raw.settings?.countdownSec ?? 5)))),
    audioOn: raw.settings?.audioOn !== false,
    voiceOn: !!raw.settings?.voiceOn,
    volume: Math.min(1, Math.max(0, Number(raw.settings?.volume ?? 0.8))),
    lastExportAt: Number(raw.settings?.lastExportAt) || Date.parse(raw.exportedAt) || null,
  };
  return { ok: true, data: { settings, exercises, sessions } };
}

function csvCell(value) {
  const s = value == null ? "" : String(value);
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  if (/[",\n]/.test(safe)) return `"${safe.replaceAll('"', '""')}"`;
  return safe;
}

export function historyCsv(sessions) {
  const header = [
    "session_id",
    "started_at",
    "exercise_id",
    "exercise_name",
    "round",
    "side",
    "mode",
    "target_sec",
    "actual_sec",
    "status",
    "adjustment_sec",
  ];
  const lines = [header.join(",")];
  const ordered = sessions.slice().sort((a, b) => a.startedAt - b.startedAt);
  for (const s of ordered) {
    for (const h of s.holds || []) {
      lines.push(
        [
          s.id,
          new Date(s.startedAt).toISOString(),
          h.exerciseId,
          h.exerciseName,
          h.round,
          h.side || "",
          h.mode,
          h.targetSec,
          h.actualSec ?? "",
          h.status,
          h.adjustmentSec ?? 0,
        ].map(csvCell).join(","),
      );
    }
  }
  return lines.join("\n") + "\n";
}

export function setHoldActual(session, holdId, actualSec) {
  const h = session.holds.find((x) => x.id === holdId);
  if (!h || h.status === "skipped") return;
  const next = Math.round(Math.max(MIN_HOLD_SEC, actualSec) * 10) / 10;
  const raw = Math.round((h.actualSec - (h.adjustmentSec || 0)) * 10) / 10;
  h.actualSec = next;
  h.adjustmentSec = Math.round((next - raw) * 10) / 10;
}
