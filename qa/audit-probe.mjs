// The measurement one screen gets, shared by the local sweep and the live check.
/**
 * Everything measured on one screen. Overflow and clipping are facts; tap
 * targets and contrast are measured against the usual thresholds and reported
 * with numbers so a person can judge the borderline ones.
 */
export const AUDIT = `(() => {
  const vw = document.documentElement.clientWidth;
  const visible = el => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const name = el => el.tagName.toLowerCase()
    + (el.id ? '#' + el.id : '')
    + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/).slice(0, 3).join('.') : '');
  // Parked far off-screen is the standard way to keep a heading for screen
  // readers while the layout drops it. It is not overflow and not clipping.
  const offscreen = el => el.getBoundingClientRect().right < -1000;
  const all = [...document.querySelectorAll('body *')].filter(el => visible(el) && !offscreen(el));

  // --- sideways overflow -------------------------------------------------
  const overflow = [];
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (r.right > vw + 1 || r.left < -1) {
      const parent = el.parentElement;
      // Report the outermost offender only: a child sticking out of a parent
      // that already sticks out is the same problem told twice.
      if (parent && parent !== document.body) {
        const pr = parent.getBoundingClientRect();
        if (pr.right > vw + 1 || pr.left < -1) continue;
      }
      overflow.push({ el: name(el), left: Math.round(r.left), right: Math.round(r.right), viewport: vw });
    }
  }

  // --- text cut off by its own box ---------------------------------------
  const clipped = [];
  for (const el of all) {
    const s = getComputedStyle(el);
    if (!/hidden|clip/.test(s.overflow + s.overflowX + s.overflowY)) continue;
    if (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1) {
      const text = (el.textContent || '').trim().slice(0, 40);
      if (text) clipped.push({ el: name(el), text, box: [el.clientWidth, el.clientHeight],
        content: [el.scrollWidth, el.scrollHeight] });
    }
  }

  // --- things you tap ----------------------------------------------------
  const small = [];
  for (const el of all) {
    if (!/^(button|a|select|input|textarea)$/.test(el.tagName.toLowerCase())
      && el.getAttribute('role') !== 'button') continue;
    if (el.tagName.toLowerCase() === 'input' && /hidden/.test(el.type)) continue;
    if (el.disabled) continue;
    // A checkbox inside its own label is as big as the label: tapping the words
    // works. Measure what a finger can actually hit.
    const label = el.closest('label');
    const r = (label && label.contains(el) ? label : el).getBoundingClientRect();
    if (r.width < 44 || r.height < 44) {
      small.push({ el: name(el), label: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 30),
        size: [Math.round(r.width), Math.round(r.height)] });
    }
  }

  // --- contrast ----------------------------------------------------------
  const parse = c => {
    const m = c.match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const [r, g, b, a = 1] = m[1].split(',').map(Number);
    return { r, g, b, a };
  };
  const lum = ({ r, g, b }) => {
    const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const behind = el => {
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.backgroundImage !== 'none') return null;
      const c = parse(s.backgroundColor);
      if (c && c.a === 1) return c;
    }
    return { r: 255, g: 255, b: 255 };
  };
  const contrast = [];
  for (const el of all) {
    const own = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    if (!own) continue;
    const s = getComputedStyle(el);
    const fg = parse(s.color);
    const bg = behind(el);
    if (!fg || !bg || fg.a < 1) continue;
    const ratio = (Math.max(lum(fg), lum(bg)) + 0.05) / (Math.min(lum(fg), lum(bg)) + 0.05);
    const size = parseFloat(s.fontSize);
    const bold = Number(s.fontWeight) >= 700;
    const large = size >= 24 || (bold && size >= 18.66);
    const need = large ? 3 : 4.5;
    if (ratio < need) {
      contrast.push({ el: name(el), text: el.textContent.trim().slice(0, 30),
        ratio: Math.round(ratio * 100) / 100, need, fontSize: size,
        color: s.color, background: \`rgb(\${bg.r}, \${bg.g}, \${bg.b})\` });
    }
  }

  return { viewport: vw, documentWidth: document.documentElement.scrollWidth,
    overflow, clipped, small, contrast };
})()`;
