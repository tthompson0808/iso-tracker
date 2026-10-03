import { round1, weekStartMonday } from "./time.js";

function sideKey(side) {
  return side || "none";
}

function savedChoice(session, exerciseId) {
  const value = session.decisions?.[exerciseId];
  return value === "accept" || value === "reject" ? value : null;
}

export function proposalsFor(session, exercises, earlierSessions) {
  const proposals = [];
  const byId = new Map(exercises.map((ex) => [ex.id, ex]));
  const groups = new Map();
  for (const h of session.holds) {
    if (!groups.has(h.exerciseId)) groups.set(h.exerciseId, []);
    groups.get(h.exerciseId).push(h);
  }
  for (const [exerciseId, holds] of groups) {
    const ex = byId.get(exerciseId);
    if (!ex || ex.archived) continue;
    const modes = new Set(holds.map((h) => h.mode));
    if (modes.size !== 1 || !modes.has("target")) continue;
    const expected = session.totalRounds * (ex.unilateral ? 2 : 1);
    const allHit = holds.length === expected && holds.every((h) => h.status === "completed");
    const failedThis = holds.some((h) => h.status === "failed_early");
    if (allHit) {
      const delta = ex.incrementSec || 5;
      proposals.push({
        exerciseId,
        name: ex.name,
        type: "raise",
        from: ex.targetSec,
        to: ex.targetSec + delta,
        choice: savedChoice(session, exerciseId),
      });
      continue;
    }
    if (!failedThis) continue;
    const prev = earlierSessions
      .filter((s) => s.id !== session.id && s.startedAt < session.startedAt && s.holds?.some((h) => h.exerciseId === exerciseId))
      .sort((a, b) => b.startedAt - a.startedAt)[0];
    if (!prev) continue;
    const failedPrev = prev.holds.some((h) => h.exerciseId === exerciseId && h.status === "failed_early");
    if (!failedPrev) continue;
    proposals.push({
      exerciseId,
      name: ex.name,
      type: "drop",
      from: ex.targetSec,
      to: Math.max(5, ex.targetSec - 5),
      choice: session.decisions?.[exerciseId]?.choice || null,
    });
  }
  return proposals;
}

export function applyAccepted(exercises, proposals) {
  const accepted = new Map(proposals.filter((p) => p.choice === "accept").map((p) => [p.exerciseId, p]));
  return exercises.map((ex) => {
    const p = accepted.get(ex.id);
    if (!p) return ex;
    return { ...ex, targetSec: p.to };
  });
}

export function previousCompleted(sessions, current) {
  return sessions
    .filter((s) => s.id !== current.id && s.status === "completed" && s.startedAt <= current.startedAt)
    .sort((a, b) => b.startedAt - a.startedAt)[0] || null;
}

export function matchHold(session, hold) {
  if (!session) return null;
  return session.holds.find(
    (h) => h.exerciseId === hold.exerciseId && h.round === hold.round && (h.side || null) === (hold.side || null) && h.status !== "skipped",
  ) || null;
}

export function isRecord(hold, sessions) {
  if (hold.status === "skipped" || hold.actualSec == null) return false;
  let best = null;
  for (const s of sessions) {
    for (const h of s.holds || []) {
      if (h.id === hold.id) continue;
      if (h.exerciseId !== hold.exerciseId) continue;
      if ((h.side || null) !== (hold.side || null)) continue;
      if (h.status === "skipped" || h.actualSec == null) continue;
      const earlier = (h.loggedAt ?? s.startedAt) < (hold.loggedAt ?? hold.sessionStartedAt);
      if (!earlier) continue;
      if (best == null || h.actualSec > best) best = h.actualSec;
    }
  }
  return best == null || hold.actualSec > best;
}

export function removeExercise(exercises, sessions, id) {
  const used = sessions.some((s) => (s.holds || []).some((h) => h.exerciseId === id));
  if (used) {
    return exercises.map((ex) => (ex.id === id ? { ...ex, archived: true, enabled: false } : ex));
  }
  return exercises.filter((ex) => ex.id !== id);
}

export function records(exercises, sessions) {
  const rows = [];
  for (const ex of exercises) {
    const sides = ex.unilateral ? ["L", "R"] : [null];
    for (const side of sides) {
      let best = null;
      let at = null;
      for (const s of sessions) {
        for (const h of s.holds || []) {
          if (h.exerciseId !== ex.id) continue;
          if ((h.side || null) !== side) continue;
          if (h.status === "skipped" || h.actualSec == null) continue;
          if (best == null || h.actualSec > best) {
            best = h.actualSec;
            at = s.startedAt;
          }
        }
      }
      rows.push({ exerciseId: ex.id, name: ex.name, side, best, at, archived: ex.archived });
    }
  }
  return rows;
}

export function chartSeries(exercise, sessions) {
  const finished = sessions
    .filter((s) => s.status === "completed" || s.holds?.length)
    .slice()
    .sort((a, b) => a.startedAt - b.startedAt);
  const sides = exercise.unilateral ? ["L", "R"] : ["none"];
  const lines = {};
  for (const side of sides) lines[side] = [];
  for (const s of finished) {
    const holds = (s.holds || []).filter((h) => h.exerciseId === exercise.id && h.status !== "skipped" && h.actualSec != null);
    if (!holds.length) continue;
    for (const side of sides) {
      const mine = holds.filter((h) => sideKey(h.side) === side);
      if (!mine.length) continue;
      const best = mine.reduce((m, h) => (h.actualSec > m.actualSec ? h : m));
      const failed = mine.some((h) => h.mode !== "max" && h.status === "failed_early") || (best.mode === "target" && best.status !== "completed");
      lines[side].push({
        at: s.startedAt,
        seconds: best.actualSec,
        target: best.targetSec,
        failed,
        mode: best.mode,
      });
    }
  }
  return lines;
}

export function maxSummary(holds, exerciseId) {
  const mine = holds.filter((h) => h.exerciseId === exerciseId && h.mode === "max" && h.status !== "skipped" && h.actualSec != null);
  if (!mine.length) return null;
  const sides = [...new Set(mine.map((h) => h.side || null))];
  return sides.map((side) => {
    const list = mine.filter((h) => (h.side || null) === side);
    const best = Math.max(...list.map((h) => h.actualSec));
    const lastRound = Math.max(...list.map((h) => h.round));
    const last = list.find((h) => h.round === lastRound)?.actualSec ?? null;
    const avg = round1(list.reduce((sum, h) => sum + h.actualSec, 0) / list.length);
    return { side, best, last, avg };
  });
}

export function weeks(sessions, now, count = 8) {
  const start = weekStartMonday(now);
  const buckets = [];
  for (let i = count - 1; i >= 0; i--) {
    const t = start - i * 7 * 24 * 60 * 60 * 1000;
    buckets.push({ start: t, count: 0 });
  }
  for (const s of sessions) {
    if (!s.startedAt || s.status === "abandoned") continue;
    if (!s.holds?.length && s.status !== "completed") continue;
    const w = weekStartMonday(s.startedAt);
    const bucket = buckets.find((b) => b.start === w);
    if (bucket) bucket.count += 1;
  }
  return buckets;
}

export function needsExportReminder(settings, sessions, now) {
  const real = sessions.filter((s) => s.holds?.length);
  if (!real.length) return false;
  const oldest = Math.min(...real.map((s) => s.startedAt));
  if (settings.lastExportAt == null) return now - oldest >= 14 * 24 * 60 * 60 * 1000;
  return now - settings.lastExportAt >= 14 * 24 * 60 * 60 * 1000;
}

export function sessionHeadline(session) {
  const holds = session.holds?.length || 0;
  const skipped = (session.holds || []).filter((h) => h.status === "skipped").length;
  return { holds, skipped };
}
