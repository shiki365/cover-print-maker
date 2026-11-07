/*!
 * icc.v1.js - reads a CMYK printer ICC profile and converts sRGB <-> CMYK with it
 *
 * Only what a v2 printer profile with a Lab PCS needs: the lut8 / lut16 tables
 * (mft1 / mft2) of A2B1 and B2A1. The intent is relative colorimetric with black
 * point compensation, the same as Pillow's ImageCms (LittleCMS), so the
 * blackest RGB lands on the darkest black the profile prints.
 *
 * The profile is the user's own file. The tool never ships one (Adobe's licence
 * allows bundling only under its own agreement).
 */
(function (root) {
  "use strict";

  // sRGB primaries adapted to D50 (Bradford), as LittleCMS builds its sRGB profile
  const RGB_TO_XYZ = [
    0.4360747, 0.3850649, 0.1430804,
    0.2225045, 0.7168786, 0.0606169,
    0.0139322, 0.0971045, 0.7141733,
  ];
  const XYZ_TO_RGB = invert3(RGB_TO_XYZ);
  const D50 = [0.9642, 1.0, 0.8249];

  function invert3(m) {
    const [a, b, c, d, e, f, g, h, i] = m;
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
            B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
            C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
  }

  function srgbToLinear(v) {
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }

  function linearToSrgb(v) {
    v = v <= 0 ? 0 : v >= 1 ? 1 : v;
    return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  }

  function labF(t) {
    return t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116;
  }

  function labFInv(t) {
    return t > 6 / 29 ? t * t * t : (116 * t - 16) / (24389 / 27);
  }

  function xyzToLab(x, y, z) {
    const fx = labF(x / D50[0]), fy = labF(y / D50[1]), fz = labF(z / D50[2]);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  }

  function labToXyz(L, a, b) {
    const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
    return [D50[0] * labFInv(fx), D50[1] * labFInv(fy), D50[2] * labFInv(fz)];
  }

  // ---------------------------------------------------------------- reading the profile

  function tagTable(view) {
    const tags = {};
    const n = view.getUint32(128);
    for (let i = 0; i < n; i++) {
      const p = 132 + i * 12;
      const sig = String.fromCharCode(view.getUint8(p), view.getUint8(p + 1), view.getUint8(p + 2), view.getUint8(p + 3));
      tags[sig] = { offset: view.getUint32(p + 4), size: view.getUint32(p + 8) };
    }
    return tags;
  }

  function ascii(view, offset, length) {
    let s = "";
    for (let i = 0; i < length; i++) {
      const c = view.getUint8(offset + i);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  }

  // A lut8 / lut16 as floats in 0..1: input curves, a grid, output curves.
  function readLut(view, offset) {
    const type = ascii(view, offset, 4);
    if (type !== "mft1" && type !== "mft2") throw new Error("unsupported table " + type);
    const wide = type === "mft2";
    const inCh = view.getUint8(offset + 8), outCh = view.getUint8(offset + 9), grid = view.getUint8(offset + 10);
    let p = offset + 48, inN = 256, outN = 256;
    if (wide) {
      inN = view.getUint16(p); outN = view.getUint16(p + 2); p += 4;
    }
    const size = wide ? 2 : 1, max = wide ? 65535 : 255;
    const read = (count) => {
      const a = new Float32Array(count);
      for (let i = 0; i < count; i++, p += size) a[i] = (wide ? view.getUint16(p) : view.getUint8(p)) / max;
      return a;
    };
    const inCurves = [];
    for (let c = 0; c < inCh; c++) inCurves.push(read(inN));
    const clut = read(Math.pow(grid, inCh) * outCh);
    const outCurves = [];
    for (let c = 0; c < outCh; c++) outCurves.push(read(outN));
    return { wide, inCh, outCh, grid, inCurves, clut, outCurves };
  }

  function curve(table, v) {
    const n = table.length - 1;
    const x = (v <= 0 ? 0 : v >= 1 ? 1 : v) * n;
    const i = Math.min(n - 1, Math.floor(x));
    return table[i] + (table[i + 1] - table[i]) * (x - i);
  }

  // 3 inputs, trilinear (LittleCMS switches Lab-input tables to trilinear)
  function clut3(lut, x, y, z, out) {
    const g = lut.grid, n = lut.outCh, m = g - 1;
    const fx = x * m, fy = y * m, fz = z * m;
    const ix = Math.min(m - 1, Math.floor(fx)), iy = Math.min(m - 1, Math.floor(fy)), iz = Math.min(m - 1, Math.floor(fz));
    const rx = fx - ix, ry = fy - iy, rz = fz - iz;
    const sx = g * g * n, sy = g * n, sz = n;
    const base = ix * sx + iy * sy + iz * sz, t = lut.clut;
    for (let c = 0; c < n; c++) {
      const b = base + c;
      const c00 = t[b] + (t[b + sx] - t[b]) * rx;
      const c01 = t[b + sz] + (t[b + sx + sz] - t[b + sz]) * rx;
      const c10 = t[b + sy] + (t[b + sx + sy] - t[b + sy]) * rx;
      const c11 = t[b + sy + sz] + (t[b + sx + sy + sz] - t[b + sy + sz]) * rx;
      const c0 = c00 + (c10 - c00) * ry, c1 = c01 + (c11 - c01) * ry;
      out[c] = c0 + (c1 - c0) * rz;
    }
  }

  // 3 inputs, tetrahedral, at a given offset into the grid (used per K slice)
  function tetra(t, base, sx, sy, sz, rx, ry, rz, n, out, weight) {
    for (let c = 0; c < n; c++) {
      const b = base + c, c0 = t[b];
      let v;
      if (rx >= ry && ry >= rz) v = c0 + (t[b + sx] - c0) * rx + (t[b + sx + sy] - t[b + sx]) * ry + (t[b + sx + sy + sz] - t[b + sx + sy]) * rz;
      else if (rx >= rz && rz >= ry) v = c0 + (t[b + sx] - c0) * rx + (t[b + sx + sy + sz] - t[b + sx + sz]) * ry + (t[b + sx + sz] - t[b + sx]) * rz;
      else if (rz >= rx && rx >= ry) v = c0 + (t[b + sx + sz] - t[b + sz]) * rx + (t[b + sx + sy + sz] - t[b + sx + sz]) * ry + (t[b + sz] - c0) * rz;
      else if (ry >= rx && rx >= rz) v = c0 + (t[b + sx + sy] - t[b + sy]) * rx + (t[b + sy] - c0) * ry + (t[b + sx + sy + sz] - t[b + sx + sy]) * rz;
      else if (ry >= rz && rz >= rx) v = c0 + (t[b + sx + sy + sz] - t[b + sy + sz]) * rx + (t[b + sy] - c0) * ry + (t[b + sy + sz] - t[b + sy]) * rz;
      else v = c0 + (t[b + sx + sy + sz] - t[b + sy + sz]) * rx + (t[b + sy + sz] - t[b + sz]) * ry + (t[b + sz] - c0) * rz;
      out[c] += v * weight;
    }
  }

  // 4 inputs: linear over the first (the outermost grid axis), tetrahedral over the other three (as LittleCMS)
  function clut4(lut, k, x, y, z, out) {
    const g = lut.grid, n = lut.outCh, m = g - 1;
    const fk = k * m, fx = x * m, fy = y * m, fz = z * m;
    const ik = Math.min(m - 1, Math.floor(fk)), ix = Math.min(m - 1, Math.floor(fx));
    const iy = Math.min(m - 1, Math.floor(fy)), iz = Math.min(m - 1, Math.floor(fz));
    const rk = fk - ik, rx = fx - ix, ry = fy - iy, rz = fz - iz;
    const sk = g * g * g * n, sx = g * g * n, sy = g * n, sz = n;
    const base = ix * sx + iy * sy + iz * sz;
    out.fill(0);
    tetra(lut.clut, ik * sk + base, sx, sy, sz, rx, ry, rz, n, out, 1 - rk);
    if (rk > 0) tetra(lut.clut, (ik + 1) * sk + base, sx, sy, sz, rx, ry, rz, n, out, rk);
  }

  function evalLut(lut, input, out) {
    const v = new Float32Array(lut.inCh);
    for (let c = 0; c < lut.inCh; c++) v[c] = curve(lut.inCurves[c], input[c]);
    const mid = new Float32Array(lut.outCh);
    if (lut.inCh === 3) clut3(lut, v[0], v[1], v[2], mid);
    else if (lut.inCh === 4) clut4(lut, v[0], v[1], v[2], v[3], mid);
    else throw new Error("unsupported input channels " + lut.inCh);
    for (let c = 0; c < lut.outCh; c++) out[c] = curve(lut.outCurves[c], mid[c]);
    return out;
  }

  // Lab in the legacy encoding the v2 lut tables use, as 0..1
  function encodeLab(lut, L, a, b, out) {
    if (lut.wide) {
      out[0] = L * 0xff00 / 100 / 65535;
      out[1] = (a + 128) * 256 / 65535;
      out[2] = (b + 128) * 256 / 65535;
    } else {
      out[0] = L / 100;
      out[1] = (a + 128) / 255;
      out[2] = (b + 128) / 255;
    }
    return out;
  }

  function decodeLab(lut, v) {
    if (lut.wide) return [v[0] * 65535 * 100 / 0xff00, v[1] * 65535 / 256 - 128, v[2] * 65535 / 256 - 128];
    return [v[0] * 100, v[1] * 255 - 128, v[2] * 255 - 128];
  }

  // ---------------------------------------------------------------- the profile object

  function load(buffer) {
    const view = new DataView(buffer instanceof ArrayBuffer ? buffer : buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
    if (view.byteLength < 132 || ascii(view, 36, 4) !== "acsp") throw new Error("ICC プロファイルではありません。");
    const space = ascii(view, 16, 4), pcs = ascii(view, 20, 4);
    if (space !== "CMYK") throw new Error("CMYK のプロファイルではありません。");
    if (pcs !== "Lab ") throw new Error("この形のプロファイルには対応していません（PCS が Lab ではない）。");
    const tags = tagTable(view);
    if (!tags.A2B1 && !tags.A2B0) throw new Error("このプロファイルには変換の表がありません。");
    const toCmyk = readLut(view, (tags.B2A1 || tags.B2A0).offset);
    const toLab = readLut(view, (tags.A2B1 || tags.A2B0).offset);
    const perceptual = tags.B2A0 ? readLut(view, tags.B2A0.offset) : toCmyk;
    let name = "";
    if (tags.desc) {
      const d = tags.desc.offset;
      if (ascii(view, d, 4) === "desc") name = ascii(view, d + 12, view.getUint32(d + 8));
      else if (ascii(view, d, 4) === "mluc") {
        const len = view.getUint32(d + 20), off = view.getUint32(d + 24);
        for (let i = 0; i < len; i += 2) name += String.fromCharCode(view.getUint16(d + off + i));
      }
    }
    const tmp4 = new Float32Array(4), tmp3 = new Float32Array(3), enc = new Float32Array(3);

    function labToCmyk(lut, L, a, b) {
      return Array.from(evalLut(lut, encodeLab(lut, L, a, b, enc), new Float32Array(4)));
    }

    function cmykToLab(c) {
      return decodeLab(toLab, evalLut(toLab, c, tmp3));
    }

    // The darkest black the profile prints: Lab 0 through the perceptual table and back
    // (LittleCMS's black point of a CMYK output profile). L only; a, b are taken as 0.
    const bpL = Math.max(0, Math.min(50, cmykToLab(labToCmyk(perceptual, 0, 0, 0))[0]));
    const bp = labToXyz(bpL, 0, 0);

    // sRGB 0..255 -> CMYK 0..1 (four numbers), black point compensated
    function rgbToCmyk(r, g, b, out) {
      const lr = srgbToLinear(r / 255), lg = srgbToLinear(g / 255), lb = srgbToLinear(b / 255);
      const m = RGB_TO_XYZ;
      let x = m[0] * lr + m[1] * lg + m[2] * lb;
      let y = m[3] * lr + m[4] * lg + m[5] * lb;
      let z = m[6] * lr + m[7] * lg + m[8] * lb;
      x = x * (1 - bp[0] / D50[0]) + bp[0];
      y = y * (1 - bp[1] / D50[1]) + bp[1];
      z = z * (1 - bp[2] / D50[2]) + bp[2];
      const lab = xyzToLab(x, y, z);
      return evalLut(toCmyk, encodeLab(toCmyk, lab[0], lab[1], lab[2], enc), out || new Float32Array(4));
    }

    // CMYK 0..1 -> sRGB 0..255 (how the print looks on screen), black point compensated
    function cmykToRgb(c, m, y, k, out) {
      tmp4[0] = c; tmp4[1] = m; tmp4[2] = y; tmp4[3] = k;
      const lab = cmykToLab(tmp4);
      let [X, Y, Z] = labToXyz(lab[0], lab[1], lab[2]);
      X = D50[0] * (X - bp[0]) / (D50[0] - bp[0]);
      Y = D50[1] * (Y - bp[1]) / (D50[1] - bp[1]);
      Z = D50[2] * (Z - bp[2]) / (D50[2] - bp[2]);
      const n = XYZ_TO_RGB;
      out = out || new Float32Array(3);
      out[0] = 255 * linearToSrgb(n[0] * X + n[1] * Y + n[2] * Z);
      out[1] = 255 * linearToSrgb(n[3] * X + n[4] * Y + n[5] * Z);
      out[2] = 255 * linearToSrgb(n[6] * X + n[7] * Y + n[8] * Z);
      return out;
    }

    return { name, blackL: bpL, rgbToCmyk, cmykToRgb };
  }

  // A 3D table over 8-bit RGB for converting whole images fast: g^3 points, tetrahedral in between.
  function rgbGrid(profile, g) {
    g = g || 33;
    const t = new Float32Array(g * g * g * 4), out = new Float32Array(4);
    let p = 0;
    for (let r = 0; r < g; r++)
      for (let gr = 0; gr < g; gr++)
        for (let b = 0; b < g; b++) {
          profile.rgbToCmyk(r * 255 / (g - 1), gr * 255 / (g - 1), b * 255 / (g - 1), out);
          t[p++] = out[0]; t[p++] = out[1]; t[p++] = out[2]; t[p++] = out[3];
        }
    return { grid: g, table: t };
  }

  // RGBA bytes -> CMYK bytes (4 per pixel) through the grid
  function convertImage(grid, rgba, cmyk) {
    const g = grid.grid, m = g - 1, t = grid.table;
    const sx = g * g * 4, sy = g * 4, sz = 4;
    const acc = new Float32Array(4);
    for (let i = 0, o = 0; i < rgba.length; i += 4, o += 4) {
      const fx = rgba[i] * m / 255, fy = rgba[i + 1] * m / 255, fz = rgba[i + 2] * m / 255;
      const ix = Math.min(m - 1, fx | 0), iy = Math.min(m - 1, fy | 0), iz = Math.min(m - 1, fz | 0);
      acc.fill(0);
      tetra(t, ix * sx + iy * sy + iz * sz, sx, sy, sz, fx - ix, fy - iy, fz - iz, 4, acc, 1);
      for (let c = 0; c < 4; c++) {
        const v = Math.round(acc[c] * 255);
        cmyk[o + c] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    }
    return cmyk;
  }

  const api = { load, rgbGrid, convertImage };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.CoverIcc = api;
})(typeof self !== "undefined" ? self : this);
