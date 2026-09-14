import React, { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Reads a QR from the tablet's camera.
 *
 * The reporter asked for "staff or the tablet at the counter" to scan, so the
 * counter screen cannot assume a USB reader is plugged in. Where the browser
 * ships BarcodeDetector (Chrome and Edge on Android and desktop) that does the
 * work; everywhere else the frames go through jsQR, which is slower but needs
 * nothing installed.
 *
 * @param {(text: string) => void} onScan called once per distinct code read
 */
export function CameraScanner({ onScan, active }) {
  const video = useRef(null);
  const canvas = useRef(null);
  const stream = useRef(null);
  const lastCode = useRef({ text: '', at: 0 });
  const [error, setError] = useState(null);
  const [ready, setReady] = useState(false);

  /** The same code held in front of the lens must not fire over and over. */
  const emit = useCallback(text => {
    const now = Date.now();
    if (!text || (text === lastCode.current.text && now - lastCode.current.at < 4000)) return;
    lastCode.current = { text, at: now };
    onScan(text);
  }, [onScan]);

  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    let frame = 0;
    let detector = null;
    let decode = null;

    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError(new Error('เบราว์เซอร์นี้เปิดกล้องไม่ได้ กรุณาใช้เครื่องอ่าน QR หรือวางรหัสในช่องด้านล่าง'));
        return;
      }
      try {
        // The rear camera is the one pointing at the member's screen.
        stream.current = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false,
        });
      } catch (cause) {
        setError(new Error(cause?.name === 'NotAllowedError'
          ? 'ยังไม่ได้อนุญาตให้ใช้กล้อง กรุณากดอนุญาตในเบราว์เซอร์ แล้วลองใหม่'
          : 'เปิดกล้องไม่ได้ อาจมีแอปอื่นใช้อยู่ กรุณาใช้เครื่องอ่าน QR หรือวางรหัสในช่องด้านล่าง'));
        return;
      }
      if (cancelled) { stream.current.getTracks().forEach(track => track.stop()); return; }
      video.current.srcObject = stream.current;
      await video.current.play().catch(() => {});
      setReady(true);

      if ('BarcodeDetector' in window) {
        try { detector = new window.BarcodeDetector({ formats: ['qr_code'] }); } catch { detector = null; }
      }
      // Only the browsers without BarcodeDetector pay for the decoder, and only
      // once somebody actually turns the camera on.
      if (!detector) {
        decode = (await import('jsqr')).default;
        if (cancelled) return;
      }

      const tick = async () => {
        if (cancelled || !video.current || video.current.readyState < 2) {
          frame = requestAnimationFrame(tick);
          return;
        }
        try {
          if (detector) {
            const found = await detector.detect(video.current);
            if (found.length) emit(found[0].rawValue);
          } else {
            const { videoWidth: width, videoHeight: height } = video.current;
            if (width && height) {
              canvas.current.width = width;
              canvas.current.height = height;
              const context = canvas.current.getContext('2d', { willReadFrequently: true });
              context.drawImage(video.current, 0, 0, width, height);
              const image = context.getImageData(0, 0, width, height);
              const found = decode?.(image.data, width, height, { inversionAttempts: 'dontInvert' });
              if (found) emit(found.data);
            }
          }
        } catch { /* a dropped frame is not worth telling the counter about */ }
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    }

    start();
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      stream.current?.getTracks().forEach(track => track.stop());
      stream.current = null;
      setReady(false);
    };
  }, [active, emit]);

  if (!active) return null;
  return <div className="camera">
    {error
      ? <div className="notice warn" role="alert">{error.message}</div>
      : <p className="fine">{ready ? 'หันกล้องไปที่จอของสมาชิก ระบบจะอ่านเองเมื่อเห็น QR' : 'กำลังเปิดกล้อง…'}</p>}
    <video ref={video} className="camera-view" muted playsInline aria-label="ภาพจากกล้องสำหรับสแกน QR"/>
    <canvas ref={canvas} hidden/>
  </div>;
}

/**
 * Takes the member's photograph at the counter.
 *
 * The same `getUserMedia` the scanner uses, pointed the other way: the front
 * camera, because the person holding the tablet is photographing somebody
 * standing opposite them and needs to see the frame. Choosing a file is offered
 * beside it and does the identical job -- a counter computer with no camera at
 * all is a real gym, and so is one where the member would rather send a photo.
 *
 * @param {(file: File) => void} onCapture
 */
export function PhotoCapture({ onCapture, busy }) {
  const video = useRef(null);
  const canvas = useRef(null);
  const stream = useRef(null);
  const [on, setOn] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!on) return undefined;
    let cancelled = false;
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError(new Error('เบราว์เซอร์นี้เปิดกล้องไม่ได้ กรุณาเลือกรูปจากเครื่องแทน'));
        setOn(false);
        return;
      }
      try {
        stream.current = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'user' }, width: { ideal: 1280 }, height: { ideal: 1280 } }, audio: false,
        });
      } catch (cause) {
        setError(new Error(cause?.name === 'NotAllowedError'
          ? 'ยังไม่ได้อนุญาตให้ใช้กล้อง กรุณากดอนุญาตในเบราว์เซอร์ หรือเลือกรูปจากเครื่องแทน'
          : 'เปิดกล้องไม่ได้ อาจมีแอปอื่นใช้อยู่ กรุณาเลือกรูปจากเครื่องแทน'));
        setOn(false);
        return;
      }
      if (cancelled) { stream.current.getTracks().forEach(track => track.stop()); return; }
      video.current.srcObject = stream.current;
      await video.current.play().catch(() => {});
    })();
    return () => {
      cancelled = true;
      stream.current?.getTracks().forEach(track => track.stop());
      stream.current = null;
    };
  }, [on]);

  function take() {
    const source = video.current;
    if (!source?.videoWidth) return;
    // Square, cropped from the middle of the frame: the card and the scan
    // screen both show a circle, and a portrait squeezed into one is a face
    // nobody can check against the person in front of them.
    const side = Math.min(source.videoWidth, source.videoHeight);
    canvas.current.width = side;
    canvas.current.height = side;
    canvas.current.getContext('2d').drawImage(source,
      (source.videoWidth - side) / 2, (source.videoHeight - side) / 2, side, side, 0, 0, side, side);
    canvas.current.toBlob(blob => {
      if (blob) onCapture(new File([blob], 'member-photo.jpg', { type: 'image/jpeg' }));
      setOn(false);
    }, 'image/jpeg', 0.9);
  }

  return <div className="photo-capture">
    {error && <div className="notice warn" role="alert">{error.message}</div>}
    {on && <>
      <video ref={video} className="camera-view" muted playsInline aria-label="ภาพจากกล้องสำหรับถ่ายรูปสมาชิก"/>
      <canvas ref={canvas} hidden/>
    </>}
    <div className="actions">
      <button type="button" disabled={busy} onClick={() => { setError(null); setOn(!on); }}>
        {on ? 'ปิดกล้อง' : 'เปิดกล้องถ่ายรูป'}</button>
      {on && <button type="button" className="primary" disabled={busy} onClick={take}>ถ่ายรูปนี้</button>}
    </div>
  </div>;
}
