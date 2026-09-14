import React, { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Reads a QR from the counter's camera.
 *
 * "Staff or the tablet at the counter" scan, so this cannot assume a USB reader
 * is plugged in. Where the browser ships BarcodeDetector (Chrome and Edge on
 * Android and desktop) that does the work; everywhere else the frames go
 * through jsQR, which is slower but needs nothing installed.
 *
 * Refusing permission is reported upward rather than drawn here: the scan
 * screen turns it into a way to carry on working, which is what somebody with
 * a customer in front of them needs before they need a fix (Designer).
 *
 * @param {(text: string) => void} onScan called once per distinct code read
 * @param {(error: Error) => void} onError camera unavailable or refused
 */
export function CameraScanner({ onScan, active, onError }) {
  const video = useRef(null);
  const canvas = useRef(null);
  const stream = useRef(null);
  const lastCode = useRef({ text: '', at: 0 });

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
        onError?.(new Error('เบราว์เซอร์นี้เปิดกล้องไม่ได้'));
        return;
      }
      try {
        // The rear camera is the one pointing at the member's screen.
        stream.current = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false,
        });
      } catch (cause) {
        onError?.(new Error(cause?.name === 'NotAllowedError'
          ? 'ยังไม่ได้อนุญาตให้ใช้กล้อง' : 'เปิดกล้องไม่ได้ อาจมีแอปอื่นใช้อยู่'));
        return;
      }
      if (cancelled) { stream.current.getTracks().forEach(track => track.stop()); return; }
      video.current.srcObject = stream.current;
      await video.current.play().catch(() => {});

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
    };
  }, [active, emit, onError]);

  if (!active) return null;
  return <>
    <video ref={video} muted playsInline aria-label="ภาพจากกล้องสำหรับสแกน QR"/>
    <canvas ref={canvas} hidden/>
  </>;
}

/**
 * Takes the member's photograph at the counter.
 *
 * The same `getUserMedia` the scanner uses, pointed the other way: the front
 * camera, because the person holding the tablet is photographing somebody
 * standing opposite them and needs to see the frame. The dashed circle is
 * where the face has to end up -- the picture is cropped square from the
 * middle, and the card and the scan screen both show it as a circle.
 *
 * @param {(file: File) => void} onCapture
 */
export function PhotoCapture({ onCapture, busy, preview }) {
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
    // Square, cropped from the middle of the frame, and no larger than the
    // card needs: a 4000px phone photo makes a card too heavy to send.
    const side = Math.min(source.videoWidth, source.videoHeight);
    const out = Math.min(side, 900);
    canvas.current.width = out;
    canvas.current.height = out;
    canvas.current.getContext('2d').drawImage(source,
      (source.videoWidth - side) / 2, (source.videoHeight - side) / 2, side, side, 0, 0, out, out);
    canvas.current.toBlob(blob => {
      if (blob) onCapture(new File([blob], 'member-photo.jpg', { type: 'image/jpeg' }));
      setOn(false);
    }, 'image/jpeg', 0.9);
  }

  return <div className="photo-capture">
    {error && <div className="banner bad" role="alert"><div className="ic" aria-hidden="true">!</div>
      <div><b>{error.message}</b></div></div>}
    <div className="photoframe">
      {on
        ? <video ref={video} muted playsInline aria-label="ภาพจากกล้องสำหรับถ่ายรูปสมาชิก"/>
        : preview && <img src={preview} alt="รูปที่เพิ่งถ่าย"/>}
      <span className="ring" aria-hidden="true"/>
      <span className="tip">ให้ใบหน้าอยู่ในวงกลม แสงส่องหน้า ไม่ย้อนแสง</span>
    </div>
    <canvas ref={canvas} hidden/>
    <div className="btn-row" style={{ marginTop: 'var(--sp-4)' }}>
      <button type="button" className="btn primary xl" disabled={busy}
        onClick={() => { setError(null); if (on) take(); else setOn(true); }}>
        {on ? 'ถ่ายรูปนี้' : preview ? 'ถ่ายรูปใหม่' : 'เปิดกล้องถ่ายรูป'}</button>
      {on && <button type="button" className="btn ghost" disabled={busy} onClick={() => setOn(false)}>ปิดกล้อง</button>}
    </div>
  </div>;
}
