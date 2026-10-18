/* PDF identity swap: pictures read and written in their own kind.
 *
 * JPEG, PNG, WebP, BMP and GIF are opened by the browser itself. A TIFF is opened page by page
 * (UTIF, MIT), and written again page by page at its own bit depth (a black-and-white fax stays
 * one bit a pixel, a grey scan grey), LZW-packed, at its own resolution. A HEIC photo is opened
 * with libheif (LGPL); no free HEIC writer runs in a browser, so its copy is a JPEG and is named
 * .jpg, and the report says so. A BMP is written as a BMP, a GIF as a GIF (gifenc, MIT); an
 * animated GIF is not changed.
 */
const PDFSwapPictures = (() => {
  "use strict";
  const KIND = { jpg: "jpeg", jpeg: "jpeg", png: "png", webp: "webp", gif: "gif", bmp: "bmp", tif: "tiff", tiff: "tiff", heic: "heic", heif: "heic" };
  const MIME = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", bmp: "image/bmp" };
  const kindOf = (path) => { const m = /\.([a-z0-9]+)$/i.exec(path); return m ? KIND[m[1].toLowerCase()] || null : null; };
  const lossy = (kind) => kind === "jpeg" || kind === "webp" || kind === "heic" || kind === "gif";

  async function browserDecode(bytes, type) {
    const bmp = await createImageBitmap(new Blob([bytes], { type }), { imageOrientation: "from-image" });
    const c = new OffscreenCanvas(bmp.width, bmp.height), x = c.getContext("2d", { willReadFrequently: true });
    x.drawImage(bmp, 0, 0); bmp.close?.();
    return { w: c.width, h: c.height, data: x.getImageData(0, 0, c.width, c.height).data };
  }
  async function browserEncode(img, type, quality) {
    const c = new OffscreenCanvas(img.w, img.h);
    c.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(img.data), img.w, img.h), 0, 0);
    return new Uint8Array(await (await c.convertToBlob({ type, quality })).arrayBuffer());
  }

  /** How many pictures a GIF holds: an animated one is left as it is. */
  function gifFrames(b) {
    if (b.length < 13 || String.fromCharCode(b[0], b[1], b[2]) !== "GIF") return 0;
    let p = 13, frames = 0;
    if (b[10] & 0x80) p += 3 * (1 << ((b[10] & 7) + 1));
    const skipBlocks = () => { while (p < b.length && b[p]) p += b[p] + 1; p++; };
    while (p < b.length) {
      const t = b[p++];
      if (t === 0x3b) break;
      if (t === 0x21) { p++; skipBlocks(); continue; }
      if (t !== 0x2c) break;
      frames++;
      const flags = b[p + 8];
      p += 9;
      if (flags & 0x80) p += 3 * (1 << ((flags & 7) + 1));
      p++; skipBlocks();
    }
    return frames;
  }

  // ---------------------------------------------------------------- TIFF
  function tiffDecode(bytes) {
    const U = globalThis.UTIF, buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const ifds = U.decode(buf), pages = [], info = [];
    let dropped = 0;
    for (const ifd of ifds) {
      // a reduced-size copy of a page (a thumbnail) is not a page of its own, and is not written
      if (ifd.t254 && (ifd.t254[0] & 1)) { dropped++; continue; }
      U.decodeImage(buf, ifd);
      const rgba = U.toRGBA8(ifd);
      pages.push({ w: ifd.width, h: ifd.height, data: new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.length) });
      const bps = ifd.t258 ? ifd.t258[0] : 1, spp = ifd.t277 ? ifd.t277[0] : 1;
      info.push({ bits: bps === 1 && spp === 1 ? 1 : spp >= 3 ? 24 : 8, xres: ifd.t282 ? ifd.t282[0] : 0, yres: ifd.t283 ? ifd.t283[0] : 0, unit: ifd.t296 ? ifd.t296[0] : 2 });
    }
    return { pages, info, dropped };
  }
  /** TIFF's LZW, as libtiff writes it: codes from 9 to 12 bits, most significant bit first, a
   * clear code at the start and whenever the table fills. A code's width grows once the next free
   * code no longer fits (the reader grows one code sooner: the "early change" of the TIFF spec). */
  function lzw(data) {
    const out = [];
    let acc = 0, nbits = 0, width = 9;
    const emit = (code) => { acc = (acc << width) | code; nbits += width; while (nbits >= 8) { out.push((acc >>> (nbits - 8)) & 255); nbits -= 8; } acc &= (1 << nbits) - 1; };
    let dict = new Map(), next = 258;
    const grow = () => {
      next++;
      if (next === 4094) { emit(256); dict = new Map(); next = 258; width = 9; }
      else if (next > (1 << width) - 1 && width < 12) width++;
    };
    emit(256);
    if (data.length) {
      let w = data[0];
      for (let i = 1; i < data.length; i++) {
        const c = data[i], key = w * 256 + c, hit = dict.get(key);
        if (hit !== undefined) { w = hit; continue; }
        emit(w);
        dict.set(key, next);
        grow();
        w = c;
      }
      emit(w);
      grow();
    }
    emit(257);
    if (nbits) out.push((acc << (8 - nbits)) & 255);
    return Uint8Array.from(out);
  }
  function tiffEncode(pages, info) {
    const bodies = pages.map((img, k) => {
      const meta = info[k] || { bits: 24 };
      const { w, h, data } = img;
      let raw;
      if (meta.bits === 1) {
        const row = (w + 7) >> 3; raw = new Uint8Array(row * h);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; if ((data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8 >= 128) raw[y * row + (x >> 3)] |= 0x80 >> (x & 7); }
      } else if (meta.bits === 8) {
        raw = new Uint8Array(w * h);
        for (let i = 0; i < w * h; i++) raw[i] = (data[i * 4] * 77 + data[i * 4 + 1] * 150 + data[i * 4 + 2] * 29) >> 8;
      } else {
        raw = new Uint8Array(w * h * 3);
        for (let i = 0; i < w * h; i++) { raw[i * 3] = data[i * 4]; raw[i * 3 + 1] = data[i * 4 + 1]; raw[i * 3 + 2] = data[i * 4 + 2]; }
      }
      return { img, meta, strip: lzw(raw) };
    });
    // header, then each page's pixels and its directory
    let size = 8;
    const layout = bodies.map((b) => { const at = size; size += b.strip.length + (b.strip.length & 1); const tags = 14; const ifdAt = size; size += 2 + tags * 12 + 4 + 8 * 2 + 6; return { ...b, at, ifdAt }; });
    const out = new Uint8Array(size), dv = new DataView(out.buffer);
    out.set([0x49, 0x49, 42, 0]); dv.setUint32(4, layout.length ? layout[0].ifdAt : 0, true);
    layout.forEach((b, k) => {
      out.set(b.strip, b.at);
      const { w, h } = b.img, bits = b.meta.bits, spp = bits === 24 ? 3 : 1;
      const extraAt = b.ifdAt + 2 + 14 * 12 + 4; // two rationals, then bits per sample for RGB
      const xres = Math.round(b.meta.xres || 300), yres = Math.round(b.meta.yres || b.meta.xres || 300);
      dv.setUint32(extraAt, xres, true); dv.setUint32(extraAt + 4, 1, true);
      dv.setUint32(extraAt + 8, yres, true); dv.setUint32(extraAt + 12, 1, true);
      dv.setUint16(extraAt + 16, 8, true); dv.setUint16(extraAt + 18, 8, true); dv.setUint16(extraAt + 20, 8, true);
      const tags = [
        [254, 4, 1, 0], [256, 4, 1, w], [257, 4, 1, h], [258, 3, spp, spp === 3 ? extraAt + 16 : bits === 1 ? 1 : 8], [259, 3, 1, 5],
        [262, 3, 1, bits === 24 ? 2 : 1], [273, 4, 1, b.at], [277, 3, 1, spp], [278, 4, 1, h], [279, 4, 1, b.strip.length],
        [282, 5, 1, extraAt], [283, 5, 1, extraAt + 8], [284, 3, 1, 1], [296, 3, 1, b.meta.unit || 2],
      ];
      dv.setUint16(b.ifdAt, tags.length, true);
      tags.forEach(([tag, type, count, value], j) => {
        const p = b.ifdAt + 2 + j * 12;
        dv.setUint16(p, tag, true); dv.setUint16(p + 2, type, true); dv.setUint32(p + 4, count, true);
        if (type === 3 && count === 1) dv.setUint16(p + 8, value, true); else dv.setUint32(p + 8, value, true);
      });
      dv.setUint32(b.ifdAt + 2 + tags.length * 12, k + 1 < layout.length ? layout[k + 1].ifdAt : 0, true);
    });
    return out;
  }

  // ---------------------------------------------------------------- what a file says about itself
  // Read from the bytes, because the browser's decoder gives pixels only: a copy is written with
  // the same colour type, palette and resolution its original had. (The resolution a photo or a
  // screenshot states is not used for reading it: a camera's 72 says nothing about the page.)
  const u32 = (b, p) => ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
  const ascii = (b, p, n) => String.fromCharCode(...b.subarray(p, p + n));
  // the chunks that decide how a PNG's colours look, and its resolution; text chunks are not kept
  const PNG_KEEP = new Set(["gAMA", "cHRM", "sRGB", "iCCP", "pHYs"]);
  function pngHeader(b) {
    if (b.length < 33 || ascii(b, 1, 3) !== "PNG") return {};
    const meta = { depth: b[24], type: b[25], keep: [] };
    for (let p = 8; p + 8 <= b.length;) {
      const len = u32(b, p), kind = ascii(b, p + 4, 4);
      if (kind === "IDAT" || kind === "IEND") break;
      if (PNG_KEEP.has(kind)) meta.keep.push(b.slice(p, p + 12 + len));
      if (kind === "PLTE") meta.plte = b.slice(p + 8, p + 8 + len);
      if (kind === "tRNS") meta.trns = b.slice(p + 8, p + 8 + len);
      if (kind === "pHYs" && b[p + 16] === 1) meta.ppm = u32(b, p + 8);
      p += 12 + len;
    }
    return { png: meta };
  }
  function jpegHeader(b) {
    const out = {};
    // the JFIF segment, when it is the first one, carries the resolution
    if (b[2] === 0xff && b[3] === 0xe0 && ascii(b, 6, 4) === "JFIF") {
      const units = b[13], xd = (b[14] << 8) | b[15], yd = (b[16] << 8) | b[17];
      out.jfif = { units, xd, yd };
    }
    // the camera's rotation flag (EXIF orientation, 1 to 8): a phone stores a photo the way the
    // sensor saw it and says how to turn it to show it
    for (let p = 2; p + 4 < b.length && b[p] === 0xff && b[p + 1] !== 0xda;) {
      const len = (b[p + 2] << 8) | b[p + 3];
      if (b[p + 1] === 0xe1 && ascii(b, p + 4, 6) === "Exif\0\0") {
        const t = p + 10, le = b[t] === 0x49;
        const u16 = (o) => (le ? b[t + o] | (b[t + o + 1] << 8) : (b[t + o] << 8) | b[t + o + 1]);
        const u32 = (o) => (le ? (b[t + o] | (b[t + o + 1] << 8) | (b[t + o + 2] << 16)) + b[t + o + 3] * 2 ** 24 : b[t + o] * 2 ** 24 + ((b[t + o + 1] << 16) | (b[t + o + 2] << 8) | b[t + o + 3]));
        const ifd = u32(4), n = u16(ifd);
        for (let k = 0; k < n && t + ifd + 2 + 12 * k + 12 <= b.length; k++) {
          const e = ifd + 2 + 12 * k;
          if (u16(e) === 0x0112) { const o = u16(e + 8); if (o >= 1 && o <= 8) out.orient = o; }
        }
        break;
      }
      p += 2 + len;
    }
    return out;
  }
  /** A picture shown upright, laid back the way a camera stored it under rotation flag `o`, so
   * that a viewer turning it by that flag shows it upright again. */
  function toStored(img, o) {
    const turned = o >= 5, W = turned ? img.h : img.w, H = turned ? img.w : img.h;
    const out = new Uint8ClampedArray(W * H * 4);
    for (let sy = 0; sy < H; sy++) for (let sx = 0; sx < W; sx++) {
      const [dx, dy] = o === 2 ? [W - 1 - sx, sy] : o === 3 ? [W - 1 - sx, H - 1 - sy] : o === 4 ? [sx, H - 1 - sy] : o === 5 ? [sy, sx] : o === 6 ? [H - 1 - sy, sx] : o === 7 ? [H - 1 - sy, W - 1 - sx] : o === 8 ? [sy, W - 1 - sx] : [sx, sy];
      const si = (sy * W + sx) * 4, di = (dy * img.w + dx) * 4;
      out[si] = img.data[di]; out[si + 1] = img.data[di + 1]; out[si + 2] = img.data[di + 2]; out[si + 3] = img.data[di + 3];
    }
    return { w: W, h: H, data: out };
  }
  /** The rotation flag, and nothing else the camera wrote (where it was, what it was), given back. */
  function withOrientation(jpeg, o) {
    const app1 = Uint8Array.from([0xff, 0xe1, 0, 34, 0x45, 0x78, 0x69, 0x66, 0, 0, 0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, o, 0, 0, 0, 0, 0, 0, 0]);
    const at = jpeg[2] === 0xff && jpeg[3] === 0xe0 ? 4 + ((jpeg[4] << 8) | jpeg[5]) : 2;
    const out = new Uint8Array(jpeg.length + app1.length);
    out.set(jpeg.subarray(0, at)); out.set(app1, at); out.set(jpeg.subarray(at), at + app1.length);
    return out;
  }
  function bmpHeader(b) {
    if (b[0] !== 0x42 || b[1] !== 0x4d) return {};
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const bpp = dv.getUint16(28, true), ppm = dv.getInt32(38, true), ppmY = dv.getInt32(42, true);
    return { bmp: { bpp, ppm, ppmY, topDown: dv.getInt32(22, true) < 0 } };
  }
  function gifHeader(b) {
    if (b.length < 13 || ascii(b, 0, 3) !== "GIF") return {};
    let palette = null, transparent = -1, p = 13;
    if (b[10] & 0x80) { const n = 1 << ((b[10] & 7) + 1); palette = b.slice(13, 13 + 3 * n); p += 3 * n; }
    while (p < b.length) {
      const t = b[p++];
      if (t === 0x21) {
        if (b[p] === 0xf9 && (b[p + 2] & 1)) transparent = b[p + 5];
        p++; while (p < b.length && b[p]) p += b[p] + 1; p++;
        continue;
      }
      if (t === 0x2c) { const flags = b[p + 8]; if (flags & 0x80) { const n = 1 << ((flags & 7) + 1); palette = b.slice(p + 9, p + 9 + 3 * n); } }
      break;
    }
    return { gif: { palette, transparent } };
  }
  const HEADER = { png: pngHeader, jpeg: jpegHeader, bmp: bmpHeader, gif: gifHeader };

  // ---------------------------------------------------------------- PNG
  let CRC = null;
  function crc32(parts) {
    if (!CRC) { CRC = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c >>> 0; } }
    let c = 0xffffffff;
    for (const b of parts) for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function chunk(kind, body) {
    const out = new Uint8Array(12 + body.length), dv = new DataView(out.buffer), name = Uint8Array.from(kind, (ch) => ch.charCodeAt(0));
    dv.setUint32(0, body.length); out.set(name, 4); out.set(body, 8); dv.setUint32(8 + body.length, crc32([name, body]));
    return out;
  }
  /** How few colours a picture holds, as a palette, or null when it holds more than 256. */
  function paletteOf(data, n) {
    const seen = new Map();
    for (let i = 0; i < n; i++) {
      const key = ((data[i * 4] << 24) | (data[i * 4 + 1] << 16) | (data[i * 4 + 2] << 8) | data[i * 4 + 3]) >>> 0;
      if (!seen.has(key)) { if (seen.size === 256) return null; seen.set(key, seen.size); }
    }
    return seen;
  }
  function pngEncode(img, meta = {}) {
    const { w, h, data } = img, n = w * h;
    let opaque = true, grey = true;
    for (let i = 0; i < n; i++) { if (data[i * 4 + 3] !== 255) opaque = false; if (data[i * 4] !== data[i * 4 + 1] || data[i * 4] !== data[i * 4 + 2]) grey = false; }
    // the original's colour type where the pixels still fit it; a 16-bit original is written at 8
    let type = meta.type === undefined ? (opaque ? 2 : 6) : meta.type;
    let pal = null, own = null;
    // a palette picture keeps its own palette: every pixel takes its nearest colour in it, so the
    // new letters are drawn in the colours the picture already had
    if (type === 3 && meta.plte && meta.plte.length >= 3 && (opaque || meta.trns)) own = meta.plte;
    else if (type === 3) { pal = paletteOf(data, n); if (!pal) type = opaque ? 2 : 6; }
    if ((type === 0 || type === 4) && !grey) type = opaque ? 2 : 6;
    if (type === 0 && !opaque) type = 4;
    if (type === 2 && !opaque) type = 6;
    const bpp = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type], stride = w * bpp;
    const px = new Uint8Array(stride * h);
    const transparent = own && meta.trns ? meta.trns.findIndex((a) => a === 0) : -1;
    if (own) px.set(nearestIndex(data, n, own, transparent));
    else for (let i = 0; i < n; i++) {
      const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2], a = data[i * 4 + 3], o = i * bpp;
      if (type === 0) px[o] = r;
      else if (type === 4) { px[o] = r; px[o + 1] = a; }
      else if (type === 2) { px[o] = r; px[o + 1] = g; px[o + 2] = b; }
      else if (type === 6) { px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = a; }
      else px[o] = pal.get(((r << 24) | (g << 16) | (b << 8) | a) >>> 0);
    }
    // each row with the filter that leaves the smallest sum, as most writers choose
    const raw = new Uint8Array((stride + 1) * h), cand = Array.from({ length: 5 }, () => new Uint8Array(stride));
    const step = type === 3 ? 1 : bpp;
    for (let y = 0; y < h; y++) {
      const row = px.subarray(y * stride, (y + 1) * stride), up = y ? px.subarray((y - 1) * stride, y * stride) : null;
      let best = 0, bestSum = Infinity;
      for (let f = 0; f < 5; f++) {
        const c = cand[f];
        let sum = 0;
        for (let x = 0; x < stride; x++) {
          const a = x >= step ? row[x - step] : 0, b = up ? up[x] : 0, cc = up && x >= step ? up[x - step] : 0;
          let pred = 0;
          if (f === 1) pred = a; else if (f === 2) pred = b; else if (f === 3) pred = (a + b) >> 1;
          else if (f === 4) { const q = a + b - cc, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - cc); pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : cc; }
          const v = (row[x] - pred) & 255;
          c[x] = v; sum += v < 128 ? v : 256 - v;
        }
        if (sum < bestSum) { bestSum = sum; best = f; }
      }
      raw[y * (stride + 1)] = best; raw.set(cand[best], y * (stride + 1) + 1);
    }
    const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
    dv.setUint32(0, w); dv.setUint32(4, h); ihdr[8] = 8; ihdr[9] = type;
    const parts = [Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), ...(meta.keep || [])];
    if (own) {
      parts.push(chunk("PLTE", own));
      if (meta.trns) parts.push(chunk("tRNS", meta.trns));
    } else if (pal) {
      const plte = new Uint8Array(pal.size * 3), trns = new Uint8Array(pal.size);
      let anyAlpha = false;
      for (const [key, idx] of pal) { plte[idx * 3] = key >>> 24; plte[idx * 3 + 1] = (key >>> 16) & 255; plte[idx * 3 + 2] = (key >>> 8) & 255; trns[idx] = key & 255; if ((key & 255) !== 255) anyAlpha = true; }
      parts.push(chunk("PLTE", plte));
      if (anyAlpha) parts.push(chunk("tRNS", trns));
    }
    parts.push(chunk("IDAT", globalThis.fflate.zlibSync(raw, { level: 6 })), chunk("IEND", new Uint8Array(0)));
    const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    let at = 0; for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
  }

  /** The JPEG the browser wrote, given the original's resolution back (the browser writes none). */
  function withDensity(jpeg, jfif) {
    if (!jfif) return jpeg;
    if (jpeg[2] === 0xff && jpeg[3] === 0xe0 && ascii(jpeg, 6, 4) === "JFIF") {
      const out = jpeg.slice();
      out[13] = jfif.units; out[14] = jfif.xd >> 8; out[15] = jfif.xd & 255; out[16] = jfif.yd >> 8; out[17] = jfif.yd & 255;
      return out;
    }
    const app0 = Uint8Array.from([0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, jfif.units, jfif.xd >> 8, jfif.xd & 255, jfif.yd >> 8, jfif.yd & 255, 0, 0]);
    const out = new Uint8Array(jpeg.length + app0.length);
    out.set(jpeg.subarray(0, 2)); out.set(app0, 2); out.set(jpeg.subarray(2), 2 + app0.length);
    return out;
  }

  // ---------------------------------------------------------------- BMP and GIF
  /** The colour in `palette` (RGB triples) nearest to each pixel, remembered per colour. */
  function nearestIndex(data, n, palette, transparent) {
    const count = palette.length / 3, index = new Uint8Array(n), memo = new Map();
    for (let i = 0; i < n; i++) {
      if (transparent >= 0 && data[i * 4 + 3] < 128) { index[i] = transparent; continue; }
      const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2], key = (r << 16) | (g << 8) | b;
      let k = memo.get(key);
      if (k === undefined) {
        let best = Infinity;
        for (let j = 0; j < count; j++) {
          if (j === transparent) continue;
          const dr = palette[j * 3] - r, dg = palette[j * 3 + 1] - g, db = palette[j * 3 + 2] - b, d = dr * dr + dg * dg + db * db;
          if (d < best) { best = d; k = j; if (!d) break; }
        }
        memo.set(key, k);
      }
      index[i] = k;
    }
    return index;
  }
  function bmpEncode(img, meta = {}) {
    const { w, h, data } = img, n = w * h;
    const ppm = meta.ppm > 0 ? meta.ppm : 2835, ppmY = meta.ppmY > 0 ? meta.ppmY : ppm, topDown = !!meta.topDown;
    // a palette BMP stays one while its pixels still fit 256 colours; a 32-bit one stays 32-bit
    const pal = meta.bpp && meta.bpp <= 8 ? paletteOf(data, n) : null;
    const bpp = pal ? 8 : meta.bpp === 32 ? 32 : 24, colours = pal ? 256 : 0;
    const row = ((w * bpp) / 8 + 3) & ~3, offset = 54 + colours * 4, size = offset + row * h;
    const out = new Uint8Array(size), dv = new DataView(out.buffer);
    out[0] = 0x42; out[1] = 0x4d; dv.setUint32(2, size, true); dv.setUint32(10, offset, true);
    dv.setUint32(14, 40, true); dv.setInt32(18, w, true); dv.setInt32(22, topDown ? -h : h, true); dv.setUint16(26, 1, true); dv.setUint16(28, bpp, true);
    dv.setUint32(34, row * h, true); dv.setInt32(38, ppm, true); dv.setInt32(42, ppmY, true);
    if (pal) {
      dv.setUint32(46, 256, true);
      for (const [key, idx] of pal) { out[54 + idx * 4] = (key >>> 8) & 255; out[54 + idx * 4 + 1] = (key >>> 16) & 255; out[54 + idx * 4 + 2] = key >>> 24; }
    }
    for (let y = 0; y < h; y++) {
      const src = topDown ? y : h - 1 - y;
      for (let x = 0; x < w; x++) {
        const i = (src * w + x) * 4, o = offset + y * row + x * (bpp / 8);
        if (pal) out[o] = pal.get(((data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) | data[i + 3]) >>> 0);
        else { out[o] = data[i + 2]; out[o + 1] = data[i + 1]; out[o + 2] = data[i]; if (bpp === 32) out[o + 3] = data[i + 3]; }
      }
    }
    return out;
  }
  function gifEncode(img, meta = {}) {
    const G = globalThis.gifenc, rgba = new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.length), n = img.w * img.h;
    const gif = G.GIFEncoder();
    if (meta.palette && meta.palette.length >= 6) {
      // the original's own palette: the picture was already in those colours, and stays in them
      const palette = [];
      for (let j = 0; j < meta.palette.length; j += 3) palette.push([meta.palette[j], meta.palette[j + 1], meta.palette[j + 2]]);
      const index = nearestIndex(rgba, n, meta.palette, meta.transparent);
      gif.writeFrame(index, img.w, img.h, { palette, transparent: meta.transparent >= 0, transparentIndex: Math.max(0, meta.transparent) });
    } else {
      const palette = G.quantize(rgba, 256), index = G.applyPalette(rgba, palette);
      gif.writeFrame(index, img.w, img.h, { palette });
    }
    gif.finish();
    return gif.bytes();
  }

  // ---------------------------------------------------------------- HEIC
  let HEIF = null;
  async function heicDecode(bytes) {
    if (!HEIF) {
      // the bundle is the module itself, or a function that makes it, ready now or once loaded
      const lib = globalThis.libheif;
      HEIF = await (typeof lib === "function" ? lib() : lib);
      if (HEIF && HEIF.ready) await HEIF.ready;
    }
    const dec = new HEIF.HeifDecoder(), images = dec.decode(bytes);
    if (!images || !images.length) throw new Error("the photo could not be opened");
    const im = images[0], w = im.get_width(), h = im.get_height();
    const data = new Uint8ClampedArray(w * h * 4);
    // the pixels arrive in a callback, after the call returns
    const done = await new Promise((resolve) => im.display({ data, width: w, height: h }, resolve));
    for (const x of images) x.free?.();
    if (!done) throw new Error("the photo could not be opened");
    return { w, h, data };
  }

  /** Every page of a picture file, as RGBA, with what is needed to write it back the same way. */
  async function decodeAll(bytes, path) {
    const kind = kindOf(path);
    if (kind === "tiff") { const t = tiffDecode(bytes); return { kind, pages: t.pages, info: t.info, dropped: t.dropped, lossy: false }; }
    if (kind === "heic") return { kind, pages: [await heicDecode(bytes)], info: [], lossy: true };
    if (kind === "gif" && gifFrames(bytes) > 1) throw new Error("an animated GIF is not changed");
    if (!MIME[kind]) throw new Error("a kind of picture this tool does not open");
    const head = HEADER[kind] ? HEADER[kind](bytes) : {};
    // a palette PNG is drawn back into its palette, so it is read back from what was written
    return { kind, pages: [await browserDecode(bytes, MIME[kind])], info: [head], lossy: lossy(kind) || (kind === "png" && !!head.png && head.png.type === 3) };
  }
  /** Pictures written back in their own kind; { bytes, ext } where the kind had to change. */
  async function encodeAll(pages, dec, quality) {
    const head = dec.info[0] || {};
    switch (dec.kind) {
      case "tiff": return { bytes: tiffEncode(pages, dec.info) };
      case "heic": return { bytes: await browserEncode(pages[0], "image/jpeg", quality), ext: ".jpg" };
      case "png": return { bytes: pngEncode(pages[0], head.png) };
      case "jpeg": {
        // stored the way it came: a phone photo stays on its side with its rotation flag
        const o = head.orient || 1;
        const bytes = withDensity(await browserEncode(o === 1 ? pages[0] : toStored(pages[0], o), "image/jpeg", quality), head.jfif);
        return { bytes: o === 1 ? bytes : withOrientation(bytes, o) };
      }
      case "bmp": return { bytes: bmpEncode(pages[0], head.bmp) };
      case "gif": return { bytes: gifEncode(pages[0], head.gif) };
      default: return { bytes: await browserEncode(pages[0], MIME[dec.kind], quality) };
    }
  }
  /** Whether this browser can open the picture: the browser's own kinds always, TIFF and HEIC
   * with their readers in the page. */
  const canRead = (path) => { const k = kindOf(path); return !!k && (k !== "tiff" || !!globalThis.UTIF) && (k !== "heic" || !!globalThis.libheif); };

  return { kindOf, decodeAll, encodeAll, canRead, gifFrames, tiffEncode, tiffDecode, lzw, bmpEncode, pngEncode, gifEncode, pngHeader, jpegHeader, bmpHeader, gifHeader, withDensity, withOrientation, toStored };
})();
globalThis.PDFSwapPictures = PDFSwapPictures;
if (typeof module !== "undefined") module.exports = PDFSwapPictures;
