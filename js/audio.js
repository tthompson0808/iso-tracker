let ctx = null;
let volume = 0.8;

export function setVolume(value) {
  volume = Math.min(1, Math.max(0, Number(value) || 0));
}

export function unlock() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    if (!ctx) ctx = new AC();
    if (ctx.state === "suspended") ctx.resume();
    return ctx.state === "running" || ctx.state === "suspended";
  } catch {
    return false;
  }
}

function tone(freq, dur, type = "sine", at = 0, level = 0.22) {
  if (!ctx || volume <= 0) return;
  const t = ctx.currentTime + at;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, level * volume), t + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(t);
  osc.stop(t + dur + 0.03);
}

export function beep(name) {
  if (name === "tick") tone(880, 0.09);
  else if (name === "warn") tone(494, 0.18, "triangle", 0, 0.2);
  else if (name === "half") tone(659, 0.16, "triangle");
  else if (name === "pass") tone(740, 0.14);
  else if (name === "best") {
    tone(988, 0.12);
    tone(1319, 0.18, "sine", 0.11, 0.2);
  } else if (name === "done") {
    tone(523, 0.1);
    tone(784, 0.18, "sine", 0.09, 0.2);
  }
}

export function speak(text) {
  try {
    if (!text || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = 1.02;
    window.speechSynthesis.speak(utter);
  } catch {
    /* Voice is optional. A missing speech engine must not stop the clock. */
  }
}

export function buzz(ms = 12) {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* iOS Safari ignores vibration. Tones carry the cue. */
  }
}
