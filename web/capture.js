/**
 * One flag: is something trying to photograph the screen right now?
 *
 * The scan screen runs a loop that reads a camera frame into a canvas and
 * hunts it for a QR code, as fast as the browser will let it. On the machine
 * at the gym that loop and `domToDataUrl` do not share the main thread
 * politely: pressing "แจ้งปัญหา" while the lens was live left the capture
 * never settling and the screen frozen on "กำลังจับภาพหน้าจอ…" with no way out
 * but a reload -- for over three minutes, on the screen staff spend their
 * whole shift on (QA BUG-14). Turn the camera off first and the same capture
 * finished in two seconds.
 *
 * So the capture says "hold on" and the loop stops decoding while it works.
 * Not stops the camera: the picture has to contain what the person was
 * looking at, which includes the video. Only the decoding pauses.
 *
 * A module-level flag rather than a prop, because the two sides are in
 * different trees -- the menu that starts a capture is in main.jsx and the
 * loop is inside the scanner -- and threading a boolean through four
 * components to say "pause" would be four chances to forget.
 */
let paused = false;
const listeners = new Set();

/** Read by the scan loop on every frame. */
export const scanningPaused = () => paused;

export function setScanningPaused(value) {
  if (paused === value) return;
  paused = value;
  for (const listener of listeners) listener(paused);
}

/** For anything that wants to show the pause on screen. Returns an unsubscribe. */
export function onScanningPause(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Runs `work` with the scan loop held, and lets it go again whatever happens.
 *
 * The whole guarantee lives in one place on purpose. The first version set the
 * flag in `captureScreen` and cleared it in a `finally` that began AFTER
 * `await import('modern-screenshot')` -- so a chunk that failed to load (a tab
 * left open across a deploy, a tablet that drops the wifi at the wrong second)
 * left the flag set, and the lens never read another card. The screen looked
 * perfectly normal: live video, no error, members holding cards up to a camera
 * that had quietly stopped looking (QA BUG-15).
 *
 * Nothing between here and the `finally` may sit outside it.
 */
export async function withScanningPaused(work) {
  setScanningPaused(true);
  try { return await work(); } finally { setScanningPaused(false); }
}

/** How long a picture of the screen is allowed to take before we give up. */
export const CAPTURE_TIMEOUT_MS = 8000;

/**
 * The promise, or a rejection once the clock runs out.
 *
 * Exported so it can be tested without a browser: the whole point of it is a
 * promise that never settles, and the only honest way to check that is to hand
 * it one.
 */
export function withTimeout(promise, ms = CAPTURE_TIMEOUT_MS, message = 'จับภาพหน้าจอไม่ทัน') {
  let timer;
  const alarm = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, alarm]).finally(() => clearTimeout(timer));
}
