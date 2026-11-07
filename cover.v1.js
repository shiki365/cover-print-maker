/*!
 * cover.v1.js - the cover sheet: sizes, guide lines, fitting the pictures, CMYK with
 * an ink limit, and the PDF
 *
 * UI-free: the preview and the export call the same functions. Lengths are mm;
 * a "scale" is pixels per mm. Ported from the author's earlier Python cover script,
 * with right-bound books (front cover on the left) added.
 */
(function () {
  "use strict";

  const t = (text, vars) => (window.I18n ? window.I18n.t(text, vars) : text);
  // Japanese fonts first, then ones with Hangul (Korean guide labels)
  const FONT = '"Yu Gothic", "YuGothic", "Hiragino Sans", "Noto Sans JP", "Meiryo", "Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif';

  // ---------------------------------------------------------------- sizes

  // The whole sheet in mm, origin at the top left of the bleed.
  // Left-bound (horizontal text): back | spine | front. Right-bound: front | spine | back.
  function sheet(o) {
    const { w, h, spine, bleed, safe } = o;
    const width = bleed * 2 + w * 2 + spine, height = bleed * 2 + h;
    const foldL = bleed + w, foldR = foldL + spine;
    const left = [0, foldL], right = [foldR, width];
    const rightBound = o.binding === "right";
    return {
      w, h, spine, bleed, safe, width, height, foldL, foldR, rightBound,
      front: rightBound ? left : right,
      back: rightBound ? right : left,
    };
  }

  function px(mm, scale) {
    return Math.round(mm * scale);
  }

  // ---------------------------------------------------------------- guide lines

  function dashed(ctx, x0, y0, x1, y1, dash, gap) {
    ctx.setLineDash([dash, gap]);
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function label(ctx, x, y, text, sizePx, bold) {
    ctx.font = `${bold ? 700 : 500} ${sizePx}px ${FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.lineWidth = Math.max(2, sizePx / 5);
    ctx.strokeStyle = "rgba(255,255,255,1)";
    ctx.strokeText(text, x, y);
    ctx.fillStyle = "rgba(30,30,30,1)";
    ctx.fillText(text, x, y);
  }

  // Draws onto ctx at `scale` px/mm. opts.labels: the explanations for whoever draws.
  function drawGuides(ctx, s, scale, opts) {
    opts = opts || {};
    const W = s.width * scale, H = s.height * scale, b = s.bleed * scale;
    const trimT = b, trimB = (s.bleed + s.h) * scale;
    const line = Math.max(1, scale * 0.22); // about 3 px at 350 dpi
    ctx.save();
    // the bleed: cut off after printing, but the picture must reach the edge
    ctx.fillStyle = "rgba(255,70,70,0.32)";
    ctx.fillRect(0, 0, W, trimT);
    ctx.fillRect(0, trimB, W, H - trimB);
    ctx.fillRect(0, trimT, b, trimB - trimT);
    ctx.fillRect(W - b, trimT, b, trimB - trimT);
    // the spine
    ctx.fillStyle = "rgba(230,0,200,0.24)";
    ctx.fillRect(s.foldL * scale, 0, s.spine * scale, H);
    ctx.strokeStyle = "rgba(230,0,200,1)";
    ctx.lineWidth = line;
    for (const x of [s.foldL, s.foldR]) {
      ctx.beginPath();
      ctx.moveTo(x * scale, 0);
      ctx.lineTo(x * scale, H);
      ctx.stroke();
    }
    // the trim line of each cover
    ctx.strokeStyle = "rgba(0,150,255,1)";
    ctx.lineWidth = line * 1.6;
    for (const [x0, x1] of [[s.bleed, s.foldL], [s.foldR, s.width - s.bleed]]) {
      ctx.strokeRect(x0 * scale, trimT, (x1 - x0) * scale, trimB - trimT);
    }
    // the safe area: inside the trim and the folds
    ctx.strokeStyle = "rgba(0,160,60,1)";
    ctx.lineWidth = line * 1.3;
    const dash = Math.max(4, scale * 2), gap = Math.max(3, scale * 1.2);
    const sy0 = (s.bleed + s.safe) * scale, sy1 = (s.bleed + s.h - s.safe) * scale;
    for (const [x0, x1] of [[s.bleed + s.safe, s.foldL - s.safe], [s.foldR + s.safe, s.width - s.bleed - s.safe]]) {
      const a = x0 * scale, c = x1 * scale;
      dashed(ctx, a, sy0, c, sy0, dash, gap);
      dashed(ctx, c, sy0, c, sy1, dash, gap);
      dashed(ctx, c, sy1, a, sy1, dash, gap);
      dashed(ctx, a, sy1, a, sy0, dash, gap);
    }
    if (opts.labels) {
      const legend = [
        t("青の線: 仕上がり線（ここで切れる）"),
        t("赤い帯: 塗り足し{n}mm（切り落とされる。絵は外側の端まで描く）", { n: s.bleed }),
        t("緑の点線: 文字・顔・ロゴはこの内側に（仕上がりから{n}mm）", { n: s.safe }),
        t("桃色: 背 {n}mm。背文字は入れないか、ごく小さく", { n: s.spine }),
      ];
      const faces = [[s.back, t("表4（裏表紙）")], [s.front, t("表1（表紙）")]];
      const big = Math.min(9, s.w / 16), small = Math.min(3.6, s.w / 44);
      for (const [[x0, x1], name] of faces) {
        const cx = (x0 + x1) / 2 * scale;
        label(ctx, cx, (s.bleed + s.h * 0.12) * scale, name, big * scale, true);
        legend.forEach((text, i) => label(ctx, cx, (s.bleed + s.h * 0.12 + big * 1.6 + i * small * 1.9) * scale, text, small * scale));
        const sizeText = t("この面: {w} × {h} mm（{pw} × {ph} px、{dpi}dpi）", {
          w: round1(x1 - x0), h: round1(s.height), pw: px(x1 - x0, opts.scaleForText || scale), ph: px(s.height, opts.scaleForText || scale), dpi: opts.dpi || Math.round(scale * 25.4),
        });
        label(ctx, cx, (s.bleed + s.h * 0.12 + big * 1.6 + legend.length * small * 1.9 + small) * scale, sizeText, small * scale);
      }
    }
    ctx.restore();
  }

  function round1(v) {
    return Math.round(v * 10) / 10;
  }

  // ---------------------------------------------------------------- the pictures

  // Where a picture goes to cover an area (cropping what sticks out), and what it costs.
  // pos: -1..1 shifts the crop (0 = centred). zoom >= 1 enlarges further.
  function fit(img, wMm, hMm, scale, pos, zoom) {
    const tw = wMm * scale, th = hMm * scale;
    const k = Math.max(tw / img.width, th / img.height) * (zoom || 1);
    const dw = img.width * k, dh = img.height * k;
    const px_ = pos ? pos.x || 0 : 0, py_ = pos ? pos.y || 0 : 0;
    const dx = (tw - dw) / 2 * (1 + px_), dy = (th - dh) / 2 * (1 + py_);
    return { dx, dy, dw, dh };
  }

  // Report for one picture over its area: its resolution on paper, how much is cut off (mm), ratio.
  function report(img, wMm, hMm, zoom) {
    const k = Math.max(wMm / img.width, hMm / img.height) * (zoom || 1); // mm per source pixel
    const dpi = 25.4 / k;
    const dw = img.width * k, dh = img.height * k;
    return { dpi, cutX: dw - wMm, cutY: dh - hMm, ratio: img.width / img.height, want: wMm / hMm };
  }

  function edgeColour(ctx, x, y, w, h) {
    const d = ctx.getImageData(Math.round(x), Math.round(y), Math.max(1, Math.round(w)), Math.max(1, Math.round(h))).data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
    }
    return [r / n, g / n, b / n];
  }

  function hex(rgb) {
    return "#" + rgb.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
  }

  // Paints the sheet's picture (RGB) onto ctx at scale. Returns what it decided.
  // pics: { mode: "pair"|"spread", front, back, spread, frontPos, backPos, spreadPos, spineColor ("" = auto) }
  function paint(ctx, s, scale, pics) {
    const W = s.width * scale, H = s.height * scale;
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, W, H);
    const out = { spineColor: null };
    if (pics.mode === "spread") {
      if (pics.spread) {
        const f = fit(pics.spread, s.width, s.height, scale, pics.spreadPos, pics.spreadZoom);
        ctx.drawImage(pics.spread, f.dx, f.dy, f.dw, f.dh);
      }
      ctx.restore();
      return out;
    }
    const faces = [["back", s.back], ["front", s.front]];
    for (const [name, [x0, x1]] of faces) {
      const img = pics[name];
      if (!img) continue;
      const f = fit(img, x1 - x0, s.height, scale, pics[name + "Pos"], pics[name + "Zoom"]);
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0 * scale, 0, (x1 - x0) * scale, H);
      ctx.clip();
      ctx.drawImage(img, x0 * scale + f.dx, f.dy, f.dw, f.dh);
      ctx.restore();
    }
    // the spine: the given colour, or the average of the two covers' edges next to it
    let colour = pics.spineColor;
    if (!colour) {
      const strip = 2 * scale, a = s.foldL * scale, c = s.foldR * scale;
      const left = pics[s.rightBound ? "front" : "back"], right = pics[s.rightBound ? "back" : "front"];
      const cols = [];
      if (left) cols.push(edgeColour(ctx, a - strip, 0, strip, H));
      if (right) cols.push(edgeColour(ctx, c, 0, strip, H));
      colour = cols.length ? hex([0, 1, 2].map(i => cols.reduce((sum, col) => sum + col[i], 0) / cols.length)) : "#ffffff";
    }
    ctx.fillStyle = colour;
    ctx.fillRect(s.foldL * scale, 0, (s.foldR - s.foldL) * scale, H);
    out.spineColor = colour;
    ctx.restore();
    return out;
  }

  // ---------------------------------------------------------------- CMYK

  const tick = () => new Promise(resolve => setTimeout(resolve, 0));

  // RGBA picture -> CMYK bytes with the total ink held to tac %. Works in bands so the page keeps responding.
  async function toCmyk(o) {
    const { picture, width, height, grid, tac, onProgress } = o;
    const out = new Uint8Array(width * height * 4);
    const limit = tac * 2.55;
    let before = 0, after = 0;
    const band = 128;
    for (let y0 = 0; y0 < height; y0 += band) {
      const rows = Math.min(band, height - y0);
      const rgba = picture.getImageData(0, y0, width, rows).data;
      const part = out.subarray(y0 * width * 4, (y0 + rows) * width * 4);
      window.CoverIcc.convertImage(grid, rgba, part);
      for (let i = 0; i < part.length; i += 4) {
        let c = part[i], m = part[i + 1], y = part[i + 2], k = part[i + 3];
        const total = c + m + y + k;
        if (total > before) before = total;
        const over = total - limit;
        if (over > 0) {
          const cmy = c + m + y;
          const f = cmy > 0 ? Math.max(0, Math.min(1, (cmy - over) / cmy)) : 1;
          c *= f; m *= f; y *= f;
        }
        c = Math.floor(c); m = Math.floor(m); y = Math.floor(y); k = Math.floor(k);
        part[i] = c; part[i + 1] = m; part[i + 2] = y; part[i + 3] = k;
        const tot = c + m + y + k;
        if (tot > after) after = tot;
      }
      if (onProgress) onProgress((y0 + rows) / height);
      await tick();
    }
    return { cmyk: out, maxInkBefore: before / 2.55, maxInk: after / 2.55 };
  }

  // A table over RGB: how a colour will look printed (CMYK, ink-limited, back on screen).
  function proofGrid(profile, tac, g) {
    g = g || 33;
    const table = new Float32Array(g * g * g * 4), cm = new Float32Array(4), rgb = new Float32Array(3);
    const limit = tac / 100;
    let p = 0;
    for (let r = 0; r < g; r++)
      for (let gr = 0; gr < g; gr++)
        for (let b = 0; b < g; b++) {
          profile.rgbToCmyk(r * 255 / (g - 1), gr * 255 / (g - 1), b * 255 / (g - 1), cm);
          const total = cm[0] + cm[1] + cm[2] + cm[3], over = total - limit;
          if (over > 0) {
            const cmy = cm[0] + cm[1] + cm[2], f = cmy > 0 ? Math.max(0, (cmy - over) / cmy) : 1;
            cm[0] *= f; cm[1] *= f; cm[2] *= f;
          }
          profile.cmykToRgb(cm[0], cm[1], cm[2], cm[3], rgb);
          table[p++] = rgb[0] / 255; table[p++] = rgb[1] / 255; table[p++] = rgb[2] / 255; table[p++] = 0;
        }
    return { grid: g, table };
  }

  // Applies a proof table to an ImageData in place (the preview only).
  function applyProof(proof, imageData) {
    const d = imageData.data, tmp = new Uint8Array(d.length);
    window.CoverIcc.convertImage(proof, d, tmp);
    for (let i = 0; i < d.length; i += 4) {
      d[i] = tmp[i]; d[i + 1] = tmp[i + 1]; d[i + 2] = tmp[i + 2];
    }
    return imageData;
  }

  // ---------------------------------------------------------------- PDF

  async function deflate(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // One page of the sheet's size, the CMYK image over all of it (Flate), trim box at the bleed.
  async function pdf(cmyk, pxW, pxH, s, title) {
    const pt = 72 / 25.4;
    const w = s.width * pt, h = s.height * pt, b = s.bleed * pt;
    const f = v => v.toFixed(3);
    const data = await deflate(cmyk);
    const enc = new TextEncoder();
    const content = enc.encode(`q ${f(w)} 0 0 ${f(h)} 0 0 cm /Im0 Do Q`);
    const safeTitle = String(title || "cover").replace(/[^\x20-\x7e]/g, "").replace(/[()\\]/g, "") || "cover";
    const objs = [
      [enc.encode("<< /Type /Catalog /Pages 2 0 R >>")],
      [enc.encode("<< /Type /Pages /Kids [3 0 R] /Count 1 >>")],
      [enc.encode(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f(w)} ${f(h)}] /BleedBox [0 0 ${f(w)} ${f(h)}] ` +
        `/TrimBox [${f(b)} ${f(b)} ${f(w - b)} ${f(h - b)}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`)],
      [enc.encode(`<< /Type /XObject /Subtype /Image /Width ${pxW} /Height ${pxH} /ColorSpace /DeviceCMYK ` +
        `/BitsPerComponent 8 /Filter /FlateDecode /Length ${data.length} >>\nstream\n`), data, enc.encode("\nendstream")],
      [enc.encode(`<< /Length ${content.length} >>\nstream\n`), content, enc.encode("\nendstream")],
      [enc.encode(`<< /Title (${safeTitle}) /Producer (doujin cover maker) >>`)],
    ];
    const parts = [enc.encode("%PDF-1.4\n"), new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])];
    let size = parts[0].length + parts[1].length;
    const offsets = [];
    objs.forEach((chunks, i) => {
      offsets.push(size);
      const head = enc.encode(`${i + 1} 0 obj\n`), tail = enc.encode("\nendobj\n");
      parts.push(head, ...chunks, tail);
      size += head.length + chunks.reduce((n, c) => n + c.length, 0) + tail.length;
    });
    const xref = size;
    let tailText = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    tailText += offsets.map(o => String(o).padStart(10, "0") + " 00000 n \n").join("");
    tailText += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info ${objs.length} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    parts.push(enc.encode(tailText));
    return new Blob(parts, { type: "application/pdf" });
  }

  window.CoverBuild = { sheet, px, drawGuides, fit, report, paint, toCmyk, proofGrid, applyProof, pdf, hex };
})();
