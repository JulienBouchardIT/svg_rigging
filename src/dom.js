// References DOM partagees par tous les modules, remplies une fois au
// demarrage par initDom(). els.editOverlay est ajoute par render.js a
// chaque rebuild.

export const SVG_NS = "http://www.w3.org/2000/svg";

export const els = {};

export function initDom() {
  els.svg = document.getElementById("stage");
  els.content = document.getElementById("content");
  els.partList = document.getElementById("part-list");
  els.jointList = document.getElementById("joint-list");
  els.warnings = document.getElementById("warnings");
  els.rootSelect = document.getElementById("root-select");
  els.characterSelect = document.getElementById("character-select");
  els.settingsBtn = document.getElementById("settings-btn");
  els.settingsPanel = document.getElementById("settings");
  els.langSelect = document.getElementById("lang-select");
  els.themeSelect = document.getElementById("theme-select");
  els.showLinksCheckbox = document.getElementById("show-links");
  els.resetBtn = document.getElementById("reset-angles");
  els.reloadBtn = document.getElementById("reload");
  els.exportBtn = document.getElementById("export-svg");
}
