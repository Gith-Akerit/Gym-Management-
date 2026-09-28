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

// ------------------------------------------------- what the scan loop costs
//
// The counter's machine is not a phone. On the office PC the whole app was
// reported as freezing the computer, and this is why: with no BarcodeDetector
// -- Chrome and Edge on Windows have none -- every frame went through jsQR,
// in JavaScript, on the main thread, at the camera's full 1280x720. Measured
// here, one such frame is over 100 ms of solid work. The loop asked for the
// next one as soon as it finished, so the main thread was never idle: nothing
// else on the page -- a click, a keystroke, a repaint -- got a turn, which is
// what "เครื่องค้าง" means when a user says it (ผลทดลองใช้ของผู้ใช้ รอบที่ 2).
//
// Two numbers fix it, and they are here rather than in the component so a
// test can hold them to account without a browser.

/**
 * The gap between one read and the next.
 *
 * Eight reads a second. Nobody presents a card in under 125 ms, so this is
 * instant to a person, and it leaves the main thread free between reads --
 * which is the entire difference between a busy tab and a frozen computer.
 * Much above 200 ms and holding a card up starts to feel like it was ignored.
 */
export const SCAN_EVERY_MS = 125;

/**
 * The longest edge a frame is shrunk to before jsQR is handed it.
 *
 * jsQR walks every pixel, so its cost is the pixel count and nothing else:
 * 1280x720 is 920,000 of them, 640x360 is 230,000. Below about 480 the corner
 * squares smear and reads start to fail, which is the one thing this screen
 * must never do -- so the frame is shrunk, not shrunk as far as possible.
 */
export const DECODE_EDGE = 640;

/**
 * The size that frame should be decoded at, keeping its shape.
 *
 * Never enlarges: a camera that only offers 320x240 is already cheap, and
 * blowing it up would add pixels without adding any information to read.
 */
export function decodeFrameSize(width, height, edge = DECODE_EDGE) {
  const scale = Math.min(1, edge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
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

/**
 * The screenshot library, fetched once and remembered.
 *
 * It is a dynamic import because most sessions never press "แจ้งปัญหา" and
 * 24 KB of it has no business in the first paint. That was right, and it had
 * a cost nobody measured until QA did: loading and compiling it WHILE the QR
 * loop runs pushed the first capture on every page past the eight-second
 * clock, so the first report from any page arrived with no picture at all --
 * five times out of five on the gym's machine. The download was 42 ms of
 * those ten seconds; the rest was the module competing with the camera for
 * the main thread (QA BUG-16).
 *
 * So it is still fetched on demand -- just demanded earlier, while nobody is
 * waiting, and kept.
 */
let modulePromise = null;

export function loadCaptureModule() {
  // A failed load is not remembered: the tab that lost the wifi for a second
  // at idle time must not be a tab that can never take a picture again.
  modulePromise ??= import('modern-screenshot').catch(error => {
    modulePromise = null;
    throw error;
  });
  return modulePromise;
}

let scheduled = false;

/**
 * Asks for it while the counter is quiet.
 *
 * `requestIdleCallback` so it never competes with opening the camera, with a
 * timeout so a permanently busy tab still gets there, and a plain timer for
 * the browsers without it. Called once, after somebody is signed in and the
 * counter's own app is on screen -- never from the member's portal, which has
 * no way to report a problem and no reason to pay 113 ms for one.
 */
export function preloadCaptureModule({ idleTimeoutMs = 3000, fallbackMs = 1500 } = {}) {
  if (scheduled) return;
  scheduled = true;
  const start = () => { loadCaptureModule().catch(() => { /* asked again at press time */ }); };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(start, { timeout: idleTimeoutMs });
  else setTimeout(start, fallbackMs);
}

/**
 * Whether the screenshot should pretend this element is not there.
 *
 * The picture is taken before the box opens so that it shows the problem
 * rather than the box -- but the panel that says "กำลังจับภาพหน้าจอ…" is on
 * screen while the shutter is open, and it landed in the middle of every
 * report the gym received, over the very thing somebody was reporting
 * (QA BUG-17). Anything marked `data-capture-hide` is left out.
 */
export const hiddenFromCapture = node =>
  !!node && node.nodeType === 1 && node.hasAttribute?.('data-capture-hide');
