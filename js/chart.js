import { chartSeries } from "./progress.js";
import { formatDay } from "./time.js";

const INK = "#f3efe4";
const MUTED = "#c8bfb0";
const LINE = "#3a372f";
const ORANGE = "#ff7a1a";
const FAIL = "#ff5a3c";

export function drawChart(canvas, exercise, sessions) {
  const series = chartSeries(exercise, sessions);
  const keys = Object.keys(series).filter((k) => series[k].length);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = canvas.clientWidth || 320;
  const height = canvas.clientHeight || 220;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const g = canvas.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, width, height);
  if (!keys.length) return false;

  const points = keys.flatMap((k) => series[k]);
  const maxY = Math.max(10, ...points.map((p) => Math.max(p.seconds, p.target || 0)));
  const minX = Math.min(...points.map((p) => p.at));
  const maxX = Math.max(...points.map((p) => p.at));
  const pad = { l: 36, r: 12, t: 16, b: 28 };
  const plotW = width - pad.l - pad.r;
  const plotH = height - pad.t - pad.b;
  const xOf = (at) => pad.l + (maxX === minX ? plotW / 2 : ((at - minX) / (maxX - minX)) * plotW);
  const yOf = (sec) => pad.t + (1 - sec / (maxY * 1.1)) * plotH;

  g.strokeStyle = LINE;
  g.lineWidth = 1;
  g.font = "12px Outfit, sans-serif";
  g.fillStyle = MUTED;
  for (const frac of [0, 0.5, 1]) {
    const sec = maxY * 1.1 * frac;
    const y = yOf(sec);
    g.beginPath();
    g.moveTo(pad.l, y);
    g.lineTo(width - pad.r, y);
    g.stroke();
    g.fillText(String(Math.round(sec)), 0, y + 4);
  }

  const colors = { none: INK, L: INK, R: ORANGE };
  for (const key of keys) {
    const rows = series[key];
    g.strokeStyle = colors[key] || INK;
    g.lineWidth = 2;
    g.beginPath();
    rows.forEach((p, i) => {
      const x = xOf(p.at);
      const y = yOf(p.seconds);
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    });
    g.stroke();
    for (const p of rows) {
      const x = xOf(p.at);
      const y = yOf(p.seconds);
      if (p.failed) {
        g.strokeStyle = FAIL;
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(x - 5, y - 5);
        g.lineTo(x + 5, y + 5);
        g.moveTo(x + 5, y - 5);
        g.lineTo(x - 5, y + 5);
        g.stroke();
      } else {
        g.fillStyle = colors[key] || INK;
        g.beginPath();
        g.arc(x, y, 4, 0, Math.PI * 2);
        g.fill();
      }
    }
  }

  g.fillStyle = MUTED;
  g.fillText(formatDay(minX), pad.l, height - 8);
  if (maxX !== minX) {
    const label = formatDay(maxX);
    g.fillText(label, width - pad.r - g.measureText(label).width, height - 8);
  }
  return true;
}
