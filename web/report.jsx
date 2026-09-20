import { useEffect, useRef, useState } from 'react';
import { upload } from './shared.jsx';
import { hiddenFromCapture, loadCaptureModule, withScanningPaused, withTimeout } from './capture.js';

/**
 * "ใช้ไม่ได้อย่างไร" — with a picture of it.
 *
 * Three things decide the shape of this.
 *
 * The picture is taken BEFORE the box opens, or the picture is of the box.
 * That costs a visible pause, so the pause is a state of its own rather than
 * something the screen pretends is not happening.
 *
 * One field is required, and it is the sentence. A screenshot almost never
 * says what somebody was trying to do when it went wrong.
 *
 * And the report survives a bad network, because the problems worth reporting
 * happen when the network is bad. It goes into this browser's own storage and
 * leaves when the connection comes back.
 */

const QUEUE_KEY = 'gym.reports.pending';
/** The widest we bother capturing: beyond this the server would shrink it anyway. */
const CAPTURE_MAX = 1280;

const readQueue = () => {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) ?? '[]'); } catch { return []; }
};
const writeQueue = items => {
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(items)); } catch { /* full or private mode */ }
};

/**
 * A data URL back into the bytes a multipart body wants.
 *
 * Decoded by hand rather than with `fetch(dataUrl)`, which is the obvious way
 * and does not work here: helmet's Content-Security-Policy has `connect-src
 * 'self'`, so fetching a `data:` URL is refused. It fails quietly -- the
 * report still sends, just with no picture -- which is exactly the kind of
 * silence this whole feature exists to get rid of.
 */
function asBlob(dataUrl) {
  try {
    const [head, body] = String(dataUrl).split(',');
    if (!body) return null;
    const type = /data:([^;]+)/.exec(head)?.[1] ?? 'image/png';
    const binary = atob(body);
    const bytes = new Uint8Array(binary.length);
    for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at);
    return new Blob([bytes], { type });
  } catch { return null; }
}

function bodyFor(report, blob) {
  const body = new FormData();
  body.append('message', report.message);
  body.append('screen', report.screen ?? '');
  body.append('viewport', report.viewport ?? '');
  body.append('app_revision', report.app_revision ?? '');
  if (blob) body.append('screenshot', blob, 'screen.png');
  return body;
}

/**
 * Sends anything this browser kept while it was offline.
 *
 * Called when the app starts and whenever the connection returns. A report
 * that fails again stays in the queue: the worst outcome here is the one where
 * somebody typed a sentence during an outage and it quietly evaporated.
 */
export async function flushPendingReports() {
  const queued = readQueue();
  if (!queued.length) return 0;
  const left = [];
  let sent = 0;
  for (const report of queued) {
    try {
      await upload('/reports', bodyFor(report, report.shot ? asBlob(report.shot) : null), 'POST');
      sent += 1;
    } catch (error) {
      // Refused for a reason that will not change (too big, not an image):
      // dropping the picture is better than dropping the report.
      if (error.status >= 400 && error.status < 500 && report.shot) left.push({ ...report, shot: null });
      else if (!(error.status >= 400 && error.status < 500)) left.push(report);
    }
  }
  writeQueue(left);
  return sent;
}

export const pendingReportCount = () => readQueue().length;

/**
 * Draws the picture of the screen as it is right now.
 *
 * `<video>` is the hard part and the reason this is not one library call. A
 * DOM render cannot see the frames coming out of a camera, so the scan screen
 * and the photograph screen -- the two most likely to be reported -- would
 * come back with an empty rectangle where the problem is. Each video is
 * painted onto a canvas first and put back afterwards.
 */
export function captureScreen() {
  // Everything below runs with the QR loop held -- including the import, which
  // is the line that used to sit outside the guard (QA BUG-15). One wrapper,
  // one release, no way to add a step that escapes it.
  return withScanningPaused(captureNow);
}

async function captureNow() {
  // The same promise the app warmed up with, not a second import: on a cold
  // page this is what turns ten seconds into two (QA BUG-16).
  const { domToDataUrl } = await loadCaptureModule();
  const swapped = [];
  for (const video of document.querySelectorAll('video')) {
    if (!video.videoWidth || !video.videoHeight) continue;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d').drawImage(video, 0, 0);
      const box = video.getBoundingClientRect();
      canvas.style.cssText = `width:${box.width}px;height:${box.height}px;object-fit:cover;display:block`;
      video.replaceWith(canvas);
      swapped.push([canvas, video]);
    } catch { /* a camera the browser will not let us read: leave it blank */ }
  }
  try {
    const scale = Math.min(1, CAPTURE_MAX / Math.max(document.documentElement.clientWidth, 1));
    // The timeout is inside this function rather than around the call, because
    // of the `finally` below: if the capture never settles, nothing puts the
    // real <video> elements back and the screen is left showing frozen
    // canvases. Giving up after eight seconds restores them and falls through
    // to the "picture failed" path, which already exists and works.
    return await withTimeout(domToDataUrl(document.body, {
      scale, backgroundColor: '#EFF2F4', type: 'image/png',
      // Without this the panel announcing the capture is IN the capture,
      // parked over the middle of the screen -- which is where the thing
      // being reported usually is (QA BUG-17).
      filter: node => !hiddenFromCapture(node),
    }));
  } finally {
    for (const [canvas, video] of swapped) canvas.replaceWith(video);
  }
}

const now = () => new Date().toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' });

export function ReportDialog({ user, screen, shot, captureFailed, onClose }) {
  const [message, setMessage] = useState('');
  const [chosenScreen, setChosenScreen] = useState(screen ?? '');
  const [attach, setAttach] = useState(true);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(null);
  const [done, setDone] = useState(null);      // { reference } or { queued: true }
  const box = useRef(null);
  const field = useRef(null);

  useEffect(() => { field.current?.focus(); }, []);
  useEffect(() => {
    const onKey = event => { if (event.key === 'Escape' && !busy) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const meta = {
    'หน้าที่เกิด': chosenScreen || '—',
    'เวลา': now(),
    'ผู้แจ้ง': `${user?.email ?? ''} (${user?.role === 'admin' ? 'เจ้าของยิม' : 'พนักงาน'})`,
    'เครื่องที่ใช้': `${window.innerWidth}×${window.innerHeight} · ${navigator.userAgent.slice(0, 60)}`,
  };

  async function submit(event) {
    event.preventDefault();
    if (!message.trim() || busy) return;
    setBusy(true); setFailure(null);
    const report = {
      message: message.trim(),
      screen: chosenScreen,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      // Baked in by vite at build time; empty means nobody passed one.
      app_revision: typeof __APP_REVISION__ === 'string' ? __APP_REVISION__ : '',
      shot: attach && shot ? shot : null,
    };
    try {
      const saved = await upload('/reports', bodyFor(report, report.shot ? asBlob(report.shot) : null), 'POST');
      setDone({ reference: saved.reference });
    } catch (error) {
      // Offline is not a failure to show the person: it is a reason to keep
      // what they wrote and send it later. Anything else they should see.
      if (error.offline) {
        writeQueue([...readQueue(), report]);
        setDone({ queued: true });
      } else setFailure(error);
    } finally { setBusy(false); }
  }

  if (done) {
    return <div className="sheet" role="dialog" aria-modal="true" aria-label="ส่งเรื่องแล้ว"
      onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="sheet-in" ref={box}>
        <div className="sheet-b done-big">
          <div className="tick" aria-hidden="true">✓</div>
          {done.queued
            ? <>
                <b>เก็บเรื่องไว้ในเครื่องแล้ว</b>
                <p className="note">ตอนนี้ต่อเน็ตไม่ได้ ระบบจะส่งให้เองเมื่อกลับมาออนไลน์ ไม่ต้องพิมพ์ใหม่</p>
              </>
            : <>
                <b>ส่งเรื่องแล้ว</b>
                <div className="ref">เรื่อง #{done.reference}</div>
                <p className="note">จดเลขนี้ไว้ถ้าต้องคุยกันต่อ · เจ้าของยิมเห็นเรื่องนี้ได้ทันทีจากเมนู “เรื่องที่แจ้งไว้”</p>
              </>}
          {/* Said plainly, because at this moment a member is still waiting at
              the counter and the honest thing is to send them back to work. */}
          <div className="alert warn" style={{ textAlign: 'left' }}>
            <div className="ic" aria-hidden="true">!</div>
            <div><b>เรื่องนี้ยังไม่ได้แก้ให้คุณตอนนี้</b>
              <span>ถ้ามีวิธีทำอย่างอื่นไปก่อนได้ ให้ทำวิธีนั้นเพื่อไม่ให้ลูกค้ารอ</span></div>
          </div>
        </div>
        <div className="sheet-f">
          <button className="btn primary" onClick={onClose}>กลับไปทำงานต่อ</button>
        </div>
      </div>
    </div>;
  }

  return <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="report-title"
    onClick={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <form className="sheet-in" ref={box} onSubmit={submit}>
      <div className="sheet-h">
        <h2 id="report-title">แจ้งปัญหา</h2>
        <button className="iconbtn" type="button" onClick={onClose} aria-label="ปิด">✕</button>
      </div>

      <div className="sheet-b">
        {captureFailed
          ? <>
              <div className="alert warn">
                <div className="ic" aria-hidden="true">!</div>
                <div><b>จับภาพหน้าจอไม่สำเร็จ</b>
                  <span>ส่งเรื่องต่อได้ตามปกติ แค่ไม่มีภาพประกอบ</span></div>
              </div>
              <div className="field">
                <label htmlFor="report-screen">เกิดที่หน้าไหน</label>
                <input id="report-screen" name="screen" value={chosenScreen} maxLength={80}
                  onChange={event => setChosenScreen(event.target.value)}/>
                <p className="note">ปกติระบบกรอกให้เอง ครั้งนี้ต้องเลือกเองเพราะจับภาพไม่ได้</p>
              </div>
            </>
          : <>
              <div className="pvlabel">ภาพหน้าจอตอนที่คุณกด</div>
              <div className="shot-prev">
                <img src={shot} alt="ภาพหน้าจอที่ระบบจับไว้ตอนคุณกดแจ้งปัญหา"/>
                <span className="tag">ระบบจับภาพก่อนเปิดกล่องนี้เสมอ</span>
              </div>
              <label className="check-row" style={{ marginTop: 'var(--sp-3)' }}>
                <input type="checkbox" checked={attach} onChange={event => setAttach(event.target.checked)}/>
                <span>ส่งภาพหน้าจอไปด้วย
                  <span className="sub">ภาพอาจมีชื่อหรือรูปสมาชิก · เจ้าของยิมเท่านั้นที่เปิดดูได้ และระบบบันทึกทุกครั้งที่มีคนเปิดดู</span>
                </span>
              </label>
            </>}

        <div className={`field${failure?.fields?.message ? ' invalid' : ''}`} style={{ marginTop: 'var(--sp-4)' }}>
          <label htmlFor="report-message">ใช้ไม่ได้อย่างไร <span aria-hidden="true">*</span></label>
          <textarea id="report-message" name="message" rows={4} required maxLength={2000} ref={field}
            value={message} onChange={event => setMessage(event.target.value)}
            placeholder="เช่น กดปุ่มบันทึกแล้วหมุนค้าง ไม่ขึ้นอะไรเลย"/>
          <p className="note">เขียนสั้น ๆ ก็พอ แต่ต้องมี — ภาพอย่างเดียวมักบอกไม่ได้ว่าคุณตั้งใจจะทำอะไร</p>
        </div>

        {/* Shown, not hidden: somebody should be able to see what leaves their
            machine before they press the button. */}
        <div className="meta">
          <div className="pvlabel">แนบไปด้วยอัตโนมัติ</div>
          <dl>{Object.entries(meta).map(([label, value]) =>
            <div key={label} style={{ display: 'contents' }}>
              <dt>{label}</dt><dd>{value}</dd>
            </div>)}
          </dl>
        </div>

        {failure && <div className="alert err" role="alert">
          <div className="ic" aria-hidden="true">✕</div>
          <div><b>ส่งเรื่องไม่สำเร็จ</b><span>{failure.message}</span></div>
        </div>}
      </div>

      <div className="sheet-f">
        <button className="btn" type="button" onClick={onClose} disabled={busy}>ยกเลิก</button>
        <button className="btn primary" disabled={busy || !message.trim()}>
          {busy ? <><span className="spin"/>กำลังส่ง…</> : 'ส่งเรื่อง'}</button>
      </div>
    </form>
  </div>;
}
