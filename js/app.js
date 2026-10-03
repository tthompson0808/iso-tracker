import { beep, buzz, setVolume, speak, unlock } from "./audio.js";
import { drawChart } from "./chart.js";
import { deleteSession, loadAll, replaceAll, saveExercises, saveSession, saveSettings } from "./db.js";
import {
  addRest, adjustLast, armCues, back, clockMs, confirmMax, createSession, currentStep,
  endEarly, failEarly, freezeMax, holdProgress, hydrateSession, livePrior, patchFutureHolds,
  pause, peekNextHold, phaseVoice, resume, serializeSession, setDecision, skipExercise,
  skipRest, tapStop, tick,
} from "./engine.js";
import { exportPayload, historyCsv, parseBackup, setHoldActual } from "./io.js";
import { createLock } from "./lock.js";
import { DEFAULT_SETTINGS, SEED_EXERCISES, activeExercises, newExercise } from "./plan.js";
import {
  applyAccepted, isRecord, matchHold, maxSummary, needsExportReminder, previousCompleted,
  proposalsFor, records, removeExercise, weeks,
} from "./progress.js";
import { MIN_HOLD_SEC, formatHold, formatWhen, sessionDay, splitClock, uid } from "./time.js";

const REPO_URL = "https://github.com/tthompson0808/iso-tracker";

const ui = {
  screen: "home",
  data: { settings: { ...DEFAULT_SETTINGS }, exercises: [], sessions: [] },
  workout: null,
  modal: null,
  editor: null,
  progressTab: "chart",
  chartId: null,
  detailId: null,
  enterTime: false,
  webLock: null,
  lsLock: null,
  pulse: 0,
  looping: false,
  raf: 0,
  starting: false,
  wake: null,
  wakeWarning: null,
  storageError: null,
  tabId: "",
  lastAnnouncedSec: -1,
  hiddenAt: 0,
  pendingImport: null,
  dirty: false,
  restMore: false,
  viewKey: "",
};

function h(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

function orderedExercises() {
  return ui.data.exercises.slice().sort((a, b) => a.order - b.order);
}

function liveSaved() {
  return ui.data.sessions
    .filter((s) => s.status === "in_progress" && s.holds && s.phase !== "empty")
    .sort((a, b) => b.startedAt - a.startedAt)[0] || null;
}

function allSessions() {
  if (!ui.workout) return ui.data.sessions;
  return [...ui.data.sessions.filter((s) => s.id !== ui.workout.id), ui.workout];
}

function sideName(side) {
  if (side === "L") return "Left";
  if (side === "R") return "Right";
  return "";
}

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function storageFail() {
  ui.storageError = "Could not save on this phone. Keep this tab open and export a backup.";
}

let dbChain = Promise.resolve();

function enqueue(work) {
  const run = dbChain.then(work, work);
  dbChain = run.then(() => {}, () => {});
  return run;
}

async function persistWorkout() {
  if (!ui.workout) return;
  const snap = serializeSession(ui.workout);
  const index = ui.data.sessions.findIndex((s) => s.id === snap.id);
  if (index >= 0) ui.data.sessions[index] = snap;
  else ui.data.sessions.push(snap);
  return enqueue(async () => {
    try {
      await saveSession(snap);
    } catch {
      storageFail();
    }
  });
}

async function persistExercises() {
  const exercises = ui.data.exercises;
  return enqueue(async () => {
    try {
      await saveExercises(exercises);
    } catch {
      storageFail();
    }
  });
}

async function persistSettings(patch) {
  ui.data.settings = { ...ui.data.settings, ...patch };
  setVolume(ui.data.settings.volume);
  const settings = ui.data.settings;
  return enqueue(async () => {
    try {
      await saveSettings(settings);
    } catch {
      storageFail();
    }
  });
}

function releaseLock() {
  ui.webLock?.release?.();
  ui.webLock = null;
  ui.lsLock?.release?.();
  ui.lsLock = null;
  if (ui.pulse) clearInterval(ui.pulse);
  ui.pulse = 0;
}

function claimWebLock() {
  return new Promise((resolve) => {
    let releaseHold = () => {};
    navigator.locks.request("iso-tracker-workout", { ifAvailable: true }, (lock) => {
      if (!lock) {
        resolve({ ok: false, release() {} });
        return;
      }
      resolve({ ok: true, release() { releaseHold(); } });
      return new Promise((done) => { releaseHold = done; });
    });
  });
}

function lockHeld() {
  return Boolean(ui.webLock || ui.lsLock);
}

async function claimLock() {
  if (navigator.locks?.request) {
    const lock = await claimWebLock();
    if (!lock.ok) return false;
    ui.webLock = lock;
    return true;
  }
  const ls = createLock(localStorage, () => Date.now(), ui.tabId);
  if (!ls.claim()) return false;
  ui.lsLock = ls;
  ui.pulse = setInterval(() => ls.pulse(), 1000);
  return true;
}

async function requestWake() {
  if (!("wakeLock" in navigator)) {
    ui.wakeWarning = "Turn off Auto-Lock.";
    return;
  }
  try {
    ui.wake = await navigator.wakeLock.request("screen");
    ui.wakeWarning = null;
  } catch {
    ui.wakeWarning = "Turn off Auto-Lock.";
  }
}

async function releaseWake() {
  try { await ui.wake?.release(); } catch { /* already released when the screen locked */ }
  ui.wake = null;
}

function download(filename, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = h("a", { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function playEvents(events) {
  for (const event of events) {
    if (event.type === "beep" && ui.data.settings.audioOn) beep(event.name);
    if (event.type === "voice" && ui.data.settings.voiceOn) speak(event.text);
    if (event.type === "beep" || event.type === "logged") buzz();
  }
}

function phaseKey(state) {
  return `${state.phase}:${state.index}:${state.paused ? 1 : 0}:${state.holds.length}:${state.restBonusSec}`;
}

function clockRuns() {
  if (ui.screen !== "workout" || !ui.workout || ui.workout.paused) return false;
  return ["prehold", "hold", "switch", "rest"].includes(ui.workout.phase);
}

function stopRaf() {
  ui.looping = false;
  if (ui.raf) cancelAnimationFrame(ui.raf);
  ui.raf = 0;
}

function startRaf() {
  if (ui.looping) return;
  ui.looping = true;
  const loop = () => {
    if (!ui.looping || !ui.workout) return;
    const before = phaseKey(ui.workout);
    const events = tick(ui.workout, Date.now(), ui.data.settings);
    playEvents(events);
    if (ui.workout.phase === "summary") {
      ui.looping = false;
      ui.screen = "summary";
      persistWorkout();
      render();
      return;
    }
    if (phaseKey(ui.workout) !== before) {
      ui.looping = false;
      persistWorkout();
      render();
      return;
    }
    paintClock(Date.now());
    ui.raf = requestAnimationFrame(loop);
  };
  ui.raf = requestAnimationFrame(loop);
}

function paintClock(now) {
  const ms = clockMs(ui.workout, now, ui.data.settings);
  const parts = splitClock(Math.floor(ms / 100));
  const main = document.querySelector("[data-clock-main]");
  const tenth = document.querySelector("[data-clock-tenth]");
  if (main && main.textContent !== parts.main) main.textContent = parts.main;
  if (tenth && tenth.textContent !== parts.tenth) tenth.textContent = parts.tenth;
  const sec = Math.floor(ms / 1000);
  if (sec !== ui.lastAnnouncedSec) {
    ui.lastAnnouncedSec = sec;
    const live = document.querySelector("[data-live]");
    if (live) live.textContent = `${sec} seconds`;
  }
}

function clockFace(now, mode) {
  const ms = clockMs(ui.workout, now, ui.data.settings);
  const parts = splitClock(Math.floor(ms / 100));
  return h("div", { class: `clock ${mode || "neutral"}`, "aria-hidden": "true" },
    h("span", { class: "clock-main", "data-clock-main": "1", text: parts.main }),
    h("span", { class: "clock-dot", text: "." }),
    h("span", { class: "clock-tenth", "data-clock-tenth": "1", text: parts.tenth }),
  );
}

function cueList(cues) {
  if (!cues?.length) return null;
  return h("ul", { class: "cues" }, cues.map((cue) => h("li", { text: cue })));
}

function afterChange() {
  if (!ui.workout) return;
  if (ui.workout.phase === "empty") {
    dropWorkout();
    return;
  }
  if (ui.workout.phase === "summary") ui.screen = "summary";
  persistWorkout();
  render();
}

function beginSession() {
  const now = Date.now();
  ui.workout = createSession({
    exercises: ui.data.exercises,
    settings: ui.data.settings,
    pastSessions: ui.data.sessions.filter((s) => s.status === "completed"),
    now,
    id: uid,
  });
  ui.enterTime = false;
  ui.screen = ui.workout.phase === "summary" ? "summary" : "workout";
  ui.modal = null;
  persistWorkout();
  if (ui.data.settings.voiceOn) speak(phaseVoice(ui.workout));
  render();
}

function onStart() {
  if (ui.starting || ui.workout) return;
  if (!activeExercises(ui.data.exercises).length) return;
  ui.starting = true;
  unlock();
  setVolume(ui.data.settings.volume);
  requestWake();
  claimLock().then((ok) => {
    ui.starting = false;
    if (!ok) {
      releaseWake();
      ui.modal = { type: "blocked" };
      render();
      return;
    }
    beginSession();
  });
}

function resumeSaved(saved) {
  if (ui.starting) return;
  ui.starting = true;
  unlock();
  setVolume(ui.data.settings.volume);
  requestWake();
  claimLock().then((ok) => {
    ui.starting = false;
    if (!ok) {
      releaseWake();
      ui.modal = { type: "blocked" };
      render();
      return;
    }
    const now = Date.now();
    ui.workout = hydrateSession(structuredClone(saved), uid);
    armCues(ui.workout, now);
    const events = tick(ui.workout, now, ui.data.settings);
    playEvents(events);
    if (ui.workout.phase === "hold") {
      const away = ui.hiddenAt ? now - ui.hiddenAt : 0;
      if (away > 2000) freezeMax(ui.workout, now);
    }
    ui.enterTime = false;
    ui.modal = null;
    ui.screen = ui.workout.phase === "summary" ? "summary" : "workout";
    persistWorkout();
    if (ui.data.settings.voiceOn) {
      const step = currentStep(ui.workout);
      speak(ui.workout.phase === "hold" && step ? `${step.name}${step.side === "L" ? ", left" : step.side === "R" ? ", right" : ""}` : phaseVoice(ui.workout));
    }
    render();
  });
}

function dropWorkout() {
  const id = ui.workout?.id;
  ui.workout = null;
  ui.screen = "home";
  ui.modal = null;
  releaseLock();
  releaseWake();
  if (id) {
    ui.data.sessions = ui.data.sessions.filter((s) => s.id !== id);
    enqueue(() => deleteSession(id).catch(storageFail));
  }
  render();
}

function finishSaved(saved) {
  if (ui.starting) return;
  ui.starting = true;
  const ready = lockHeld() ? Promise.resolve(true) : claimLock();
  ready.then((ok) => {
    ui.starting = false;
    if (!ok) {
      ui.modal = { type: "blocked" };
      render();
      return;
    }
    ui.workout = hydrateSession(structuredClone(saved), uid);
    endEarly(ui.workout, Date.now());
    ui.modal = null;
    if (ui.workout.phase === "empty") {
      dropWorkout();
      return;
    }
    ui.screen = "summary";
    persistWorkout();
    render();
  });
}

function onPause() {
  if (!ui.workout || ui.workout.phase === "maxconfirm") return;
  if (ui.workout.paused) resume(ui.workout, Date.now());
  else pause(ui.workout, Date.now());
  afterChange();
}

function onStageClick(event) {
  if (event.target.closest("button, input, textarea, a")) return;
  const step = currentStep(ui.workout);
  if (!ui.workout || ui.workout.phase !== "hold" || ui.workout.paused || step?.mode !== "max") return;
  finishMax();
}

function finishMax() {
  tapStop(ui.workout, Date.now());
  if (ui.data.settings.audioOn) beep("done");
  if (ui.data.settings.voiceOn) speak(phaseVoice(ui.workout));
  buzz(20);
  afterChange();
}

function onFail() {
  failEarly(ui.workout, Date.now());
  if (ui.data.settings.audioOn) beep("done");
  if (ui.data.settings.voiceOn) speak(phaseVoice(ui.workout));
  afterChange();
}

function onSkip() {
  skipExercise(ui.workout, Date.now());
  if (ui.data.settings.voiceOn) speak(phaseVoice(ui.workout));
  afterChange();
}

function onBack() {
  back(ui.workout, Date.now());
  ui.screen = "workout";
  ui.enterTime = false;
  afterChange();
}

function onVisible() {
  if (document.visibilityState === "hidden") {
    ui.hiddenAt = Date.now();
    return;
  }
  if (ui.workout && ui.screen === "workout") requestWake();
  if (!ui.workout || ui.screen !== "workout") return;
  const away = Date.now() - (ui.hiddenAt || Date.now());
  const wasMaxHold = ui.workout.phase === "hold" && currentStep(ui.workout)?.mode === "max" && !ui.workout.paused;
  armCues(ui.workout, Date.now());
  const events = tick(ui.workout, Date.now(), ui.data.settings);
  playEvents(events);
  if (wasMaxHold && ui.workout.phase === "hold" && away > 2000) freezeMax(ui.workout, Date.now());
  afterChange();
}

/** Editors and session details keep nothing until Save, so ask before dropping edits. */
function confirmLeave() {
  if (!ui.dirty) return true;
  if (!window.confirm("Discard changes?")) return false;
  ui.dirty = false;
  return true;
}

function markDirty() {
  ui.dirty = true;
}

function nav(current) {
  const item = (id, label) => h("button", {
    type: "button",
    text: label,
    "aria-current": current === id ? "page" : false,
    onclick: () => {
      if (!confirmLeave()) return;
      ui.screen = id;
      ui.editor = null;
      ui.detailId = null;
      ui.modal = null;
      render();
    },
  });
  return h("nav", { class: "nav" }, item("home", "Workout"), item("progress", "Progress"), item("settings", "Settings"));
}

function banner() {
  const bits = [];
  if (ui.storageError) bits.push(h("div", { class: "banner", text: ui.storageError }));
  if (needsExportReminder(ui.data.settings, ui.data.sessions, Date.now())) {
    bits.push(h("div", { class: "banner" },
      h("p", { text: "Export your history. It lives only on this phone, and a new web address wipes it." }),
      h("button", { type: "button", class: "btn", text: "Export now", onclick: onExport }),
    ));
  }
  const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  if (!standalone && ui.screen === "home") {
    bits.push(h("p", { class: "muted small", text: "Safari: Share, then Add to Home Screen. The timer then fills the screen." }));
  }
  return bits;
}

function homeView() {
  const last = ui.data.sessions.filter((s) => s.status === "completed").sort((a, b) => b.startedAt - a.startedAt)[0];
  const active = liveSaved();
  let summary = h("p", { class: "muted small", text: "No sessions yet." });
  if (last) {
    const recordCount = (last.holds || []).filter((hold) => isRecord(hold, ui.data.sessions)).length;
    const holdCount = (last.holds || []).filter((hold) => hold.status !== "skipped").length;
    summary = h("button", {
      type: "button",
      class: "card",
      onclick: () => { ui.detailId = last.id; ui.screen = "progress"; render(); },
    },
      h("p", { class: "label", text: "Last session" }),
      h("p", { text: `${formatWhen(last.startedAt)} · ${holdCount} ${holdCount === 1 ? "hold" : "holds"}${recordCount ? ` · ${recordCount} ${recordCount === 1 ? "record" : "records"}` : ""}` }),
    );
  }
  const ready = activeExercises(ui.data.exercises).length > 0;
  const plan = activeExercises(ui.data.exercises);
  const rounds = ui.data.settings.rounds;
  return h("main", { class: "screen home" },
    h("header", { class: "masthead" },
      h("h1", { class: "brand", text: "Iso" }),
      h("p", { class: "tagline", text: "Isometric hold tracker" }),
    ),
    ...banner(),
    h("section", { class: "plan" },
      h("p", { class: "label", text: "Today's workout" }),
      h("p", { class: "plan-main", text: `${plan.length} ${plan.length === 1 ? "exercise" : "exercises"} · ${rounds} ${rounds === 1 ? "round" : "rounds"}` }),
      h("p", { class: "muted small", text: plan.map((ex) => ex.name).join(" · ") }),
    ),
    h("div", { class: "grow" }),
    summary,
    active
      ? h("button", { type: "button", class: "btn xl", text: "Resume workout", onclick: () => resumeSaved(active) })
      : h("button", { type: "button", class: "btn xl", text: "Start", disabled: !ready, onclick: onStart }),
    ready ? null : h("p", { class: "muted", text: "Turn on an exercise in Settings." }),
    active ? h("button", { type: "button", class: "btn secondary", text: "Finish and save", onclick: () => finishSaved(active) }) : null,
    nav("home"),
  );
}

function goalLines(step) {
  const prior = livePrior(ui.workout, step);
  const bits = [];
  if (step.mode === "max") {
    // Beat what you have actually done, not the stale starting target.
    bits.push(prior.best != null ? `Beat ${formatHold(prior.best)}` : `Max hold · aim for ${formatHold(step.targetSec)}`);
    if (prior.last != null && prior.last !== prior.best) bits.push(`Last ${formatHold(prior.last)}`);
  } else {
    bits.push(`Target ${formatHold(step.targetSec)}`);
    if (prior.last != null && prior.best != null) bits.push(`Last ${formatHold(prior.last)} · Best ${formatHold(prior.best)}`);
    else if (prior.best != null) bits.push(`Best ${formatHold(prior.best)}`);
    else bits.push("No history yet");
  }
  return h("div", { class: "stack" }, bits.map((line) => h("p", { class: "meta", text: line })));
}

function skipLabel() {
  if (ui.workout.phase === "switch") return "Skip right side";
  if (ui.workout.phase === "rest") return "Skip next exercise";
  return "Skip exercise";
}

function workoutFrame(body, { stop = false } = {}) {
  const paused = ui.workout.paused && ui.workout.phase !== "maxconfirm";
  return h("main", {
    class: `screen workout${paused ? " is-paused" : ""}${stop ? " stop" : ""}`,
    onclick: stop ? onStageClick : null,
  },
    h("div", { class: "spread" },
      h("button", { type: "button", class: "quiet", text: paused ? "Resume" : "Pause", onclick: onPause }),
      h("button", { type: "button", class: "quiet", text: "End", onclick: () => { ui.modal = { type: "end" }; render(); } }),
    ),
    ui.wakeWarning ? h("p", { class: "warn", text: ui.wakeWarning }) : null,
    h("div", { class: "stage" }, body),
    h("p", { class: "sr", "data-live": "1" }),
    h("div", { class: "bottom-actions" },
      paused
        ? h("button", { type: "button", class: "btn xl", text: "Resume", onclick: onPause })
        : h("div", { class: "row" },
          h("button", { type: "button", class: "quiet", text: "Back", onclick: onBack }),
          h("button", { type: "button", class: "quiet", text: skipLabel(), onclick: onSkip }),
        ),
    ),
  );
}

function workoutView() {
  const state = ui.workout;
  const step = currentStep(state);
  const progress = holdProgress(state);
  const now = Date.now();
  if (state.phase === "maxconfirm") return maxConfirmView(step);
  if (!step) return workoutFrame(h("p", { text: "Nothing left in this workout." }));

  if (state.phase === "switch") {
    const done = state.holds.at(-1);
    return workoutFrame([
      h("p", { class: "meta", text: `${step.name} · Round ${step.round}/${state.totalRounds}` }),
      done && done.status !== "skipped" ? h("p", { class: "ok", text: `Left: ${formatHold(done.actualSec)} ✓` }) : null,
      h("h1", { text: "Switch to" }),
      h("p", { class: "side-flag", text: "Right" }),
      clockFace(now, "neutral"),
    ]);
  }

  if (state.phase === "rest") {
    const next = peekNextHold(state);
    const logged = state.holds.at(-1);
    return workoutFrame([
      h("p", { class: "meta", text: "Rest" }),
      clockFace(now, "neutral"),
      loggedView(logged),
      next ? h("p", { class: "meta", text: `Next · Round ${next.round}/${state.totalRounds}` }) : null,
      next ? h("h1", { text: `${next.name}${next.mode === "max" ? " · MAX" : ""}` }) : null,
      next && next.side ? h("p", { class: "side-flag", text: sideName(next.side) }) : null,
      next ? cueList(next.cues) : null,
      h("button", { type: "button", class: "btn", text: "Skip rest", onclick: () => { skipRest(state, Date.now()); if (ui.data.settings.voiceOn) speak(phaseVoice(state)); afterChange(); } }),
      h("button", { type: "button", class: "quiet", text: ui.restMore ? "Less" : "More", onclick: () => { ui.restMore = !ui.restMore; render(); } }),
      ui.restMore ? h("div", { class: "stack" },
        h("button", { type: "button", class: "btn secondary", text: "Add 15 seconds", onclick: () => { addRest(state, 15); persistWorkout(); render(); } }),
        next ? nextEditor(next) : null,
      ) : null,
    ]);
  }

  const mode = state.phase === "hold" ? step.mode : "neutral";
  const title = state.phase === "prehold" ? "Get in position" : step.name;
  return workoutFrame([
    h("p", { class: "meta", text: `Round ${step.round}/${state.totalRounds} · Hold ${progress.current} of ${progress.total}` }),
    h("h1", { text: title }),
    state.phase === "prehold" ? h("p", { class: "meta", text: step.name }) : null,
    step.side ? h("p", { class: "side-flag", text: sideName(step.side) }) : null,
    clockFace(now, mode),
    goalLines(step),
    cueList(step.cues),
    state.phase === "hold" && step.mode !== "max"
      ? h("button", { type: "button", class: "btn danger", text: "I failed early", onclick: onFail })
      : null,
    state.phase === "hold" && step.mode === "max" && !state.paused
      ? h("button", { type: "button", class: "btn xl", text: "I'm done", onclick: finishMax })
      : null,
  ], { stop: state.phase === "hold" && step.mode === "max" && !state.paused });
}

function loggedView(logged) {
  if (!logged) return null;
  if (logged.status === "skipped") {
    return h("p", { class: "meta", text: `${logged.exerciseName}${logged.side ? ` ${sideName(logged.side)}` : ""} skipped` });
  }
  const label = `${logged.exerciseName}${logged.side ? ` ${sideName(logged.side)}` : ""} · ${formatHold(logged.actualSec)}`;
  return h("div", { class: "stack" },
    h("p", { text: label }),
    h("div", { class: "row" },
      h("button", { type: "button", class: "btn secondary", text: "−1 s", disabled: logged.actualSec <= MIN_HOLD_SEC, onclick: () => { adjustLast(ui.workout, -1); persistWorkout(); render(); } }),
      h("button", { type: "button", class: "btn secondary", text: "+1 s", onclick: () => { adjustLast(ui.workout, 1); persistWorkout(); render(); } }),
    ),
  );
}

function nextEditor(next) {
  return h("div", { class: "card stack" },
    h("p", { class: "small", text: `${next.name}: ${next.mode === "max" ? "Max" : `${next.targetSec} s`}. Changes every later round and future workouts.` }),
    h("div", { class: "row" },
      h("button", { type: "button", class: "btn secondary", text: "−5 s", onclick: () => nudgeNext(-5) }),
      h("button", { type: "button", class: "btn secondary", text: "+5 s", onclick: () => nudgeNext(5) }),
      h("button", { type: "button", class: "btn secondary", text: next.mode === "max" ? "Use target" : "Use max", onclick: flipNextMode }),
    ),
  );
}

function nudgeNext(delta) {
  const next = peekNextHold(ui.workout);
  if (!next) return;
  const target = Math.max(5, next.targetSec + delta);
  patchFutureHolds(ui.workout, next.exerciseId, { targetSec: target });
  const exercise = ui.data.exercises.find((item) => item.id === next.exerciseId);
  if (exercise) exercise.targetSec = target;
  persistExercises();
  afterChange();
}

function flipNextMode() {
  const next = peekNextHold(ui.workout);
  if (!next) return;
  const mode = next.mode === "max" ? "target" : "max";
  patchFutureHolds(ui.workout, next.exerciseId, { mode });
  const exercise = ui.data.exercises.find((item) => item.id === next.exerciseId);
  if (exercise) exercise.mode = mode;
  persistExercises();
  afterChange();
}

function maxConfirmView(step) {
  return h("main", { class: "screen workout" },
    h("p", { class: "meta", text: step ? step.name : "Hold" }),
    step?.side ? h("p", { class: "side-flag", text: sideName(step.side) }) : null,
    h("h1", { text: "Did you hold until now?" }),
    clockFace(Date.now(), "max"),
    ui.enterTime
      ? h("form", { class: "stack", onsubmit: onEnterTime },
        field("Seconds you held", h("input", { name: "held", type: "number", inputmode: "decimal", min: "0", step: "0.1", required: true, value: ui.workout.maxFrozenSec ?? 0 })),
        h("button", { class: "btn", type: "submit", text: "Log that time" }),
        h("button", { class: "btn secondary", type: "button", text: "Back", onclick: () => { ui.enterTime = false; render(); } }),
      )
      : h("div", { class: "stack" },
        h("button", { type: "button", class: "btn xl", text: "Yes", onclick: () => { confirmMax(ui.workout, Date.now(), ui.workout.maxFrozenSec || 0); afterChange(); } }),
        h("button", { type: "button", class: "btn secondary", text: "Enter time", onclick: () => { ui.enterTime = true; render(); } }),
      ),
  );
}

function onEnterTime(event) {
  event.preventDefault();
  const value = Number(new FormData(event.target).get("held"));
  if (!Number.isFinite(value)) return;
  confirmMax(ui.workout, Date.now(), value);
  ui.enterTime = false;
  afterChange();
}

function summaryView() {
  const state = ui.workout;
  const rounds = [];
  for (let round = 1; round <= state.totalRounds; round++) {
    const holds = state.holds.filter((hold) => hold.round === round);
    if (!holds.length) continue;
    rounds.push(h("section", { class: "stack" },
      h("h2", { text: `Round ${round}` }),
      holds.map((hold) => holdRow(hold)),
    ));
  }
  const maxLines = [];
  const seen = new Set();
  for (const hold of state.holds) {
    if (hold.mode !== "max" || seen.has(hold.exerciseId)) continue;
    seen.add(hold.exerciseId);
    const stats = maxSummary(state.holds, hold.exerciseId) || [];
    for (const stat of stats) {
      maxLines.push(h("p", { class: "meta", text: `${hold.exerciseName}${stat.side ? ` ${sideName(stat.side)}` : ""} · best ${formatHold(stat.best)} · last ${formatHold(stat.last)} · avg ${formatHold(stat.avg)}` }));
    }
  }
  const proposals = proposalsFor(state, ui.data.exercises, allSessions());
  return h("main", { class: "screen" },
    h("h1", { text: "Session" }),
    h("p", { class: "muted", text: formatWhen(state.startedAt) }),
    ...rounds,
    maxLines.length ? h("section", { class: "stack" }, h("h2", { text: "Max holds" }), maxLines) : null,
    proposals.length ? h("section", { class: "stack" }, h("h2", { text: "Next time" }), proposals.map(proposalCard)) : null,
    h("label", { class: "field" }, "Session note",
      h("textarea", {
        name: "note",
        maxlength: "500",
        placeholder: "Left knee sore",
        text: state.note || "",
        oninput: (event) => { state.note = event.target.value.slice(0, 500); persistWorkout(); },
      }),
    ),
    h("div", { class: "savebar stack" },
      h("button", { type: "button", class: "btn xl", text: "Done", onclick: onSaveSession }),
      h("div", { class: "row" },
        h("button", { type: "button", class: "quiet", text: "Redo last hold", onclick: onBack }),
        h("button", { type: "button", class: "quiet", text: "Discard session", onclick: () => { ui.modal = { type: "discard" }; render(); } }),
      ),
    ),
  );
}

function holdRow(hold) {
  const record = isRecord(hold, allSessions());
  const prev = matchHold(previousCompleted(allSessions(), ui.workout), hold);
  let compare = "First time";
  if (hold.status === "skipped") compare = "Skipped";
  else if (hold.status === "failed_early" && hold.mode !== "max") compare = "Ended early";
  if (prev && hold.actualSec != null && prev.actualSec != null) {
    const delta = Math.round((hold.actualSec - prev.actualSec) * 10) / 10;
    compare = `${delta > 0 ? "+" : ""}${delta.toFixed(1)} s vs last`;
  }
  const time = formatHold(hold.actualSec);
  return h("div", { class: record ? "hold record" : "hold" },
    h("div", { class: "spread" },
      h("span", { text: `${hold.exerciseName}${hold.side ? ` · ${sideName(hold.side)}` : ""}` }),
      h("strong", { text: time }),
    ),
    h("p", { class: record ? "gold small" : "muted small", text: record ? `Record · ${compare}` : compare }),
  );
}

function proposalCard(proposal) {
  const choice = ui.workout.decisions[proposal.exerciseId] || null;
  const text = proposal.type === "raise"
    ? `${proposal.name} hit every hold. Next target ${proposal.to} s.`
    : `${proposal.name} ended early two sessions in a row. Drop the target to ${proposal.to} s, or keep ${proposal.from} s.`;
  const accept = proposal.type === "raise" ? "Accept" : "Drop 5 seconds";
  const reject = proposal.type === "raise" ? "Reject" : "Keep";
  return h("div", { class: "proposal stack" },
    h("p", { text }),
    h("div", { class: "row" },
      h("button", { type: "button", class: choice === "accept" ? "btn" : "btn secondary", text: accept, onclick: () => choose(proposal, "accept") }),
      h("button", { type: "button", class: choice === "reject" ? "btn" : "btn secondary", text: reject, onclick: () => choose(proposal, "reject") }),
    ),
  );
}

function choose(proposal, choice) {
  setDecision(ui.workout, proposal.exerciseId, choice);
  ui.workout.decisions[proposal.exerciseId] = choice;
  persistWorkout();
  render();
}

async function onSaveSession() {
  const proposals = proposalsFor(ui.workout, ui.data.exercises, allSessions()).map((proposal) => ({
    ...proposal,
    choice: ui.workout.decisions[proposal.exerciseId] || null,
  }));
  ui.data.exercises = applyAccepted(ui.data.exercises, proposals);
  ui.workout.status = "completed";
  ui.workout.endedAt = Date.now();
  ui.workout.phase = "summary";
  await persistExercises();
  await persistWorkout();
  releaseLock();
  releaseWake();
  ui.screen = "home";
  ui.workout = null;
  render();
}

function progressView() {
  const tabs = [
    ["chart", "Chart"],
    ["records", "Records"],
    ["history", "History"],
    ["weeks", "Weeks"],
  ];
  return h("main", { class: "screen" },
    h("h1", { text: "Progress" }),
    h("div", { class: "tabs", role: "tablist" }, tabs.map(([id, label]) => h("button", {
      type: "button",
      role: "tab",
      text: label,
      "aria-selected": ui.progressTab === id ? "true" : "false",
      onclick: () => { if (!confirmLeave()) return; ui.progressTab = id; ui.detailId = null; render(); },
    }))),
    ui.detailId ? detailView() : panel(),
    nav("progress"),
  );
}

function panel() {
  if (ui.progressTab === "records") return recordsView();
  if (ui.progressTab === "history") return historyView();
  if (ui.progressTab === "weeks") return weeksView();
  return chartView();
}

function chartView() {
  const list = orderedExercises();
  if (!ui.chartId || !list.some((ex) => ex.id === ui.chartId)) ui.chartId = list[0]?.id || null;
  const exercise = list.find((ex) => ex.id === ui.chartId);
  return h("div", { class: "stack" },
    h("label", { class: "field" }, "Exercise",
      h("select", {
        onchange: (event) => { ui.chartId = event.target.value; render(); },
      }, list.map((ex) => h("option", { value: ex.id, selected: ex.id === ui.chartId ? true : false, text: ex.archived ? `${ex.name} (archived)` : ex.name }))),
    ),
    h("div", { class: "chart-wrap" }, h("canvas", { "data-chart": "1" })),
    h("p", { class: "muted", "data-chart-empty": "1", hidden: true, text: "Complete a session to see this." }),
    exercise?.unilateral
      ? h("p", { class: "legend" }, h("span", {}, h("i", { class: "swatch", style: "background:#f3efe4" }), "Left"), h("span", {}, h("i", { class: "swatch", style: "background:#ff7a1a" }), "Right"))
      : null,
    h("p", { class: "muted small", text: exercise?.mode === "max" ? "Each point is the best round that session. An X ended early." : "Completed holds sit on the time you held. An X ended early." }),
  );
}

function recordsView() {
  const rows = records(orderedExercises(), ui.data.sessions);
  if (!rows.some((row) => row.best != null)) return h("p", { class: "muted", text: "No records yet." });
  return h("div", { class: "stack" }, rows.map((row) => h("div", { class: "spread card" },
    h("span", { text: `${row.name}${row.side ? ` · ${sideName(row.side)}` : ""}` }),
    h("strong", { text: row.best == null ? "No hold yet" : `${formatHold(row.best)} · ${formatWhen(row.at)}` }),
  )));
}

function historyView() {
  const sessions = ui.data.sessions
    .filter((s) => s.holds?.length)
    .slice()
    .sort((a, b) => b.startedAt - a.startedAt);
  if (!sessions.length) return h("p", { class: "muted", text: "No sessions yet." });
  return h("div", { class: "stack" }, sessions.map((session) => h("button", {
    type: "button",
    class: "card",
    onclick: () => { ui.detailId = session.id; render(); },
  },
    h("p", { text: formatWhen(session.startedAt) }),
    h("p", { class: "muted small", text: `${session.holds.filter((hold) => hold.status !== "skipped").length} holds${session.status === "in_progress" ? " · in progress" : ""}` }),
  )));
}

function weeksView() {
  const buckets = weeks(ui.data.sessions, Date.now());
  const max = Math.max(1, ...buckets.map((bucket) => bucket.count));
  return h("div", { class: "stack" },
    h("p", { class: "muted", text: "Sessions per week, last 8 weeks." }),
    h("div", { class: "bars" }, buckets.map((bucket) => h("div", { class: "bar" },
      h("span", { text: String(bucket.count) }),
      h("i", { style: `height:${Math.max(2, (bucket.count / max) * 110)}px` }),
      h("span", { text: new Date(bucket.start).toLocaleDateString("en-US", { month: "short", day: "numeric" }) }),
    ))),
  );
}

function detailView() {
  const session = ui.data.sessions.find((item) => item.id === ui.detailId);
  if (!session) return h("p", { text: "That session is gone." });
  if (session.status === "in_progress") {
    return h("div", { class: "stack" },
      h("p", { text: "This workout is still open." }),
      h("button", { type: "button", class: "btn", text: "Resume workout", onclick: () => resumeSaved(session) }),
      h("button", { type: "button", class: "btn secondary", text: "Back", onclick: () => { ui.detailId = null; render(); } }),
    );
  }
  return h("form", { class: "stack", onsubmit: saveDetail, oninput: markDirty, onchange: markDirty },
    h("h2", { text: formatWhen(session.startedAt) }),
    session.holds.map((hold) => h("label", { class: "field" },
      `${hold.exerciseName}${hold.side ? ` · ${sideName(hold.side)}` : ""} · round ${hold.round} · ${hold.status === "failed_early" && hold.mode !== "max" ? "ended early" : hold.status === "skipped" ? "skipped" : "done"}`,
      hold.status === "skipped"
        ? h("p", { class: "muted", text: "Skipped" })
        : h("input", { name: `hold-${hold.id}`, type: "number", inputmode: "decimal", min: "0", step: "0.1", value: hold.actualSec }),
    )),
    field("Note", h("textarea", { name: "note", maxlength: "500", text: session.note || "" })),
    h("button", { class: "btn", type: "submit", text: "Save changes" }),
    h("button", { class: "btn danger", type: "button", text: "Delete session", onclick: () => { ui.modal = { type: "delete", id: session.id }; render(); } }),
    h("button", { class: "btn secondary", type: "button", text: "Back", onclick: () => { if (confirmLeave()) { ui.detailId = null; render(); } } }),
  );
}

function saveDetail(event) {
  event.preventDefault();
  const session = ui.data.sessions.find((item) => item.id === ui.detailId);
  if (!session) return;
  const data = new FormData(event.target);
  session.note = String(data.get("note") || "").slice(0, 500);
  for (const hold of session.holds) {
    const raw = data.get(`hold-${hold.id}`);
    if (raw == null || hold.status === "skipped") continue;
    setHoldActual(session, hold.id, Number(raw));
  }
  saveSession(session).catch(storageFail);
  ui.dirty = false;
  ui.detailId = null;
  render();
}

function field(label, control) {
  return h("label", { class: "field" }, label, control);
}

function settingsView() {
  if (ui.editor) return editorView();
  const settings = ui.data.settings;
  const active = orderedExercises().filter((ex) => !ex.archived);
  const archived = orderedExercises().filter((ex) => ex.archived);
  return h("main", { class: "screen" },
    h("h1", { text: "Settings" }),
    h("div", { class: "stack" },
      numSetting("Rounds", settings.rounds, 1, 10, (value) => persistSettings({ rounds: value }).then(render)),
      numSetting("Rest seconds", settings.restSec, 0, 300, (value) => persistSettings({ restSec: value }).then(render)),
      numSetting("Switch break seconds", settings.switchSec, 0, 120, (value) => persistSettings({ switchSec: value }).then(render)),
      numSetting("Get in position seconds", settings.countdownSec, 0, 30, (value) => persistSettings({ countdownSec: value }).then(render)),
    ),
    h("h2", { text: "Exercises" }),
    h("div", { id: "exercise-list" }, active.map((ex) => exerciseRow(ex))),
    h("button", { type: "button", class: "btn secondary", text: "Add exercise", onclick: () => { ui.editor = "new"; render(); } }),
    archived.length ? h("h2", { text: "Archived" }) : null,
    archived.map((ex) => h("div", { class: "spread" },
      h("span", { text: ex.name }),
      h("button", { type: "button", class: "quiet", text: "Restore", onclick: () => restoreExercise(ex.id) }),
    )),
    h("h2", { text: "Sound" }),
    check("Tones", settings.audioOn, (on) => persistSettings({ audioOn: on })),
    check("Voice", settings.voiceOn, (on) => persistSettings({ voiceOn: on })),
    field("Volume", h("input", {
      type: "range", min: "0", max: "1", step: "0.05", value: settings.volume,
      oninput: (event) => { ui.data.settings.volume = Number(event.target.value); setVolume(ui.data.settings.volume); },
      onchange: () => persistSettings({ volume: ui.data.settings.volume }),
    })),
    h("button", { type: "button", class: "btn secondary", text: "Play test tone", onclick: playTest }),
    h("p", { class: "muted small", text: "On iPhone, the silent switch can mute these tones." }),
    h("h2", { text: "Change this app" }),
    h("p", { class: "muted", text: "Want a change? Copy this link, paste it into an AI chat (Claude, ChatGPT, Gemini), and say what you want." }),
    h("p", { class: "code-url", text: REPO_URL }),
    h("button", { type: "button", class: "btn", text: "Copy link", onclick: copyRepoUrl }),
    h("h2", { text: "Backup" }),
    h("p", { class: "muted", text: "History stays on this phone." }),
    h("button", { type: "button", class: "btn", text: "Export JSON", onclick: onExport }),
    h("button", { type: "button", class: "btn secondary", text: "Export CSV", onclick: onCsv }),
    h("input", { id: "import-file", class: "sr", type: "file", accept: "application/json,.json", onchange: onImportPick }),
    h("button", { type: "button", class: "btn secondary", text: "Import backup", onclick: () => document.getElementById("import-file").click() }),
    h("h2", { text: "Reset" }),
    field("Type RESET to enable", h("input", { id: "reset-word", autocomplete: "off", oninput: (event) => { const button = document.getElementById("reset-go"); if (button) button.disabled = event.target.value !== "RESET"; } })),
    h("button", { id: "reset-go", type: "button", class: "btn danger", disabled: true, text: "Reset all data", onclick: onReset }),
    nav("settings"),
  );
}

function numSetting(label, value, min, max, onValue) {
  return field(label, h("input", {
    type: "number", inputmode: "numeric", min: String(min), max: String(max), step: "1", value,
    onchange: (event) => onValue(clampInt(event.target.value, min, max, value)),
  }));
}

function check(label, on, toggle) {
  return h("label", { class: "check" },
    h("input", { type: "checkbox", checked: on ? true : false, onchange: (event) => toggle(event.target.checked).then(render) }),
    label,
  );
}

function exerciseRow(ex) {
  const row = h("div", { class: ex.enabled ? "ex-row" : "ex-row off", "data-id": ex.id },
    h("button", { type: "button", class: "drag", "aria-label": `Reorder ${ex.name}`, onkeydown: (event) => onReorderKey(event, ex.id) }, h("span", { class: "grip", "aria-hidden": "true" })),
    h("button", { type: "button", class: "ex-name", text: ex.name, onclick: () => { ui.editor = ex.id; render(); } }),
    h("span", { class: "muted small", text: ex.mode === "max" ? "Max" : `${ex.targetSec}s` }),
  );
  const handle = row.querySelector(".drag");
  handle.addEventListener("pointerdown", (event) => startDrag(event, row));
  return row;
}

function onReorderKey(event, id) {
  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
  event.preventDefault();
  moveExercise(id, event.key === "ArrowUp" ? -1 : 1);
}

function moveExercise(id, direction) {
  const active = orderedExercises().filter((ex) => !ex.archived);
  const index = active.findIndex((ex) => ex.id === id);
  const swap = active[index + direction];
  if (!swap) return;
  const mine = ui.data.exercises.find((ex) => ex.id === id);
  const other = ui.data.exercises.find((ex) => ex.id === swap.id);
  const order = mine.order;
  mine.order = other.order;
  other.order = order;
  persistExercises();
  render();
}

function startDrag(event, row) {
  event.preventDefault();
  row.classList.add("dragging");
  const move = (ev) => {
    const rows = [...row.parentElement.querySelectorAll(".ex-row:not(.dragging)")];
    const after = rows.find((item) => ev.clientY < item.getBoundingClientRect().top + item.offsetHeight / 2);
    row.parentElement.insertBefore(row, after || null);
  };
  const up = () => {
    row.classList.remove("dragging");
    [...row.parentElement.querySelectorAll(".ex-row")].forEach((item, order) => {
      const exercise = ui.data.exercises.find((ex) => ex.id === item.dataset.id);
      if (exercise) exercise.order = order;
    });
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    persistExercises();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

function editorView() {
  const existing = ui.editor === "new" ? null : ui.data.exercises.find((ex) => ex.id === ui.editor);
  if (ui.editor !== "new" && !existing) {
    ui.editor = null;
    return settingsView();
  }
  return h("main", { class: "screen" },
    h("h1", { text: existing ? existing.name : "New exercise" }),
    h("form", { class: "stack", novalidate: true, onsubmit: (event) => saveEditor(event, existing), oninput: markDirty, onchange: markDirty },
      h("p", { class: "warn", id: "editor-error", role: "alert", hidden: true }),
      field("Name", h("input", { name: "name", required: true, maxlength: "80", value: existing?.name || "" })),
      field("Cue 1", h("input", { name: "cue1", maxlength: "120", value: existing?.cues?.[0] || "" })),
      field("Cue 2", h("input", { name: "cue2", maxlength: "120", value: existing?.cues?.[1] || "" })),
      field("Cue 3", h("input", { name: "cue3", maxlength: "120", value: existing?.cues?.[2] || "" })),
      h("div", { class: "segment" },
        modeChoice("target", "Target", !existing || existing.mode !== "max"),
        modeChoice("max", "Max", existing?.mode === "max"),
      ),
      field("Target seconds", h("input", { name: "target", type: "number", inputmode: "numeric", min: "1", max: "600", step: "1", required: true, value: existing?.targetSec ?? 20 })),
      field("Add this many seconds after a clean session", h("input", { name: "increment", type: "number", inputmode: "numeric", min: "1", max: "60", step: "1", required: true, value: existing?.incrementSec ?? 5 })),
      h("label", { class: "check" }, h("input", { type: "checkbox", name: "unilateral", checked: existing?.unilateral ? true : false }), "Unilateral, left then right"),
      h("label", { class: "check" }, h("input", { type: "checkbox", name: "enabled", checked: existing ? existing.enabled : true }), "Enabled"),
      h("button", { class: "btn", type: "submit", text: "Save exercise" }),
    ),
    existing ? h("button", { type: "button", class: "btn danger", text: hasHistory(existing.id) ? "Archive" : "Delete", onclick: () => archiveExercise(existing.id) }) : null,
    h("button", { type: "button", class: "btn secondary", text: "Back", onclick: () => { if (confirmLeave()) { ui.editor = null; render(); } } }),
    nav("settings"),
  );
}

function modeChoice(value, label, checked) {
  return h("label", {}, h("input", { type: "radio", name: "mode", value, checked: checked ? true : false }), label);
}

function hasHistory(id) {
  return ui.data.sessions.some((session) => (session.holds || []).some((hold) => hold.exerciseId === id));
}

function saveEditor(event, existing) {
  event.preventDefault();
  const form = event.target;
  if (!form.name.value.trim()) {
    // Show the message in place so a re-render doesn't wipe what was typed.
    const note = document.getElementById("editor-error");
    note.textContent = "Name required.";
    note.hidden = false;
    form.name.focus();
    return;
  }
  const order = existing ? existing.order : Math.max(-1, ...ui.data.exercises.map((ex) => ex.order)) + 1;
  const made = newExercise({
    id: existing?.id || uid(),
    name: form.name.value,
    cues: [form.cue1.value, form.cue2.value, form.cue3.value],
    mode: form.mode.value,
    targetSec: form.target.value,
    incrementSec: form.increment.value,
    unilateral: form.unilateral.checked,
    enabled: form.enabled.checked,
  }, order);
  if (existing) {
    const index = ui.data.exercises.findIndex((ex) => ex.id === existing.id);
    ui.data.exercises[index] = made;
  } else ui.data.exercises.push(made);
  ui.editor = null;
  ui.dirty = false;
  persistExercises();
  render();
}

function archiveExercise(id) {
  ui.data.exercises = removeExercise(ui.data.exercises, ui.data.sessions, id);
  ui.editor = null;
  persistExercises();
  render();
}

function restoreExercise(id) {
  const exercise = ui.data.exercises.find((ex) => ex.id === id);
  if (!exercise) return;
  exercise.archived = false;
  exercise.enabled = true;
  exercise.order = Math.max(-1, ...ui.data.exercises.map((ex) => ex.order)) + 1;
  persistExercises();
  render();
}

async function copyRepoUrl(event) {
  const button = event.currentTarget;
  try {
    await navigator.clipboard.writeText(REPO_URL);
  } catch {
    // Older browsers and insecure pages: select a temporary field and copy from it.
    const field = h("textarea", { class: "sr", readonly: true });
    field.value = REPO_URL;
    document.body.append(field);
    field.select();
    document.execCommand("copy");
    field.remove();
  }
  button.textContent = "Copied ✓";
  setTimeout(() => { button.textContent = "Copy link"; }, 2000);
}

function playTest() {
  unlock();
  setVolume(ui.data.settings.volume);
  beep("tick");
  setTimeout(() => beep("half"), 180);
  setTimeout(() => beep("done"), 380);
  if (ui.data.settings.voiceOn) speak("Rest");
}

async function onExport() {
  const now = Date.now();
  const payload = exportPayload(ui.data.settings, ui.data.exercises, ui.data.sessions, now);
  download(`iso-${sessionDay(now)}.json`, JSON.stringify(payload, null, 2), "application/json");
  await persistSettings({ lastExportAt: now });
  render();
}

async function onCsv() {
  const now = Date.now();
  download(`iso-${sessionDay(now)}.csv`, historyCsv(ui.data.sessions), "text/csv");
  await persistSettings({ lastExportAt: now });
  render();
}

async function onImportPick(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  const parsed = parseBackup(await file.text());
  if (!parsed.ok) {
    ui.modal = { type: "message", text: parsed.error };
    render();
    return;
  }
  ui.pendingImport = parsed.data;
  ui.modal = { type: "import" };
  render();
}

async function applyImport() {
  const data = ui.pendingImport;
  if (!data) return;
  await enqueue(() => replaceAll(data));
  ui.data = data;
  ui.pendingImport = null;
  ui.workout = null;
  ui.modal = null;
  releaseLock();
  ui.screen = "home";
  render();
}

async function onReset() {
  const word = document.getElementById("reset-word")?.value;
  if (word !== "RESET") return;
  const settings = { ...DEFAULT_SETTINGS };
  const exercises = SEED_EXERCISES.map((ex) => ({ ...ex, cues: [...ex.cues] }));
  await enqueue(() => replaceAll({ settings, exercises, sessions: [] }));
  ui.data = { settings, exercises, sessions: [] };
  ui.workout = null;
  ui.editor = null;
  releaseLock();
  ui.screen = "home";
  render();
}

function modalView() {
  if (!ui.modal) return null;
  const type = ui.modal.type;
  let body = null;
  if (type === "resume") {
    const session = ui.modal.session;
    const step = session.steps?.[session.index];
    body = [
      h("h2", { text: "Resume workout?" }),
      h("p", { text: step ? `${step.name}${step.side ? ` · ${sideName(step.side)}` : ""} · round ${step.round}` : "Pick up where you left off." }),
      h("button", { type: "button", class: "btn", text: "Resume", onclick: () => resumeSaved(session) }),
      h("button", { type: "button", class: "btn secondary", text: "Finish and save", onclick: () => finishSaved(session) }),
      h("button", { type: "button", class: "btn secondary", text: "Not now", onclick: () => { ui.modal = null; render(); } }),
    ];
  } else if (type === "end") {
    body = [
      h("h2", { text: "End workout?" }),
      h("p", { text: "Holds you already finished stay in the log." }),
      h("button", { type: "button", class: "btn danger", text: "End workout", onclick: () => { endEarly(ui.workout, Date.now()); ui.modal = null; afterChange(); } }),
      h("button", { type: "button", class: "btn secondary", text: "Keep going", onclick: () => { ui.modal = null; render(); } }),
    ];
  } else if (type === "discard") {
    body = [
      h("h2", { text: "Discard this session?" }),
      h("p", { text: "None of its holds will be kept." }),
      h("button", { type: "button", class: "btn danger", text: "Discard", onclick: dropWorkout }),
      h("button", { type: "button", class: "btn secondary", text: "Keep it", onclick: () => { ui.modal = null; render(); } }),
    ];
  } else if (type === "blocked") {
    body = [
      h("h2", { text: "This workout is open in another tab." }),
      h("button", { type: "button", class: "btn", text: "Try again", onclick: () => { ui.modal = null; render(); } }),
    ];
  } else if (type === "import") {
    body = [
      h("h2", { text: "Replace everything on this phone with this backup?" }),
      h("button", { type: "button", class: "btn", text: "Replace", onclick: () => applyImport().catch(storageFail) }),
      h("button", { type: "button", class: "btn secondary", text: "Cancel", onclick: () => { ui.pendingImport = null; ui.modal = null; render(); } }),
    ];
  } else if (type === "delete") {
    body = [
      h("h2", { text: "Delete this session?" }),
      h("button", { type: "button", class: "btn danger", text: "Delete", onclick: () => removeSession(ui.modal.id) }),
      h("button", { type: "button", class: "btn secondary", text: "Cancel", onclick: () => { ui.modal = null; render(); } }),
    ];
  } else {
    body = [
      h("p", { text: ui.modal.text || "" }),
      h("button", { type: "button", class: "btn", text: "OK", onclick: () => { ui.modal = null; render(); } }),
    ];
  }
  return h("div", { class: "modal-back" }, h("div", { class: "modal", role: "dialog", "aria-modal": "true" }, body));
}

async function removeSession(id) {
  ui.data.sessions = ui.data.sessions.filter((session) => session.id !== id);
  ui.detailId = null;
  ui.modal = null;
  try { await enqueue(() => deleteSession(id)); } catch { storageFail(); }
  render();
}

function render() {
  const root = document.getElementById("app");
  // A new view opens at the top, not wherever the last one was scrolled.
  const viewKey = `${ui.screen}|${ui.editor}|${ui.detailId}|${ui.progressTab}`;
  if (viewKey !== ui.viewKey) {
    ui.viewKey = viewKey;
    ui.dirty = false;
    window.scrollTo(0, 0);
  }
  if (ui.workout?.phase !== "rest") ui.restMore = false;
  const view = ui.screen === "workout" && ui.workout
    ? workoutView()
    : ui.screen === "summary" && ui.workout
      ? summaryView()
      : ui.screen === "progress"
        ? progressView()
        : ui.screen === "settings"
          ? settingsView()
          : homeView();
  root.replaceChildren(h("div", { class: "app" }, view, modalView()));
  if (clockRuns()) startRaf();
  else stopRaf();
  if (ui.screen === "progress" && ui.progressTab === "chart" && !ui.detailId) {
    requestAnimationFrame(() => {
      const canvas = document.querySelector("[data-chart]");
      const exercise = orderedExercises().find((ex) => ex.id === ui.chartId);
      if (!canvas || !exercise) return;
      const ok = drawChart(canvas, exercise, ui.data.sessions);
      canvas.hidden = !ok;
      const empty = document.querySelector("[data-chart-empty]");
      if (empty) empty.hidden = ok;
    });
  }
}

function freshSeed() {
  return {
    settings: { ...DEFAULT_SETTINGS },
    exercises: SEED_EXERCISES.map((ex) => ({ ...ex, cues: [...ex.cues] })),
    sessions: [],
  };
}

async function boot() {
  ui.tabId = uid();
  try {
    const loaded = await loadAll();
    if (!loaded.exercises.length) {
      ui.data = freshSeed();
      await saveExercises(ui.data.exercises);
      await saveSettings(ui.data.settings);
    } else {
      ui.data = {
        settings: { ...DEFAULT_SETTINGS, ...loaded.settings },
        exercises: loaded.exercises,
        sessions: loaded.sessions,
      };
    }
  } catch {
    ui.storageError = "This browser blocked storage. A workout will disappear if you close the tab.";
    ui.data = freshSeed();
  }
  setVolume(ui.data.settings.volume);
  const active = liveSaved();
  if (active) ui.modal = { type: "resume", session: active };
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("beforeunload", (event) => {
    if (ui.workout && ui.screen === "workout" && ui.workout.phase !== "summary") {
      event.preventDefault();
      event.returnValue = "";
    }
  });
  document.addEventListener("pointerdown", () => unlock(), { capture: true });
  if (new URLSearchParams(location.search).get("e2e") === "1") {
    window.__iso = { get data() { return ui.data; }, get workout() { return ui.workout; } };
  }
  render();
}

boot();
