import { buildSteps } from "./plan.js";
import { MIN_HOLD_SEC, round1 } from "./time.js";

const GUARD_LIMIT = 400;

function priorKey(exerciseId, side, round) {
  return `${exerciseId}|${side || ""}|${round}`;
}

export function buildPriors(pastSessions, steps) {
  const priors = {};
  const ordered = pastSessions
    .filter((s) => s && s.holds?.length)
    .slice()
    .sort((a, b) => a.startedAt - b.startedAt);
  for (const step of steps) {
    if (step.kind !== "hold") continue;
    const key = priorKey(step.exerciseId, step.side, step.round);
    let last = null;
    let best = null;
    for (const sess of ordered) {
      for (const h of sess.holds) {
        if (h.exerciseId !== step.exerciseId) continue;
        if ((h.side || null) !== (step.side || null)) continue;
        if (h.status === "skipped" || h.actualSec == null) continue;
        if (best == null || h.actualSec > best) best = h.actualSec;
        if (h.round === step.round) last = h.actualSec;
      }
    }
    priors[key] = { last, best };
  }
  return priors;
}

export function livePrior(state, step) {
  const base = state.priors[priorKey(step.exerciseId, step.side, step.round)] || { last: null, best: null };
  let best = base.best;
  for (const h of state.holds) {
    if (h.exerciseId !== step.exerciseId) continue;
    if ((h.side || null) !== (step.side || null)) continue;
    if (h.status === "skipped" || h.actualSec == null) continue;
    if (best == null || h.actualSec > best) best = h.actualSec;
  }
  return { last: base.last, best };
}

export function createSession({ exercises, settings, pastSessions = [], now, id }) {
  const steps = buildSteps(exercises, settings.rounds);
  const state = {
    id: id(),
    startedAt: now,
    endedAt: null,
    status: "in_progress",
    note: "",
    totalRounds: Math.max(1, settings.rounds | 0),
    steps,
    index: 0,
    phase: steps.length ? "prehold" : "summary",
    phaseStartedAt: now,
    pauseAccumMs: 0,
    paused: false,
    pausedAt: null,
    restBonusSec: 0,
    holds: [],
    decisions: {},
    cueElapsedMs: 0,
    priors: buildPriors(pastSessions, steps),
    maxFrozenSec: null,
  };
  state.newId = id;
  return state;
}

export function serializeSession(state) {
  return {
    id: state.id,
    startedAt: state.startedAt,
    endedAt: state.endedAt,
    status: state.status,
    note: state.note,
    totalRounds: state.totalRounds,
    steps: state.steps.map((step) => ({ ...step, cues: step.cues?.slice() })),
    index: state.index,
    phase: state.phase,
    phaseStartedAt: state.phaseStartedAt,
    pauseAccumMs: state.pauseAccumMs,
    paused: state.paused,
    pausedAt: state.pausedAt,
    restBonusSec: state.restBonusSec,
    holds: state.holds.map((hold) => ({ ...hold })),
    decisions: { ...state.decisions },
    priors: structuredClone(state.priors),
    maxFrozenSec: state.maxFrozenSec,
  };
}

export function hydrateSession(saved, id) {
  return {
    ...saved,
    steps: saved.steps || [],
    holds: saved.holds || [],
    decisions: saved.decisions || {},
    priors: saved.priors || {},
    cueElapsedMs: 0,
    newId: id,
  };
}

/** Call after resume so a catch-up does not replay old beeps. */
export function armCues(state, now) {
  state.cueElapsedMs = elapsedMs(state, now);
}

export function elapsedMs(state, now) {
  const end = state.paused && state.pausedAt != null ? state.pausedAt : now;
  return Math.max(0, end - state.phaseStartedAt - (state.pauseAccumMs || 0));
}

export function phaseLimitSec(state, settings) {
  if (state.phase === "prehold") return settings.countdownSec;
  if (state.phase === "switch") return settings.switchSec;
  if (state.phase === "rest") return settings.restSec + (state.restBonusSec || 0);
  if (state.phase === "hold") {
    const step = state.steps[state.index];
    if (step?.mode === "target") return step.targetSec;
  }
  return null;
}

export function currentStep(state) {
  return state.steps[state.index] || null;
}

export function peekNextHold(state) {
  for (let i = state.index + 1; i < state.steps.length; i++) {
    if (state.steps[i].kind === "hold") return state.steps[i];
  }
  return null;
}

export function holdProgress(state) {
  const total = state.steps.filter((s) => s.kind === "hold").length;
  const done = state.holds.length;
  const onHold = state.phase === "prehold" || state.phase === "hold" || state.phase === "maxconfirm";
  const current = Math.min(total, done + (onHold ? 1 : 0));
  return { current, done, total };
}

function enterPhase(state, phase, at) {
  state.phase = phase;
  state.phaseStartedAt = at;
  state.pauseAccumMs = 0;
  state.paused = false;
  state.pausedAt = null;
  state.cueElapsedMs = 0;
  state.maxFrozenSec = null;
  if (phase !== "rest") state.restBonusSec = 0;
}

function makeHold(state, step, fields) {
  return {
    id: state.newId(),
    sessionId: state.id,
    sessionStartedAt: state.startedAt,
    exerciseId: step.exerciseId,
    exerciseName: step.name,
    round: step.round,
    side: step.side,
    mode: step.mode,
    targetSec: step.targetSec,
    actualSec: fields.actualSec,
    status: fields.status,
    adjustmentSec: fields.adjustmentSec || 0,
    loggedAt: fields.loggedAt,
  };
}

function pushHold(state, step, fields) {
  // A sub-second "hold" is a stray tap. Log it as skipped so it can't become a record.
  if (fields.actualSec != null && fields.actualSec < MIN_HOLD_SEC) {
    fields = { ...fields, status: "skipped", actualSec: null };
  }
  const hold = makeHold(state, step, fields);
  state.holds.push(hold);
  return hold;
}

function goAfterHold(state, boundary) {
  const next = state.steps[state.index + 1];
  if (!next) {
    enterPhase(state, "summary", boundary);
    return;
  }
  if (next.kind === "switch") {
    state.index += 1;
    enterPhase(state, "switch", boundary);
    return;
  }
  enterPhase(state, "rest", boundary);
}

export function phaseVoice(state) {
  if (state.phase === "prehold") {
    const s = state.steps[state.index];
    if (!s) return null;
    if (s.side === "L") return `${s.name}, left`;
    if (s.side === "R") return `${s.name}, right`;
    return s.name;
  }
  if (state.phase === "rest") return "Rest";
  if (state.phase === "switch") return "Switch to right";
  return null;
}

function emitCues(state, elapsed, limitSec, events) {
  const prev = state.cueElapsedMs || 0;
  const step = state.steps[state.index];
  const marks = [];
  if ((state.phase === "prehold" || state.phase === "switch" || state.phase === "rest") && limitSec != null) {
    const limitMs = limitSec * 1000;
    // The last five seconds of rest are the countdown into the next hold.
    const secs = state.phase === "rest" ? [5, 4, 3, 2, 1] : [3, 2, 1];
    for (const sec of secs) {
      if (sec * 1000 > limitMs) continue;
      marks.push({ at: limitMs - sec * 1000, name: "tick" });
    }
  }
  if (state.phase === "hold" && step?.mode === "target" && limitSec != null) {
    const limitMs = limitSec * 1000;
    marks.push({ at: limitMs / 2, name: "half" });
    for (const sec of [5, 4, 3, 2, 1]) {
      if (sec * 1000 >= limitMs) continue;
      marks.push({ at: limitMs - sec * 1000, name: "tick" });
    }
  }
  if (state.phase === "hold" && step?.mode === "max") {
    const prior = livePrior(state, step);
    if (prior.best != null) marks.push({ at: prior.best * 1000, name: "best" });
    if (prior.last != null && prior.last !== prior.best) marks.push({ at: prior.last * 1000, name: "pass" });
  }
  for (const m of marks) {
    if (m.at > prev && m.at <= elapsed && elapsed - m.at <= 1200) {
      events.push({ type: "beep", name: m.name });
    }
  }
  state.cueElapsedMs = elapsed;
}

function finishPhase(state, boundary, settings, events, silent) {
  if (state.phase === "prehold") {
    enterPhase(state, "hold", boundary);
    if (!silent) {
      const text = phaseVoice(state);
      if (text) events.push({ type: "voice", text });
    }
    return;
  }
  if (state.phase === "hold") {
    const step = state.steps[state.index];
    const hold = pushHold(state, step, {
      status: "completed",
      actualSec: round1(step.targetSec),
      adjustmentSec: 0,
      loggedAt: boundary,
    });
    events.push({ type: "logged", hold });
    if (!silent) events.push({ type: "beep", name: "done" });
    goAfterHold(state, boundary);
    if (!silent) {
      const text = phaseVoice(state);
      if (text) events.push({ type: "voice", text });
    }
    return;
  }
  if (state.phase === "switch") {
    state.index += 1;
    enterPhase(state, "prehold", boundary);
    if (!silent) {
      const text = phaseVoice(state);
      if (text) events.push({ type: "voice", text });
    }
    return;
  }
  if (state.phase === "rest") {
    // Rest already counted down, so go straight into the hold.
    state.index += 1;
    enterPhase(state, "hold", boundary);
    if (!silent) {
      const step = state.steps[state.index];
      const side = step.side === "L" ? ", left" : step.side === "R" ? ", right" : "";
      events.push({ type: "voice", text: `${step.name}${side}` });
    }
  }
  void settings;
}

export function tick(state, now, settings) {
  const events = [];
  if (state.paused || state.phase === "summary" || state.phase === "maxconfirm" || state.phase === "empty") {
    return events;
  }
  let guard = 0;
  while (guard++ < GUARD_LIMIT) {
    const limit = phaseLimitSec(state, settings);
    const elapsed = elapsedMs(state, now);
    if (limit == null || elapsed < limit * 1000) {
      emitCues(state, elapsed, limit, events);
      return events;
    }
    const boundary = state.phaseStartedAt + (state.pauseAccumMs || 0) + limit * 1000;
    // A locked phone can cross several phases. Only the boundary we just hit makes a sound.
    const silent = now - boundary > 1200;
    if (!silent) emitCues(state, limit * 1000, limit, events);
    const before = `${state.phase}:${state.index}:${state.holds.length}`;
    finishPhase(state, boundary, settings, events, silent);
    if (`${state.phase}:${state.index}:${state.holds.length}` === before) {
      throw new Error("Timer catch-up did not settle");
    }
  }
  throw new Error("Timer catch-up did not settle");
}

export function pause(state, now) {
  if (state.paused || state.phase === "summary" || state.phase === "maxconfirm") return;
  state.paused = true;
  state.pausedAt = now;
}

export function resume(state, now) {
  if (!state.paused || state.phase === "maxconfirm") return;
  state.pauseAccumMs += now - state.pausedAt;
  state.paused = false;
  state.pausedAt = null;
}

export function tapStop(state, now) {
  if (state.phase !== "hold" || state.paused) return null;
  const step = state.steps[state.index];
  if (!step || step.mode !== "max") return null;
  const actual = round1(elapsedMs(state, now) / 1000);
  const hold = pushHold(state, step, {
    status: "completed",
    actualSec: actual,
    adjustmentSec: 0,
    loggedAt: now,
  });
  goAfterHold(state, now);
  return hold;
}

export function failEarly(state, now) {
  if (state.phase !== "hold") return null;
  if (state.paused) resume(state, now);
  const step = state.steps[state.index];
  const actual = round1(elapsedMs(state, now) / 1000);
  const hold = pushHold(state, step, {
    status: step.mode === "max" ? "completed" : "failed_early",
    actualSec: actual,
    adjustmentSec: 0,
    loggedAt: now,
  });
  goAfterHold(state, now);
  return hold;
}

export function addRest(state, sec) {
  if (state.phase !== "rest") return;
  state.restBonusSec = (state.restBonusSec || 0) + sec;
}

export function skipRest(state, now) {
  if (state.phase !== "rest") return;
  state.index += 1;
  state.restBonusSec = 0;
  enterPhase(state, "prehold", now);
}

export function adjustLast(state, deltaSec) {
  if (state.phase !== "rest") return;
  const h = state.holds[state.holds.length - 1];
  if (!h || h.status === "skipped" || h.actualSec == null) return;
  const next = round1(Math.max(MIN_HOLD_SEC, h.actualSec + deltaSec));
  h.adjustmentSec = round1((h.adjustmentSec || 0) + next - h.actualSec);
  h.actualSec = next;
}

export function skipExercise(state, now) {
  let i = state.index;
  if (state.phase === "rest" || state.phase === "switch") {
    for (let j = state.index + 1; j < state.steps.length; j++) {
      if (state.steps[j].kind === "hold") {
        i = j;
        break;
      }
    }
  }
  const step = state.steps[i];
  if (!step || step.kind !== "hold") return;
  const sideOnly = state.phase === "switch";
  const already = new Set(state.holds.map((h) => `${h.round}|${h.exerciseId}|${h.side || ""}`));
  let last = i;
  for (let j = i; j < state.steps.length; j++) {
    const s = state.steps[j];
    if (s.kind !== "hold") continue;
    if (s.round !== step.round || s.exerciseId !== step.exerciseId) break;
    if (sideOnly && j > i) break;
    const key = `${s.round}|${s.exerciseId}|${s.side || ""}`;
    if (!already.has(key)) {
      pushHold(state, s, {
        status: "skipped",
        actualSec: null,
        adjustmentSec: 0,
        loggedAt: now,
      });
    }
    last = j;
  }
  state.index = last;
  const after = state.steps[last + 1];
  if (!after) enterPhase(state, "summary", now);
  else enterPhase(state, "rest", now);
}

export function back(state, now) {
  if (!state.holds.length) return;
  if (state.phase === "maxconfirm") {
    state.phase = "hold";
    state.paused = false;
    state.pausedAt = null;
  }
  const last = state.holds.pop();
  delete state.decisions[last.exerciseId];
  const idx = state.steps.findIndex(
    (s) => s.kind === "hold" && s.round === last.round && s.exerciseId === last.exerciseId && (s.side || null) === (last.side || null),
  );
  if (idx < 0) return;
  state.index = idx;
  enterPhase(state, "prehold", now);
}

export function endEarly(state, now) {
  if (!state.holds.length) {
    state.phase = "empty";
    state.status = "abandoned";
    return;
  }
  enterPhase(state, "summary", now);
}

export function freezeMax(state, now) {
  if (state.phase !== "hold" || state.paused) return false;
  const step = state.steps[state.index];
  if (!step || step.mode !== "max") return false;
  state.maxFrozenSec = round1(elapsedMs(state, now) / 1000);
  state.paused = true;
  state.pausedAt = now;
  state.phase = "maxconfirm";
  return true;
}

export function confirmMax(state, now, actualSec) {
  if (state.phase !== "maxconfirm") return null;
  const step = state.steps[state.index];
  const sec = round1(Math.max(0, actualSec));
  const hold = pushHold(state, step, {
    status: "completed",
    actualSec: sec,
    adjustmentSec: 0,
    loggedAt: now,
  });
  state.paused = false;
  state.pausedAt = null;
  goAfterHold(state, now);
  return hold;
}

/** Mode and target edits apply only to holds that have not started. */
export function patchFutureHolds(state, exerciseId, patch) {
  for (let i = state.index + 1; i < state.steps.length; i++) {
    const s = state.steps[i];
    if (s.kind !== "hold" || s.exerciseId !== exerciseId) continue;
    if (patch.mode) s.mode = patch.mode === "max" ? "max" : "target";
    if (patch.targetSec != null) s.targetSec = patch.targetSec;
    if (patch.name) s.name = patch.name;
    if (patch.cues) s.cues = patch.cues.slice(0, 3);
  }
}

export function setDecision(state, exerciseId, choice) {
  state.decisions[exerciseId] = choice;
}

export function clockMs(state, now, settings) {
  if (state.phase === "maxconfirm") return (state.maxFrozenSec || 0) * 1000;
  const elapsed = elapsedMs(state, now);
  const limit = phaseLimitSec(state, settings);
  const step = state.steps[state.index];
  if (state.phase === "hold" && step?.mode === "max") return elapsed;
  if (limit == null) return elapsed;
  return Math.max(0, limit * 1000 - elapsed);
}
