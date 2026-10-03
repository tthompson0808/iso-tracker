import assert from "node:assert/strict";
import test from "node:test";
import {
  addRest,
  adjustLast,
  armCues,
  back,
  clockMs,
  confirmMax,
  createSession,
  currentStep,
  elapsedMs,
  endEarly,
  failEarly,
  freezeMax,
  patchFutureHolds,
  pause,
  peekNextHold,
  resume,
  serializeSession,
  skipExercise,
  skipRest,
  tapStop,
  tick,
} from "../js/engine.js";
import { exportPayload, historyCsv, parseBackup, setHoldActual } from "../js/io.js";
import { createLock } from "../js/lock.js";
import { DEFAULT_SETTINGS, SEED_EXERCISES } from "../js/plan.js";
import {
  applyAccepted,
  chartSeries,
  isRecord,
  needsExportReminder,
  proposalsFor,
  records,
  removeExercise,
  weeks,
} from "../js/progress.js";
import { formatHold, sessionDay, weekStartMonday } from "../js/time.js";

function ids() {
  let n = 0;
  return () => `id-${n++}`;
}

function startSession(exercises, settings, start, past = []) {
  return createSession({
    exercises,
    settings,
    pastSessions: past,
    now: start,
    id: ids(),
  });
}

function allTarget(exercises) {
  return exercises.map((ex) => ({ ...ex, mode: "target" }));
}

function expectedMs(exercises, settings) {
  const enabled = exercises.filter((ex) => ex.enabled && !ex.archived).sort((a, b) => a.order - b.order);
  let ms = 0;
  const sequence = [];
  for (let round = 1; round <= settings.rounds; round++) {
    enabled.forEach((ex, exIndex) => {
      const sides = ex.unilateral ? ["L", "R"] : [null];
      sides.forEach((side, sideIndex) => {
        // Rest counts down into the next hold; only the first hold and the right side get a get-in-position phase.
        if (sequence.length === 0 || side === "R") ms += settings.countdownSec * 1000;
        ms += ex.targetSec * 1000;
        sequence.push({ name: ex.name, side, round });
        if (side === "L") ms += settings.switchSec * 1000;
        const lastExercise = exIndex === enabled.length - 1 && round === settings.rounds;
        const lastSide = sideIndex === sides.length - 1;
        if (!(lastExercise && lastSide) && side !== "L") ms += settings.restSec * 1000;
      });
    });
  }
  return { ms, sequence };
}

test("a full target circuit finishes on the clock with no taps", () => {
  const exercises = allTarget(SEED_EXERCISES);
  const settings = { ...DEFAULT_SETTINGS };
  const start = 1_700_000_000_000;
  const state = startSession(exercises, settings, start);
  const { ms, sequence } = expectedMs(exercises, settings);
  const events = tick(state, start + ms + 60_000, settings);
  assert.equal(state.phase, "summary");
  assert.equal(state.phaseStartedAt, start + ms);
  assert.equal(state.holds.length, sequence.length);
  assert.equal(sequence.length, 24);
  state.holds.forEach((hold, i) => {
    assert.equal(hold.exerciseName, sequence[i].name);
    assert.equal(hold.side, sequence[i].side);
    assert.equal(hold.round, sequence[i].round);
    assert.equal(hold.status, "completed");
    assert.equal(hold.mode, "target");
    assert.equal(hold.actualSec, hold.targetSec);
    assert.notEqual(hold.actualSec, 0);
  });
  assert.equal(events.filter((e) => e.type === "beep").length, 0);
  const switches = state.steps.filter((s) => s.kind === "switch");
  assert.equal(switches.length, 6);
});

test("max holds do not end themselves, and a 30s lock logs the target that already finished", () => {
  const exercises = [
    { ...SEED_EXERCISES[0], mode: "max", targetSec: 20, unilateral: false, order: 0 },
    { ...SEED_EXERCISES[4], mode: "target", targetSec: 15, unilateral: false, order: 1 },
  ];
  const settings = { ...DEFAULT_SETTINGS, rounds: 1, countdownSec: 0, restSec: 60 };
  const start = 5_000_000;
  const maxState = startSession(exercises, settings, start);
  tick(maxState, start + 3_600_000, settings);
  assert.equal(maxState.phase, "hold");
  assert.equal(maxState.holds.length, 0);
  assert.equal(elapsedMs(maxState, start + 3_600_000), 3_600_000);

  const targetExercises = exercises.map((ex) => ({ ...ex, mode: "target" }));
  const target = startSession(targetExercises, settings, start);
  tick(target, start + 30_000, settings);
  assert.equal(target.phase, "rest");
  assert.equal(target.holds.length, 1);
  assert.equal(target.holds[0].status, "completed");
  assert.equal(target.holds[0].actualSec, 20);
  assert.equal(elapsedMs(target, start + 30_000), 10_000);
});

test("pause time is not counted and drift is the wall clock", () => {
  const exercises = [{ ...SEED_EXERCISES[2], mode: "max", unilateral: false }];
  const settings = { ...DEFAULT_SETTINGS, rounds: 1, countdownSec: 0 };
  const start = 8_000;
  const state = startSession(exercises, settings, start);
  tick(state, start, settings);
  assert.equal(state.phase, "hold");
  pause(state, start + 10_000);
  resume(state, start + 40_000);
  const at = start + 50_000;
  tick(state, at, settings);
  assert.equal(elapsedMs(state, at), 20_000);
  assert.ok(Math.abs(clockMs(state, at, settings) - 20_000) < 500);
});

test("returning to a max hold asks before logging the locked time", () => {
  const exercises = [{ ...SEED_EXERCISES[0], mode: "max", unilateral: false }];
  const settings = { ...DEFAULT_SETTINGS, rounds: 1, countdownSec: 0 };
  const start = 0;
  const state = startSession(exercises, settings, start);
  tick(state, start, settings);
  assert.equal(freezeMax(state, 30_000), true);
  assert.equal(state.phase, "maxconfirm");
  assert.equal(state.maxFrozenSec, 30);
  tick(state, 90_000, settings);
  assert.equal(state.phase, "maxconfirm");
  const yes = confirmMax(state, 31_000, state.maxFrozenSec);
  assert.equal(yes.actualSec, 30);
  assert.equal(yes.status, "completed");
});

test("fail early, skip, adjust, and back do not write a zero", () => {
  const exercises = allTarget(SEED_EXERCISES).slice(0, 2);
  const settings = { ...DEFAULT_SETTINGS, rounds: 1, countdownSec: 0, restSec: 30, switchSec: 10 };
  const start = 100;
  const state = startSession(exercises, settings, start);
  tick(state, start, settings);
  failEarly(state, start + 4_200);
  assert.equal(state.holds.at(-1).status, "failed_early");
  assert.equal(state.holds.at(-1).actualSec, 4.2);
  assert.equal(state.phase, "rest");
  adjustLast(state, -1);
  assert.equal(state.holds.at(-1).actualSec, 3.2);
  assert.equal(state.holds.at(-1).adjustmentSec, -1);
  back(state, start + 5_000);
  assert.equal(state.holds.length, 0);
  assert.equal(state.phase, "prehold");
  skipExercise(state, start + 5_000);
  assert.equal(state.holds.length, 1);
  assert.equal(state.holds[0].status, "skipped");
  assert.equal(state.holds[0].actualSec, null);
  const next = peekNextHold(state);
  assert.equal(next.name, "Split squat iso");
  skipExercise(state, start + 6_000);
  assert.deepEqual(
    state.holds.slice(1).map((h) => h.side),
    ["L", "R"],
  );
  assert.ok(state.holds.slice(1).every((h) => h.actualSec == null && h.status === "skipped"));
});

test("a target edit during rest hits the upcoming hold, a mode edit skips the hold already running", () => {
  const exercises = [
    { ...SEED_EXERCISES[4], mode: "target", targetSec: 5, unilateral: false, order: 0 },
    { ...SEED_EXERCISES[5], mode: "target", targetSec: 5, unilateral: false, order: 1 },
  ];
  const settings = { ...DEFAULT_SETTINGS, rounds: 1, countdownSec: 0, restSec: 20 };
  const start = 0;
  const state = startSession(exercises, settings, start);
  tick(state, start, settings);
  assert.equal(state.phase, "hold");
  patchFutureHolds(state, exercises[0].id, { mode: "max" });
  assert.equal(currentStep(state).mode, "target");
  tick(state, start + 5_000, settings);
  assert.equal(state.phase, "rest");
  patchFutureHolds(state, exercises[1].id, { targetSec: 99, mode: "max" });
  assert.equal(peekNextHold(state).targetSec, 99);
  assert.equal(peekNextHold(state).mode, "max");
  skipRest(state, start + 6_000);
  tick(state, start + 6_000, settings);
  assert.equal(currentStep(state).mode, "max");
  assert.equal(state.holds.length, 1);
  addRest(state, 15);
  assert.equal(state.phase, "hold");
});

test("session date follows the start, including across midnight", () => {
  const start = new Date(2026, 9, 2, 23, 30, 0).getTime();
  const later = new Date(2026, 9, 3, 0, 10, 0).getTime();
  assert.equal(sessionDay(start), "2026-10-02");
  assert.equal(sessionDay(later), "2026-10-03");
  const state = startSession(allTarget([SEED_EXERCISES[4]]), { ...DEFAULT_SETTINGS, rounds: 1, countdownSec: 0, restSec: 0 }, start);
  tick(state, later, { ...DEFAULT_SETTINGS, rounds: 1, countdownSec: 0, restSec: 0 });
  assert.equal(sessionDay(state.startedAt), "2026-10-02");
  assert.equal(state.holds[0].sessionStartedAt, start);
});

test("target progression rises only when every side and round hits, and two early fails only suggest a drop", () => {
  const split = { ...SEED_EXERCISES[1], targetSec: 30, incrementSec: 5 };
  const pike = { ...SEED_EXERCISES[4], targetSec: 15, incrementSec: 5 };
  const exercises = [split, pike];
  const hit = {
    id: "s1",
    startedAt: 10,
    status: "completed",
    totalRounds: 1,
    holds: [
      { exerciseId: split.id, status: "completed", mode: "target", side: "L", round: 1, actualSec: 30 },
      { exerciseId: split.id, status: "completed", mode: "target", side: "R", round: 1, actualSec: 30 },
      { exerciseId: pike.id, status: "failed_early", mode: "target", side: null, round: 1, actualSec: 9 },
    ],
    decisions: {},
  };
  const again = {
    id: "s2",
    startedAt: 20,
    status: "in_progress",
    totalRounds: 1,
    holds: [
      { exerciseId: split.id, status: "completed", mode: "target", side: "L", round: 1, actualSec: 30 },
      { exerciseId: split.id, status: "completed", mode: "target", side: "R", round: 1, actualSec: 30 },
      { exerciseId: pike.id, status: "failed_early", mode: "target", side: null, round: 1, actualSec: 8 },
    ],
    decisions: {},
  };
  const props = proposalsFor(again, exercises, [hit]);
  const splitProp = props.find((p) => p.exerciseId === split.id);
  const pikeProp = props.find((p) => p.exerciseId === pike.id);
  assert.equal(splitProp.type, "raise");
  assert.equal(splitProp.to, 35);
  assert.equal(pikeProp.type, "drop");
  assert.equal(pikeProp.to, 10);
  assert.deepEqual(applyAccepted(exercises, props), exercises);
  splitProp.choice = "accept";
  pikeProp.choice = "reject";
  const next = applyAccepted(exercises, props);
  assert.equal(next.find((ex) => ex.id === split.id).targetSec, 35);
  assert.equal(next.find((ex) => ex.id === pike.id).targetSec, 15);
  const oneFail = proposalsFor(hit, exercises, []);
  assert.equal(oneFail.find((p) => p.exerciseId === pike.id), undefined);
});

test("max mode tracks best, last, and average and does not move the target", () => {
  const wall = SEED_EXERCISES[0];
  const session = {
    id: "m",
    startedAt: 5,
    status: "completed",
    totalRounds: 3,
    holds: [28, 35, 31].map((actualSec, i) => ({
      exerciseId: wall.id,
      status: "completed",
      mode: "max",
      side: null,
      round: i + 1,
      actualSec,
    })),
    decisions: {},
  };
  assert.equal(proposalsFor(session, [wall], []).length, 0);
  const line = chartSeries(wall, [session]).none;
  assert.equal(line.length, 1);
  assert.equal(line[0].seconds, 35);
  const rec = records([wall], [session]);
  assert.equal(rec[0].best, 35);
});

test("a new record includes an earlier round of the same session", () => {
  const hold = {
    id: "b",
    exerciseId: "ex_wall_sit",
    side: null,
    status: "completed",
    actualSec: 40,
    loggedAt: 20,
    sessionStartedAt: 10,
  };
  const earlier = { ...hold, id: "a", actualSec: 30, loggedAt: 15 };
  const session = { id: "s", startedAt: 10, holds: [earlier, hold] };
  assert.equal(isRecord(hold, [session]), true);
  assert.equal(isRecord(earlier, [session]), true);
  assert.equal(isRecord({ ...hold, id: "c", actualSec: 30, loggedAt: 25 }, [session]), false);
});

test("history is archived when the exercise is removed, and a host backup round-trips", () => {
  const exercises = SEED_EXERCISES.map((ex) => ({ ...ex }));
  const sessions = [{
    id: "s",
    startedAt: 10,
    status: "completed",
    holds: [{ exerciseId: exercises[0].id, exerciseName: "Wall sit", actualSec: 12, status: "completed" }],
  }];
  const archived = removeExercise(exercises, sessions, exercises[0].id);
  assert.equal(archived.find((ex) => ex.id === exercises[0].id).archived, true);
  assert.equal(archived.length, exercises.length);
  const unused = removeExercise(exercises, [], exercises[1].id);
  assert.equal(unused.find((ex) => ex.id === exercises[1].id), undefined);

  const settings = { ...DEFAULT_SETTINGS, voiceOn: false };
  const raw = JSON.stringify(exportPayload(settings, exercises, sessions, 99));
  const parsed = parseBackup(raw);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.exercises.length, 6);
  assert.equal(parsed.data.sessions[0].holds[0].actualSec, 12);
  assert.equal(parsed.data.settings.restSec, 60);
  assert.equal(parseBackup('{"version":2}').ok, false);
  const csv = historyCsv([{
    id: "s",
    startedAt: 10,
    holds: [{ exerciseId: "e", exerciseName: "=cmd", round: 1, side: null, mode: "max", targetSec: 20, actualSec: null, status: "skipped", adjustmentSec: 0 }],
  }]);
  assert.match(csv, /'=cmd/);
  assert.doesNotMatch(csv, /,0,/);
  setHoldActual({ holds: [{ id: "h", status: "completed", actualSec: 20, adjustmentSec: 0 }] }, "h", 18.4);
});

test("two tabs cannot both own the workout, and a dead tab expires", () => {
  const memory = () => {
    const data = new Map();
    return {
      getItem: (k) => data.get(k) ?? null,
      setItem: (k, v) => data.set(k, v),
      removeItem: (k) => data.delete(k),
    };
  };
  const storage = memory();
  let now = 1_000;
  const a = createLock(storage, () => now, "tab-a");
  const b = createLock(storage, () => now, "tab-b");
  assert.equal(a.claim(), true);
  assert.equal(b.claim(), false);
  assert.equal(b.heldByOther(), true);
  now += 5000;
  assert.equal(b.claim(), true);
  b.release();
  assert.equal(a.claim(), true);
  a.release();
  assert.equal(b.heldByOther(), false);
});

test("eight weeks count sessions by their start, and export nags after 14 days", () => {
  const now = new Date(2026, 9, 2, 12).getTime();
  assert.equal(weekStartMonday(now), new Date(2026, 8, 28).getTime());
  const sessions = [
    { id: "a", startedAt: now - 2 * 86400000, status: "completed", holds: [{ id: "h" }] },
    { id: "b", startedAt: now - 20 * 86400000, status: "completed", holds: [{ id: "h2" }] },
    { id: "c", startedAt: now, status: "abandoned", holds: [] },
  ];
  const buckets = weeks(sessions, now);
  assert.equal(buckets.length, 8);
  assert.equal(buckets.reduce((sum, b) => sum + b.count, 0), 2);
  assert.equal(needsExportReminder({ lastExportAt: null }, sessions, now), true);
  assert.equal(needsExportReminder({ lastExportAt: now - 86400000 }, sessions, now), false);
});

test("resume keeps completed holds and can continue the clock", () => {
  const exercises = allTarget([SEED_EXERCISES[4]]);
  const settings = { ...DEFAULT_SETTINGS, rounds: 1, countdownSec: 1, restSec: 0 };
  const start = 50_000;
  const state = startSession(exercises, settings, start);
  tick(state, start + 1_000, settings);
  assert.equal(state.phase, "hold");
  const saved = serializeSession(state);
  assert.equal(saved.holds.length, 0);
  tick(state, start + 1_000 + 15_000, settings);
  assert.equal(state.phase, "summary");
  assert.equal(state.holds.length, 1);
  const restored = startSession(exercises, settings, start);
  Object.assign(restored, saved, { newId: restored.newId });
  armCues(restored, start + 1_500);
  tick(restored, start + 1_000 + 15_000, settings);
  assert.equal(restored.holds.length, 1);
  assert.equal(restored.holds[0].status, "completed");
});

test("ending early keeps finished holds and tap-to-stop is max only", () => {
  const exercises = [
    { ...SEED_EXERCISES[0], mode: "max", unilateral: false, order: 0 },
    { ...SEED_EXERCISES[4], mode: "target", unilateral: false, order: 1 },
  ];
  const settings = { ...DEFAULT_SETTINGS, rounds: 1, countdownSec: 0, restSec: 10 };
  const start = 0;
  const state = startSession(exercises, settings, start);
  tick(state, start, settings);
  assert.equal(tapStop(state, start + 12_400).actualSec, 12.4);
  assert.equal(state.phase, "rest");
  endEarly(state, start + 13_000);
  assert.equal(state.phase, "summary");
  assert.equal(state.holds.length, 1);
  const empty = startSession(exercises, settings, start);
  endEarly(empty, start + 10);
  assert.equal(empty.phase, "empty");
  assert.equal(empty.holds.length, 0);
});

test("Max mode: failing early is completing, not an early end", () => {
  const exercises = [{ ...SEED_EXERCISES[0], mode: "max", order: 0 }];
  const settings = { ...DEFAULT_SETTINGS, rounds: 1, countdownSec: 0 };
  const state = startSession(exercises, settings, 0);
  tick(state, 0, settings);
  failEarly(state, 12_000);
  assert.equal(state.holds.at(-1).status, "completed");
});

test("a sub-second hold is skipped, and -1 s stops at one second", () => {
  const exercises = [{ ...SEED_EXERCISES[4], mode: "target", order: 0 }, { ...SEED_EXERCISES[5], mode: "target", order: 1 }];
  const settings = { ...DEFAULT_SETTINGS, rounds: 1, countdownSec: 0, restSec: 30 };
  const state = startSession(exercises, settings, 0);
  tick(state, 0, settings);
  failEarly(state, 400);
  assert.equal(state.holds.at(-1).status, "skipped");
  assert.equal(state.holds.at(-1).actualSec, null);
  back(state, 500);
  tick(state, 500, settings);
  failEarly(state, 2_500);
  adjustLast(state, -1);
  adjustLast(state, -1);
  assert.equal(state.holds.at(-1).actualSec, 1);
});

test("skipping from the switch screen skips only the right side", () => {
  const exercises = [{ ...SEED_EXERCISES[1], mode: "target", targetSec: 5, order: 0 }];
  const settings = { ...DEFAULT_SETTINGS, rounds: 1, countdownSec: 0, switchSec: 10 };
  const state = startSession(exercises, settings, 0);
  tick(state, 0, settings);
  tick(state, 5_000, settings);
  assert.equal(state.phase, "switch");
  skipExercise(state, 6_000);
  assert.deepEqual(state.holds.map((h) => [h.side, h.status]), [["L", "completed"], ["R", "skipped"]]);
});

test("hold time reads 30.0 s under a minute and 1:25.4 after", () => {
  assert.equal(formatHold(30), "30.0 s");
  assert.equal(formatHold(85.4), "1:25.4");
});
