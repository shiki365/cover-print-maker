/*!
 * app.v1.js - the page: settings, pictures, preview, checks, export
 *
 * Inputs are tied to the state by attributes:
 *   data-bind="pages"       reads and writes that place in the state ("pos.front.zoom" for nested ones)
 *   data-out="…"            shows the value next to a slider (data-fmt adds a unit)
 *   data-show="a=x|y&b!=z"  shows the row only when the condition holds
 * The settings live in localStorage; the pictures and the ICC profile, being large,
 * in IndexedDB. Nothing leaves the browser.
 */
(function () {
  "use strict";

  const t = (text, vars) => (window.I18n ? window.I18n.t(text, vars) : text);
  const P = window.CoverPresets, B = window.CoverBuild, Icc = window.CoverIcc;
  const $ = sel => document.querySelector(sel);
  const STORE = "doujin-cover.state", TAB = "doujin-cover.tab";
  const PICS = ["front", "back", "spread"];

  // ---------------------------------------------------------------- state

  function defaultState() {
    return {
      printer: "chokotto", bleed: 3, safe: 5, dpi: 350, tac: 300,
      format: "B5", customW: 182, customH: 257, binding: "left",
      spineMode: "auto", pages: 40, body: "shoseki72", coverPaper: "matpost220", spineManual: 2.5,
      mode: "pair", spineColorMode: "auto", spineColor: "#ffffff",
      pos: { front: { x: 0, y: 0, zoom: 1 }, back: { x: 0, y: 0, zoom: 1 }, spread: { x: 0, y: 0, zoom: 1 } },
      fileName: "hyoshi",
      view: { guides: true, proof: false },
    };
  }

  function mergeDefaults(base, saved) {
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return base;
    for (const key of Object.keys(base)) {
      if (!(key in saved)) continue;
      const b = base[key], v = saved[key];
      if (b && typeof b === "object" && !Array.isArray(b)) base[key] = mergeDefaults(b, v);
      else if (typeof v === typeof b) base[key] = v;
    }
    return base;
  }

  const clamp = (v, lo, hi, d) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, +v)) : d);

  function normalize(saved) {
    const s = mergeDefaults(defaultState(), saved);
    if (!P.PRINTERS.some(p => p.id === s.printer)) s.printer = "chokotto";
    if (!P.FORMATS.some(f => f.id === s.format)) s.format = "B5";
    s.bleed = clamp(s.bleed, 0, 10, 3);
    s.safe = clamp(s.safe, 0, 20, 5);
    s.dpi = clamp(s.dpi, 150, 1200, 350);
    s.tac = clamp(s.tac, 200, 400, 300);
    s.customW = clamp(s.customW, 50, 400, 182);
    s.customH = clamp(s.customH, 50, 500, 257);
    s.pages = clamp(Math.round(s.pages), 2, 2000, 40);
    s.spineManual = clamp(s.spineManual, 0, 100, 2.5);
    for (const k of PICS) {
      s.pos[k].x = clamp(s.pos[k].x, -1, 1, 0);
      s.pos[k].y = clamp(s.pos[k].y, -1, 1, 0);
      s.pos[k].zoom = clamp(s.pos[k].zoom, 1, 3, 1);
    }
    const pr = printer(s);
    if (pr.body.length && !pr.body.some(p => p.id === s.body)) s.body = pr.body[0].id;
    if (pr.cover.length && !pr.cover.some(p => p.id === s.coverPaper)) s.coverPaper = pr.cover[0].id;
    return s;
  }

  let state = defaultState();

  function printer(s) {
    return P.PRINTERS.find(p => p.id === (s || state).printer) || P.PRINTERS[0];
  }

  function getPath(path) {
    return path.split(".").reduce((o, k) => (o == null ? o : o[k]), state);
  }

  function setPath(path, value) {
    const keys = path.split(".");
    const last = keys.pop();
    keys.reduce((o, k) => o[k], state)[last] = value;
  }

  // ---------------------------------------------------------------- the book's numbers

  function spineInfo() {
    const pr = printer();
    if (state.spineMode === "manual" || !pr.body.length) return { spine: state.spineManual, calc: null };
    const body = pr.body.find(p => p.id === state.body), cover = pr.cover.find(p => p.id === state.coverPaper);
    const calc = pr.spine(state.pages, body, cover);
    // outside the printer's table: fall back to the typed value
    if (!calc) return { spine: state.spineManual, calc: null, outside: true };
    return { spine: calc.mm, calc };
  }

  // The trim size of one cover in mm. 新書 is the printer's own size when it publishes one.
  function formatSize(f, pr) {
    if (f.id === "custom") return [state.customW, state.customH];
    if (f.id === "shinsho" && pr.shinsho) return pr.shinsho;
    return [f.w, f.h];
  }

  function geometry() {
    const pr = printer();
    const [w, h] = formatSize(P.FORMATS.find(x => x.id === state.format), pr);
    const custom = pr.id === "custom";
    return B.sheet({
      w, h, spine: spineInfo().spine, binding: state.binding,
      bleed: custom ? state.bleed : pr.bleed, safe: custom ? state.safe : pr.safe,
    });
  }

  const dpi = () => (printer().id === "custom" ? state.dpi : printer().dpi);
  const tac = () => (printer().id === "custom" ? state.tac : printer().tac);

  // ---------------------------------------------------------------- storage

  let db = null;

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("doujin-cover", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("kv");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function idb(mode, fn) {
    return new Promise((resolve, reject) => {
      if (!db) return reject(new Error("no database"));
      const tx = db.transaction("kv", mode);
      const req = fn(tx.objectStore("kv"));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
    });
  }

  const idbGet = key => idb("readonly", s => s.get(key));
  const idbPut = (key, value) => idb("readwrite", s => s.put(value, key)).catch(() => {});
  const idbDel = key => idb("readwrite", s => s.delete(key)).catch(() => {});

  let saveTimer = 0;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem(STORE, JSON.stringify(state)); } catch (e) { /* storage unavailable */ }
    }, 400);
  }

  // ---------------------------------------------------------------- pictures and profile

  const pics = { front: null, back: null, spread: null }; // { bitmap, name, width, height, url }
  let profile = null, grid = null, proof = null, lastInk = null;

  async function setPicture(key, blob, name, store) {
    let bitmap;
    try {
      bitmap = await createImageBitmap(blob);
    } catch (e) {
      say(t("画像を読み込めませんでした（{name}）。PNG・JPEG・WebP を使ってください。", { name }), true);
      return;
    }
    if (pics[key]) URL.revokeObjectURL(pics[key].url);
    pics[key] = { bitmap, name, width: bitmap.width, height: bitmap.height, url: URL.createObjectURL(blob) };
    lastInk = null;
    if (store) idbPut("pic." + key, { blob, name });
    renderSlots();
    requestRender();
  }

  function clearPicture(key) {
    if (pics[key]) URL.revokeObjectURL(pics[key].url);
    pics[key] = null;
    lastInk = null;
    idbDel("pic." + key);
    renderSlots();
    requestRender();
  }

  function setProfile(buffer, fileName, store) {
    try {
      profile = Icc.load(buffer);
    } catch (e) {
      profile = null;
      say(t("ICC プロファイルを読めませんでした。") + " " + t(e.message), true);
      return false;
    }
    grid = Icc.rgbGrid(profile, 33);
    proof = B.proofGrid(profile, tac());
    proofTac = tac();
    if (store) idbPut("icc", { buffer, fileName });
    $("#iccState").innerHTML = "";
    const name = document.createElement("span");
    name.className = "icc-name";
    name.textContent = profile.name || fileName;
    $("#iccState").append(t("使うプロファイル: "), name);
    lastInk = null;
    requestRender();
    return true;
  }

  let proofTac = 0;
  function proofGrid() {
    if (!profile) return null;
    if (proofTac !== tac()) { proof = B.proofGrid(profile, tac()); proofTac = tac(); }
    return proof;
  }

  // ---------------------------------------------------------------- the form

  // Printer and paper names are proper nouns, kept as the printer writes them (papers.v1.js),
  // so they never go through t(); the English and Korean pages show printers by their latin name.
  const lang = window.I18n ? window.I18n.lang : "ja";
  const printerName = pr => (pr.latin ? (lang === "ja" ? pr.label : pr.latin) : t(pr.label));
  const paperName = item => item.label + (item.mm != null ? t("（{n}mm）", { n: item.mm }) : "");

  function fillSelect(el, items, value, name = item => t(item.label)) {
    el.innerHTML = "";
    for (const item of items) {
      const o = document.createElement("option");
      o.value = item.id;
      o.textContent = name(item);
      el.append(o);
    }
    el.value = value;
  }

  // In English and Korean, the printers in the order of their latin names ("custom" stays last).
  function printerList() {
    if (lang === "ja") return P.PRINTERS;
    return [...P.PRINTERS].sort((a, b) =>
      (a.id === "custom") - (b.id === "custom") || printerName(a).localeCompare(printerName(b), "en"));
  }

  function fillSelects() {
    fillSelect($("#printer"), printerList(), state.printer, printerName);
    const pr = printer();
    fillSelect($("#format"), P.FORMATS, state.format, f => {
      const [w, h] = formatSize(f, pr);
      return t(f.label, { w, h });
    });
    fillSelect($("#body"), pr.body, state.body, paperName);
    fillSelect($("#coverPaper"), pr.cover, state.coverPaper, paperName);
    // some printers' formulas do not use the cover paper
    $("#coverRow").classList.toggle("off", !pr.cover.length);
    // with no paper list (another printer), the spine is typed in
    const auto = document.querySelector('input[name=spineMode][value=auto]');
    auto.disabled = !pr.body.length;
    if (!pr.body.length && state.spineMode === "auto") state.spineMode = "manual";
  }

  function syncInputs() {
    document.querySelectorAll("[data-bind]").forEach(el => {
      const v = getPath(el.dataset.bind);
      if (el.type === "radio") el.checked = String(v) === el.value;
      else if (el.type === "checkbox") el.checked = !!v;
      else if (document.activeElement !== el || el.type === "range") el.value = v;
    });
    syncOutputs();
    syncShow();
  }

  function syncOutputs() {
    document.querySelectorAll("[data-out]").forEach(el => {
      const v = getPath(el.dataset.out);
      el.value = el.dataset.fmt === "%" ? Math.round(v * 100) + "%" : v + (el.dataset.fmt || "");
    });
  }

  function test(cond) {
    return cond.split("&").every(part => {
      const m = part.match(/^([\w.]+)(!?=)(.*)$/);
      if (!m) return true;
      const hit = m[3].split("|").includes(String(getPath(m[1])));
      return m[2] === "=" ? hit : !hit;
    });
  }

  function syncShow() {
    document.querySelectorAll("[data-show]").forEach(el => { el.hidden = !test(el.dataset.show); });
  }

  function readInput(el) {
    if (el.type === "checkbox") return el.checked;
    if (el.type === "number" || el.type === "range") return Number(el.value);
    return el.value;
  }

  function onInput(ev) {
    const el = ev.target;
    if (!el.dataset || !el.dataset.bind) return;
    if (el.type === "radio" && !el.checked) return;
    // numbers wait for "change" so typing "12" does not draw "1" first
    if (ev.type === "input" && el.type === "number") return;
    setPath(el.dataset.bind, readInput(el));
    const path = el.dataset.bind;
    if (ev.type === "change" || el.type !== "range") {
      state = normalize(state);
      if (path === "printer") applyPrinter();
      if (path === "printer" || path === "format") fillSelects();
      if (path === "mode") renderSlots();
      syncInputs();
    } else {
      syncOutputs();
    }
    if (path !== "view.guides" && path !== "view.proof") lastInk = null;
    scheduleSave();
    requestRender();
  }

  function applyPrinter() {
    const pr = printer();
    if (pr.id !== "custom") Object.assign(state, { bleed: pr.bleed, safe: pr.safe, dpi: pr.dpi, tac: pr.tac });
  }

  // ---------------------------------------------------------------- picture slots

  let pickTarget = null;

  function slotNames() {
    return state.mode === "spread" ? [["spread", t("見開き（表4・背・表1）")]] :
      state.binding === "right" ? [["front", t("表1（表紙）")], ["back", t("表4（裏表紙）")]] :
        [["back", t("表4（裏表紙）")], ["front", t("表1（表紙）")]];
  }

  function renderSlots() {
    const box = $("#slots");
    box.innerHTML = "";
    box.classList.toggle("one", state.mode === "spread");
    for (const [key, name] of slotNames()) {
      const slot = document.createElement("div");
      slot.className = "slot";
      slot.tabIndex = 0;
      slot.setAttribute("role", "button");
      slot.dataset.slot = key;
      const title = document.createElement("div");
      title.className = "name";
      title.textContent = name;
      slot.append(title);
      const p = pics[key];
      if (p) {
        const img = document.createElement("img");
        img.src = p.url;
        img.alt = "";
        const info = document.createElement("div");
        info.className = "info";
        info.textContent = t("{name}（{w} × {h} px）", { name: p.name, w: p.width, h: p.height });
        const clear = document.createElement("button");
        clear.type = "button";
        clear.className = "clear";
        clear.textContent = "×";
        clear.title = t("外す");
        clear.setAttribute("aria-label", t("外す"));
        clear.addEventListener("click", ev => { ev.stopPropagation(); clearPicture(key); });
        slot.append(img, info, clear);
      } else {
        const info = document.createElement("div");
        info.className = "info";
        info.textContent = t("クリックかドロップで画像を入れる");
        slot.append(info);
      }
      slot.setAttribute("aria-label", p ? t("{slot}：{file}", { slot: name, file: p.name }) : name);
      slot.addEventListener("click", () => { pickTarget = key; $("#imageFile").value = ""; $("#imageFile").click(); });
      slot.addEventListener("keydown", ev => {
        if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); slot.click(); }
      });
      slot.addEventListener("dragover", ev => { ev.preventDefault(); slot.classList.add("over"); });
      slot.addEventListener("dragleave", () => slot.classList.remove("over"));
      slot.addEventListener("drop", ev => {
        ev.preventDefault();
        slot.classList.remove("over");
        const file = ev.dataTransfer.files[0];
        if (file) setPicture(key, file, file.name, true);
      });
      box.append(slot);
    }
    renderPosRows();
  }

  function renderPosRows() {
    const box = $("#posRows");
    box.innerHTML = "";
    const keys = slotNames().filter(([k]) => pics[k]);
    $("#posBox").hidden = !keys.length;
    for (const [key, name] of keys) {
      const head = document.createElement("p");
      head.className = "desc";
      head.innerHTML = "";
      const b = document.createElement("b");
      b.textContent = name;
      head.append(b);
      box.append(head);
      for (const [prop, label, min, max, step] of [["zoom", t("拡大"), 1, 3, 0.01], ["x", t("横の位置"), -1, 1, 0.01], ["y", t("縦の位置"), -1, 1, 0.01]]) {
        const row = document.createElement("div");
        row.className = "row";
        const id = `pos-${key}-${prop}`;
        row.innerHTML = `<label for="${id}"></label><div class="with-value"><input type="range" id="${id}" min="${min}" max="${max}" step="${step}" data-bind="pos.${key}.${prop}"><output data-out="pos.${key}.${prop}" data-fmt="%"></output></div>`;
        row.querySelector("label").textContent = label;
        box.append(row);
      }
    }
    const reset = document.createElement("div");
    reset.className = "buttons";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = t("中央に戻す");
    btn.addEventListener("click", () => {
      for (const k of PICS) state.pos[k] = { x: 0, y: 0, zoom: 1 };
      syncInputs();
      scheduleSave();
      requestRender();
    });
    reset.append(btn);
    if (keys.length) box.append(reset);
    syncInputs();
  }

  // ---------------------------------------------------------------- preview

  let renderQueued = false;
  function requestRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; render(); });
  }

  function picsFor() {
    return {
      mode: state.mode,
      front: pics.front && pics.front.bitmap, back: pics.back && pics.back.bitmap, spread: pics.spread && pics.spread.bitmap,
      frontPos: state.pos.front, backPos: state.pos.back, spreadPos: state.pos.spread,
      frontZoom: state.pos.front.zoom, backZoom: state.pos.back.zoom, spreadZoom: state.pos.spread.zoom,
      spineColor: state.spineColorMode === "pick" ? state.spineColor : "",
    };
  }

  let lastSpineColor = null;

  function render() {
    const s = geometry();
    const canvas = $("#preview");
    const cssW = Math.max(200, canvas.parentElement.clientWidth || 600);
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const scale = cssW * ratio / s.width;
    canvas.width = Math.round(s.width * scale);
    canvas.height = Math.round(s.height * scale);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const painted = B.paint(ctx, s, scale, picsFor());
    lastSpineColor = painted.spineColor;
    const pg = state.view.proof ? proofGrid() : null;
    if (pg) {
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      ctx.putImageData(B.applyProof(pg, img), 0, 0);
    }
    if (state.view.guides) B.drawGuides(ctx, s, scale);
    const W = B.px(s.width, dpi() / 25.4), H = B.px(s.height, dpi() / 25.4);
    $("#sizeText").textContent = t("{w} × {h} mm（{pw} × {ph} px）", { w: round(s.width, 2), h: round(s.height, 2), pw: W, ph: H });
    renderChecks(s);
  }

  const round = (v, d) => Math.round(v * Math.pow(10, d)) / Math.pow(10, d);

  // ---------------------------------------------------------------- checks

  function renderChecks(s) {
    const list = [];
    const add = (cls, text) => list.push([cls, text]);
    const d = dpi(), pxmm = d / 25.4;
    const sp = spineInfo();
    add("", t("データの大きさ: {w} × {h} mm（仕上がり {tw} × {th} mm ＋ 塗り足し {b}mm）、{dpi}dpi で {pw} × {ph} px", {
      w: round(s.width, 2), h: round(s.height, 2), tw: round(s.width - s.bleed * 2, 2), th: s.h, b: s.bleed, dpi: d,
      pw: B.px(s.width, pxmm), ph: B.px(s.height, pxmm),
    }));
    if (sp.calc) {
      const how = [sp.calc.text, sp.calc.note && t(sp.calc.note)].filter(Boolean).join(t("、"));
      add("", t("背幅 {n}mm（{how}）。注文画面の背幅と違えば、その値で作り直す", { n: sp.spine, how }));
    } else if (sp.outside) {
      add("warn", t("このページ数は印刷所の早見表にありません。背幅は「数値を入力」の値（{n}mm）を使っています。", { n: sp.spine }));
    } else {
      add("", t("背幅 {n}mm（入力した値）", { n: sp.spine }));
    }
    if (sp.spine < 2) add("warn", t("背がとても細いので、背文字は入れないほうが安全です。"));
    if (state.format === "shinsho" && !printer().shinsho) {
      const [w, h] = formatSize(P.FORMATS.find(x => x.id === "shinsho"), printer());
      add("warn", t("新書の大きさは印刷所によって違います。この印刷所の案内に大きさが無いので {w} × {h} mm で作っています。違えば「大きさを入力」にしてください。", { w, h }));
    }

    const areas = state.mode === "spread" ? [["spread", t("見開き"), s.width]] :
      [["front", t("表1"), s.front[1] - s.front[0]], ["back", t("表4"), s.back[1] - s.back[0]]];
    for (const [key, name, wMm] of areas) {
      const p = pics[key];
      const need = t("{w} × {h} px", { w: B.px(wMm, pxmm), h: B.px(s.height, pxmm) });
      if (!p) {
        add("bad", t("{name} の絵がありません（{dpi}dpi で {need} 必要。塗り足し込み）", { name, dpi: d, need }));
        continue;
      }
      const r = B.report(p, wMm, s.height, state.pos[key].zoom);
      const res = Math.round(r.dpi);
      if (r.dpi >= d * 0.98) add("ok", t("{name}: {w} × {h} px → {dpi}dpi", { name, w: p.width, h: p.height, dpi: res }));
      else add("warn", t("{name}: {w} × {h} px → 約{dpi}dpi。{target}dpi には {need} 必要です（粗く刷られます）", { name, w: p.width, h: p.height, dpi: res, target: d, need }));
      const cx = r.cutX / 2, cy = r.cutY / 2;
      if (cx > 0.5 || cy > 0.5) {
        const where = cx > 0.5 && cy > 0.5 ? t("上下左右") : cx > 0.5 ? t("左右") : t("上下");
        add("warn", t("{name}: 縦横比が合わないため、{where}が切れます（左右 {x}mm・上下 {y}mm ずつ。塗り足しの外）。大事なものが切れないか、ガイドで確かめてください", {
          name, where, x: round(cx, 1), y: round(cy, 1),
        }));
      }
    }
    if (state.mode === "pair" && lastSpineColor) add("", t("背の色 {c}", { c: lastSpineColor }));

    if (!profile) add("warn", t("PDF を書き出すには ICC プロファイルが要ります（「書き出し」のタブ）"));
    else add("ok", t("色の変換: {name}（相対的な色域維持＋黒点の補正）、インク総量 {tac}% まで", { name: profile.name, tac: tac() }));
    if (lastInk) add("ok", t("書き出した PDF: インク総量の最大 {a}% → {b}%", { a: Math.round(lastInk.before), b: Math.round(lastInk.after) }));
    add("", t("黒のベタ塗りは、ムラ・ローラーの跡が出やすいので避けてください（オンデマンド印刷）。"));

    const ul = $("#checks");
    ul.innerHTML = "";
    for (const [cls, text] of list) {
      const li = document.createElement("li");
      if (cls) li.className = cls;
      li.textContent = text;
      ul.append(li);
    }
  }

  // ---------------------------------------------------------------- export

  function say(message, isError) {
    const el = $("#status");
    el.textContent = message;
    el.classList.toggle("error", !!isError);
  }

  function baseName() {
    return (state.fileName || "hyoshi").trim().replace(/[\\/:*?"<>|]/g, "_") || "hyoshi";
  }

  function download(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  const toBlob = (canvas, type) => new Promise(resolve => canvas.toBlob(resolve, type || "image/png"));

  function makeCanvas(w, h) {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
  }

  async function exportGuide(which) {
    const s = geometry(), pxmm = dpi() / 25.4;
    const W = B.px(s.width, pxmm), H = B.px(s.height, pxmm);
    say(t("ガイド画像を作っています…"));
    await new Promise(r => setTimeout(r, 30));
    const full = makeCanvas(W, H);
    B.drawGuides(full.getContext("2d"), s, pxmm, { labels: true, dpi: dpi() });
    let out = full, suffix = t("見開き");
    if (which !== "spread") {
      const [x0, x1] = which === "front" ? s.front : s.back;
      const a = B.px(x0, pxmm), b = B.px(x1, pxmm);
      out = makeCanvas(b - a, H);
      out.getContext("2d").drawImage(full, -a, 0);
      suffix = which === "front" ? t("表1") : t("表4");
    }
    const blob = await toBlob(out);
    download(blob, `${baseName()}_${t("ガイド")}_${suffix}.png`);
    say(t("ガイド画像を書き出しました（{w} × {h} px、{dpi}dpi、背 {spine}mm）。", { w: out.width, h: out.height, dpi: dpi(), spine: s.spine }));
  }

  function missing() {
    const need = state.mode === "spread" ? ["spread"] : ["front", "back"];
    return need.filter(k => !pics[k]);
  }

  let busy = false;

  async function exportPdf() {
    if (busy) return;
    if (!profile) { say(t("先に ICC プロファイルを選んでください。"), true); return; }
    if (missing().length) { say(t("絵が足りません（「絵」のタブ）。"), true); return; }
    const s = geometry(), pxmm = dpi() / 25.4;
    busy = true;
    const bar = $("#progress");
    bar.hidden = false;
    bar.value = 0;
    $("#exportPdf").disabled = true;
    try {
      const W = B.px(s.width, pxmm), H = B.px(s.height, pxmm);
      say(t("絵を組んでいます…"));
      await new Promise(r => setTimeout(r, 30));
      // the scale that makes the sheet exactly W x H px
      const picture = makeCanvas(W, H);
      const pctx = picture.getContext("2d", { willReadFrequently: true });
      pctx.scale(W / (s.width * pxmm), H / (s.height * pxmm));
      B.paint(pctx, s, pxmm, picsFor());
      say(t("CMYK に変えています…"));
      const result = await B.toCmyk({
        picture: pctx, width: W, height: H, grid, tac: tac(),
        onProgress: v => { bar.value = v * 0.9; },
      });
      say(t("PDF にまとめています…"));
      const blob = await B.pdf(result.cmyk, W, H, s, baseName());
      bar.value = 1;
      download(blob, baseName() + ".pdf");
      lastInk = { before: result.maxInkBefore, after: result.maxInk };
      say(t("書き出しました: {name}（{w} × {h} mm、{pw} × {ph} px、CMYK、{mb}MB）。", {
        name: baseName() + ".pdf", w: round(s.width, 2), h: round(s.height, 2), pw: W, ph: H, mb: round(blob.size / 1e6, 1),
      }));
      requestRender();
    } catch (e) {
      console.error(e);
      say(t("書き出しに失敗しました。") + " " + (e && e.message ? t(e.message) : ""), true);
    } finally {
      busy = false;
      bar.hidden = true;
      $("#exportPdf").disabled = false;
    }
  }

  // The print seen back on screen, at half the print resolution, with the guides if they are on.
  async function exportProof() {
    if (!profile) { say(t("先に ICC プロファイルを選んでください。"), true); return; }
    const s = geometry(), scale = dpi() / 25.4 / 2;
    say(t("見え方の画像を作っています…"));
    await new Promise(r => setTimeout(r, 30));
    const c = makeCanvas(B.px(s.width, scale), B.px(s.height, scale));
    const ctx = c.getContext("2d", { willReadFrequently: true });
    B.paint(ctx, s, scale, picsFor());
    ctx.putImageData(B.applyProof(proofGrid(), ctx.getImageData(0, 0, c.width, c.height)), 0, 0);
    if (state.view.guides) B.drawGuides(ctx, s, scale);
    download(await toBlob(c), `${baseName()}_${t("見え方")}.png`);
    say(t("見え方の画像を書き出しました（確認用。入稿には使いません）。"));
  }

  // ---------------------------------------------------------------- tabs

  function selectTab(name, focus) {
    document.querySelectorAll("[role=tab]").forEach(b => {
      const on = b.dataset.tab === name;
      b.setAttribute("aria-selected", on);
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    });
    document.querySelectorAll("[data-panel]").forEach(p => { p.hidden = p.dataset.panel !== name; });
    try { localStorage.setItem(TAB, name); } catch (e) { /* storage unavailable */ }
  }

  function setupTabs() {
    const tabs = [...document.querySelectorAll("[role=tab]")];
    tabs.forEach((b, i) => {
      b.addEventListener("click", () => selectTab(b.dataset.tab));
      b.addEventListener("keydown", ev => {
        const k = ev.key;
        let j = null;
        if (k === "ArrowRight") j = (i + 1) % tabs.length;
        else if (k === "ArrowLeft") j = (i - 1 + tabs.length) % tabs.length;
        else if (k === "Home") j = 0;
        else if (k === "End") j = tabs.length - 1;
        if (j != null) { ev.preventDefault(); selectTab(tabs[j].dataset.tab, true); }
      });
    });
    let saved = null;
    try { saved = localStorage.getItem(TAB); } catch (e) { /* storage unavailable */ }
    selectTab(tabs.some(b => b.dataset.tab === saved) ? saved : "book");
  }

  // ---------------------------------------------------------------- start

  function printerNote() {
    const pr = printer();
    const el = $("#printerNote");
    el.innerHTML = "";
    if (pr.id === "custom") {
      el.textContent = t("塗り足し・安全域・解像度・インク総量は、印刷所の入稿案内の値を入れてください。");
      return;
    }
    el.append(t("塗り足し {b}mm、切れて困るものは仕上がりから {s}mm 内側、CMYK・{dpi}dpi、インク総量 {tac}% まで（このツールでの値）。", { b: pr.bleed, s: pr.safe, dpi: pr.dpi, tac: pr.tac }) + " ");
    if (pr.assumed && pr.assumed.length) {
      const names = { safe: t("安全域"), dpi: t("解像度"), tac: t("インク総量") };
      el.append(t("{list}は印刷所の案内に数値が無いので、このツールの標準値です。", { list: pr.assumed.map(k => names[k]).join(t("、")) }) + " ");
    }
    if (pr.note) el.append(t(pr.note) + " ");
    el.append(link(pr.url, t("印刷所の原稿作成の案内")));
    if (pr.spineUrl) el.append(" / ", link(pr.spineUrl, t("印刷所の背幅の計算")));
  }

  // ---------------------------------------------------------------- coming from the printer finder

  // The printer finder (doujin-printer-finder) links here with ?printer=<id>, and the book it
  // was searching for (&format=<id>&pages=<body pages>). Take them in once, then drop them from
  // the address so a reload keeps whatever is changed afterwards.
  function fromFinder() {
    let q;
    try { q = new URLSearchParams(location.search); } catch (e) { return false; }
    const id = q.get("printer");
    if (!id || !P.PRINTERS.some(p => p.id === id)) return false;
    state.printer = id;
    applyPrinter();
    const format = q.get("format");
    if (format && P.FORMATS.some(f => f.id === format)) state.format = format;
    const pages = Number(q.get("pages"));
    if (Number.isFinite(pages) && pages >= 4) state.pages = Math.round(pages);
    state = normalize(state);
    for (const k of ["printer", "format", "pages"]) q.delete(k);
    const rest = q.toString();
    try { history.replaceState(null, "", location.pathname + (rest ? "?" + rest : "") + location.hash); } catch (e) { /* file:// */ }
    return true;
  }

  function link(href, text) {
    const a = document.createElement("a");
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = text;
    return a;
  }

  async function start() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(STORE) || "null"); } catch (e) { saved = null; }
    state = normalize(saved);
    const picked = fromFinder();
    fillSelects();
    setupTabs();
    if (picked) {
      selectTab("book");
      scheduleSave();
      // after i18n.v1.js has gone through the page (the printer's name is Japanese in every language)
      const tell = () => say(t("印刷所を {name} にしました。", { name: printerName(printer()) }));
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", tell);
      else tell();
    }
    syncInputs();
    printerNote();
    renderSlots();

    document.addEventListener("input", onInput);
    document.addEventListener("change", ev => {
      onInput(ev);
      if (ev.target.dataset && ev.target.dataset.bind === "printer") printerNote();
    });
    $("#imageFile").addEventListener("change", ev => {
      const file = ev.target.files[0];
      if (file && pickTarget) setPicture(pickTarget, file, file.name, true);
    });
    $("#pickIcc").addEventListener("click", () => { $("#iccFile").value = ""; $("#iccFile").click(); });
    $("#iccFile").addEventListener("change", async ev => {
      const file = ev.target.files[0];
      if (!file) return;
      if (setProfile(await file.arrayBuffer(), file.name, true)) say(t("プロファイルを読み込みました。"));
    });
    document.querySelectorAll("[data-guide]").forEach(b => b.addEventListener("click", () => exportGuide(b.dataset.guide)));
    $("#exportPdf").addEventListener("click", exportPdf);
    $("#exportProof").addEventListener("click", exportProof);
    $("#reset").addEventListener("click", () => {
      if (!confirm(t("いまの作業内容を消して、最初の状態に戻します。よろしいですか？"))) return;
      state = defaultState();
      for (const k of PICS) if (pics[k]) clearPicture(k);
      fillSelects();
      syncInputs();
      printerNote();
      renderSlots();
      scheduleSave();
      requestRender();
    });
    window.addEventListener("resize", requestRender);
    requestRender();

    // the saved pictures and profile; give up after 1.5 s (file:// may never answer). The settings
    // are in localStorage, so they keep being saved; pictures are simply not remembered then.
    try {
      db = await Promise.race([openDb(), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 1500))]);
      for (const k of PICS) {
        const v = await idbGet("pic." + k);
        if (v && v.blob) await setPicture(k, v.blob, v.name, false);
      }
      const icc = await idbGet("icc");
      if (icc && icc.buffer) setProfile(icc.buffer, icc.fileName, false);
    } catch (e) {
      db = null;
    }
  }

  start();
})();
