/*!
 * presets.v1.js - the printers and book sizes this tool offers
 *
 * The printers' names, papers, settings and spine formulas are shared with the printer finder:
 * papers.v1.js and printers.v1.js in ../doujin-printer-finder/ (loaded before this file).
 * This file adds "another printer" (values typed in).
 */
(function () {
  "use strict";

  const S = window.DoujinPrinters;
  if (!S) throw new Error("printers.v1.js (../doujin-printer-finder/) was not loaded");

  const CUSTOM = {
    id: "custom",
    label: "そのほか（数値を入力）",
    bleed: 3, safe: 5, dpi: 350, tac: 300,
    body: [], cover: [],
  };

  window.CoverPresets = { FORMATS: S.FORMATS, PRINTERS: S.PRINTERS.concat([CUSTOM]) };
})();
