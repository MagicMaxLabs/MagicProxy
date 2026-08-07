// Toolbar icon with a status dot drawn into the bottom-right corner.
//
// Why not chrome.action.setBadgeText: the badge renders TEXT on a coloured pill.
// "ON" is wide and blunt — it covered roughly a third of a 16px icon. Drawing the
// icon ourselves lets the state read as a small indicator light instead of a label.
//
// SIZING IS CONSTRAINED BY THE ARTWORK, not by taste. The mark is two neutral
// strokes plus an accent curve that leaves the bottom-left and sweeps up to the
// top-right; on the 16px variant that curve passes through roughly (9.3, 8.8).
// A dot large enough to reach it turns the mark into an unrecognisable blob, so the
// radius below is chosen to clear the curve with ~1.5px to spare. If the artwork
// ever changes, re-check that clearance before changing these numbers.
const DOT = {
  16: { r: 3.2, cx: 12.4, cy: 12.4, highlight: false },
  32: { r: 6.4, cx: 24.8, cy: 24.8, highlight: true },
};

const SIZES = [16, 32];

// Bitmaps are decoded once: the worker redraws on every state change, every
// wake-up and every pulse frame, and re-fetching the PNGs each time is pure waste.
const bitmapCache = new Map();

async function baseBitmap(size) {
  if (bitmapCache.has(size)) return bitmapCache.get(size);
  const bmp = await createImageBitmap(
    await (await fetch(chrome.runtime.getURL(`assets/icon${size}.png`))).blob()
  );
  bitmapCache.set(size, bmp);
  return bmp;
}

const COLORS = {
  on: { core: "#4ade80", edge: "#15803d" },
  off: { core: "#f87171", edge: "#991b1b" },
  error: { core: "#fbbf24", edge: "#b45309" },
};

/**
 * Dark rim for contrast on any toolbar colour, radial fill lit from the top-left,
 * and (above 16px) a specular highlight. That trio is what makes a flat circle
 * read as a physical indicator light rather than a coloured pixel.
 *
 * @param {number} opacity 0..1 — used by the connecting pulse.
 */
function drawDot(ctx, size, state, opacity = 1) {
  const c = COLORS[state] || COLORS.off;
  const d = DOT[size];
  ctx.save();
  ctx.globalAlpha = opacity;

  ctx.beginPath();
  ctx.arc(d.cx, d.cy, d.r, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fill();

  const g = ctx.createRadialGradient(
    d.cx - d.r * 0.35, d.cy - d.r * 0.35, d.r * 0.1,
    d.cx, d.cy, d.r * 0.92
  );
  g.addColorStop(0, c.core);
  g.addColorStop(1, c.edge);
  ctx.beginPath();
  ctx.arc(d.cx, d.cy, d.r * 0.78, 0, Math.PI * 2);
  ctx.fillStyle = g;
  ctx.fill();

  if (d.highlight) {
    ctx.beginPath();
    ctx.arc(d.cx - d.r * 0.28, d.cy - d.r * 0.3, d.r * 0.2, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.fill();
  }
  ctx.restore();
}

async function renderFrame(state, opacity) {
  const imageData = {};
  for (const size of SIZES) {
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(await baseBitmap(size), 0, 0, size, size);
    drawDot(ctx, size, state, opacity);
    imageData[size] = ctx.getImageData(0, 0, size, size);
  }
  await chrome.action.setIcon({ imageData });
}

// Any new state request invalidates a pulse still in flight, so a run that is on
// its way out cannot repaint over the state that replaced it.
let generation = 0;

/** @param {"on"|"off"|"error"} state */
export async function setStatusIcon(state) {
  const mine = ++generation;
  try {
    await renderFrame(state, 1);
    if (mine === generation) await chrome.action.setBadgeText({ text: "" });
  } catch (e) {
    // OffscreenCanvas can be unavailable very early in worker startup. A text
    // badge is worse, but far better than showing no state at all.
    console.warn("[badge] icon render failed, falling back to text:", e.message);
    try {
      await chrome.action.setBadgeText({ text: state === "on" ? "ON" : state === "error" ? "!" : "" });
      await chrome.action.setBadgeBackgroundColor({
        color: state === "on" ? "#2ecc71" : "#ff6b6b",
      });
    } catch (_) {
      /* action API not ready yet */
    }
  }
}

const PULSES = 5;
const CYCLE_MS = 420;
const FRAME_MS = 60;

/**
 * Five smooth pulses meaning "connecting", then a steady dot meaning "connected".
 *
 * This is safe to animate where a continuous blink would not be: it runs
 * immediately after the user pressed the button, so the MV3 service worker is
 * guaranteed to be alive for its ~2s duration. A permanently blinking icon is not
 * achievable — the worker is terminated after ~30s idle and the shortest alarm
 * period is 30s, so it would blink only while the worker happened to be awake and
 * freeze the rest of the time, which reads as a bug.
 *
 * Always settles on the steady state, including when it is superseded.
 */
export async function pulseConnecting(finalState = "on") {
  const mine = ++generation;
  try {
    const frames = Math.round(CYCLE_MS / FRAME_MS);
    for (let p = 0; p < PULSES; p++) {
      for (let f = 0; f < frames; f++) {
        if (mine !== generation) return; // superseded — leave the icon to the new owner
        // Cosine ease: bright -> dim -> bright, without a hard on/off flicker.
        const phase = (f / frames) * Math.PI * 2;
        const opacity = 0.3 + 0.7 * ((1 + Math.cos(phase)) / 2);
        await renderFrame(finalState, opacity);
        await new Promise((r) => setTimeout(r, FRAME_MS));
      }
    }
  } catch (e) {
    console.warn("[badge] pulse failed:", e.message);
  } finally {
    if (mine === generation) {
      generation--; // let setStatusIcon claim ownership rather than be ignored
      await setStatusIcon(finalState);
    }
  }
}
