/* ==========================================================================
   brand.js — เครื่องคำนวณสีแบรนด์ (ยกมาจาก Designer ทั้งไฟล์ ห้ามมีสูตรที่สอง)
   เซิร์ฟเวอร์ require ไฟล์นี้ตอนวาดบัตร หน้าเว็บ import ไฟล์เดียวกันตอนพรีวิว
   ค่าที่ออกมาจึงตรงกันทุกหลักโดยไม่ต้องไล่ว่าใครคำนวณต่าง
   โค้ดนี้คือ reference implementation ฝั่งเซิร์ฟเวอร์ต้องได้ผลเหมือนกันทุกค่า
   ไม่มี dependency ใช้ได้ทั้งใน browser และ Node
   ========================================================================== */
(function (root) {
  'use strict';

  // ---------- พื้นฐาน ----------
  function hexToRgb(h) {
    h = String(h).trim().replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  function rgbToHex(c) {
    return '#' + c.map(function (v) {
      return Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0');
    }).join('').toUpperCase();
  }
  function relLum(rgb) {
    var c = rgb.map(function (v) {
      v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  function contrast(a, b) {
    var l1 = relLum(hexToRgb(a)), l2 = relLum(hexToRgb(b));
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }
  // ผสมเชิงเส้นใน sRGB — เลือกวิธีนี้เพราะพอร์ตไปภาษาอื่นได้ใน 3 บรรทัด
  function mix(a, b, t) {
    var x = hexToRgb(a), y = hexToRgb(b);
    return rgbToHex([0, 1, 2].map(function (i) { return x[i] * (1 - t) + y[i] * t; }));
  }
  var INK = '#0E1418', WHITE = '#FFFFFF', CANVAS = '#EFF2F4';

  // ---------- 1. ตัวอักษรบนสีแบรนด์: ขาวหรือดำ ----------
  function onBrand(surface) {
    return contrast(WHITE, surface) >= contrast(INK, surface) ? WHITE : INK;
  }

  // ---------- 2. สีพื้นของปุ่ม/หัวบัตร ----------
  // ถ้าสีที่เลือกอยู่กลาง ๆ จนขาวก็ไม่ผ่าน ดำก็ไม่ผ่าน ให้ดันไปทางที่ได้เปรียบ
  // จนถึง 4.5:1 พอดี ไม่ดันเกินจำเป็น เพื่อให้ยังใกล้สีที่เจ้าของเลือกที่สุด
  function brandSurface(brand) {
    var on = onBrand(brand);
    if (contrast(on, brand) >= 4.5) return brand.toUpperCase();
    var target = on === WHITE ? INK : WHITE;   // ขาวอยู่บน -> ทำพื้นให้เข้มลง
    for (var t = 0.02; t <= 1.0001; t += 0.02) {
      var c = mix(brand, target, t);
      if (contrast(on, c) >= 4.5) return c;
    }
    return on === WHITE ? INK : WHITE;
  }

  // ---------- 3. พื้นอ่อนสำหรับ chip/แถบ ----------
  // คำนวณก่อน ink เสมอ: ผสมขาว 92% ตายตัว ไม่ต้องวนหา
  function brandSoft(brand) {
    return mix(brand, WHITE, 0.92);
  }

  // ---------- 4. สีตัวอักษรแบรนด์บนพื้นอ่อน/พื้นขาว ----------
  // วัดกับ --brand-soft ซึ่งเข้มกว่าขาว ผ่านตรงนี้แล้วบนขาวผ่านแน่นอน
  function brandInk(brand) {
    var soft = brandSoft(brand);
    if (contrast(brand, soft) >= 4.5) return brand.toUpperCase();
    for (var t = 0.02; t <= 1.0001; t += 0.02) {
      var c = mix(brand, INK, t);
      if (contrast(c, soft) >= 4.5) return c;
    }
    return INK;
  }

  // ---------- 5. ขอบ control สีแบรนด์ (WCAG 1.4.11 >= 3:1) ----------
  function brandLine(brand) {
    if (contrast(brand, CANVAS) >= 3) return brand.toUpperCase();
    for (var t = 0.02; t <= 1.0001; t += 0.02) {
      var c = mix(brand, INK, t);
      if (contrast(c, CANVAS) >= 3) return c;
    }
    return INK;
  }

  // ---------- 6. สีรอง ----------
  // ไม่ใส่ = คำนวณจากสีหลักให้เข้มลง 26% แล้วการันตีว่ายังอ่านออก
  function brandSecondary(brand, picked) {
    var base = picked && /^#?[0-9a-fA-F]{3,6}$/.test(String(picked).trim())
      ? ('#' + String(picked).trim().replace('#', ''))
      : mix(brandSurface(brand), INK, 0.26);
    return brandSurface(base);   // สีรองก็เป็นพื้น จึงผ่านเกณฑ์เดียวกัน
  }

  // ---------- 7. รวมทุกค่า + คำวินิจฉัย ----------
  function deriveAll(brand, secondaryPick) {
    brand = '#' + String(brand).replace('#', '').toUpperCase();
    var surface = brandSurface(brand);
    var on = onBrand(surface);
    var b2 = brandSecondary(brand, secondaryPick);
    var lum = relLum(hexToRgb(brand));
    var notes = [];

    if (surface.toUpperCase() !== brand.toUpperCase()) {
      notes.push({
        level: 'warn',
        title: 'ปรับสีพื้นให้เข้มขึ้นเล็กน้อยแล้ว',
        body: 'สีที่เลือก (' + brand + ') ใช้เป็นพื้นปุ่มแล้วตัวอักษรอ่านไม่ออกตามเกณฑ์ ' +
              'ระบบใช้ ' + surface + ' แทนเฉพาะตอนเป็นพื้น สีที่คุณเลือกยังอยู่ครบในที่อื่น'
      });
    }
    if (lum > 0.62) notes.push({
      level: 'warn', title: 'สีนี้อ่อนมาก',
      body: 'ตัวอักษรบนพื้นจะเป็นสีดำ และโลโก้สีอ่อนจะจมหายไปบนหัวบัตร ลองเลือกสีเข้มกว่านี้'
    });
    if (lum < 0.02) notes.push({
      level: 'warn', title: 'สีนี้เกือบดำ',
      body: 'ใช้ได้ แต่บัตรจะดูเป็นขาวดำ แบรนด์จะไม่โดดเด่น ถ้าโลโก้มีสีอื่นลองเลือกสีนั้นแทน'
    });

    return {
      brand: brand,
      brandSurface: surface,
      onBrand: on,
      brandInk: brandInk(brand),
      brandSoft: brandSoft(brand),
      brandLine: brandLine(brand),
      brand2: b2,
      onBrand2: onBrand(b2),
      ratios: {
        onSurface: +contrast(on, surface).toFixed(2),
        inkOnWhite: +contrast(brandInk(brand), WHITE).toFixed(2),
        inkOnSoft: +contrast(brandInk(brand), brandSoft(brand)).toFixed(2),
        lineOnCanvas: +contrast(brandLine(brand), CANVAS).toFixed(2),
        onSecondary: +contrast(onBrand(b2), b2).toFixed(2)
      },
      notes: notes
    };
  }

  // ---------- 8. โลโก้ต้องมีแผ่นขาวรองไหม ----------
  // โลโก้สีเข้มบนหัวบัตรสีเข้ม = มองไม่เห็น ตัดสินจาก contrast ของสีเฉลี่ยโลโก้
  function logoNeedsPlate(logoAvgHex, headerHex) {
    return contrast(logoAvgHex, headerHex) < 2.5;
  }

  // ---------- 9. ดึงสีเด่นจากโลโก้ ----------
  // ลดขนาดลง 120px -> ทิ้งพิกเซลโปร่งใส/ขาว/ดำ -> จัดกลุ่มหยาบ -> เรียงตามจำนวน
  function extractPalette(img, want) {
    want = want || 4;
    var W = 120, cv = (typeof document !== 'undefined')
      ? document.createElement('canvas') : null;
    if (!cv) return [];
    var r = Math.min(W / img.width, W / img.height, 1);
    cv.width = Math.max(1, Math.round(img.width * r));
    cv.height = Math.max(1, Math.round(img.height * r));
    var ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, cv.width, cv.height);
    var d = ctx.getImageData(0, 0, cv.width, cv.height).data;

    var bins = {}, sum = [0, 0, 0], seen = 0;
    for (var i = 0; i < d.length; i += 4) {
      var a = d[i + 3]; if (a < 200) continue;                 // โปร่งใส
      var rr = d[i], gg = d[i + 1], bb = d[i + 2];
      var l = relLum([rr, gg, bb]);
      sum[0] += rr; sum[1] += gg; sum[2] += bb; seen++;
      if (l > 0.90 || l < 0.02) continue;                      // ขาว/ดำ ไม่ใช่สีแบรนด์
      var key = (rr >> 4) + ',' + (gg >> 4) + ',' + (bb >> 4); // 4 บิตต่อช่อง
      if (!bins[key]) bins[key] = { n: 0, r: 0, g: 0, b: 0 };
      var t = bins[key]; t.n++; t.r += rr; t.g += gg; t.b += bb;
    }
    var list = Object.keys(bins).map(function (k) {
      var t = bins[k];
      return { n: t.n, hex: rgbToHex([t.r / t.n, t.g / t.n, t.b / t.n]) };
    }).sort(function (x, y) { return y.n - x.n; });

    // รวมสีที่ใกล้กันเกินไป ไม่งั้นได้เฉดเดียวกัน 4 ช่อง
    var out = [];
    for (var j = 0; j < list.length && out.length < want; j++) {
      var ok = true;
      for (var k2 = 0; k2 < out.length; k2++) {
        var p = hexToRgb(list[j].hex), q = hexToRgb(out[k2].hex);
        var dist = Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]);
        if (dist < 60) { ok = false; break; }
      }
      if (ok) out.push(list[j]);
    }
    return {
      colors: out.map(function (o) { return o.hex; }),
      avg: seen ? rgbToHex([sum[0] / seen, sum[1] / seen, sum[2] / seen]) : '#888888'
    };
  }

  var API = {
    hexToRgb: hexToRgb, rgbToHex: rgbToHex, relLum: relLum, contrast: contrast, mix: mix,
    onBrand: onBrand, brandSurface: brandSurface, brandInk: brandInk, brandSoft: brandSoft,
    brandLine: brandLine, brandSecondary: brandSecondary, deriveAll: deriveAll,
    logoNeedsPlate: logoNeedsPlate, extractPalette: extractPalette
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  root.Brand = API;
})(typeof window !== 'undefined' ? window : globalThis);
