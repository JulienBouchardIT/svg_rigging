// Point d'entree : cable les elements de la page aux modules et orchestre
// le chargement d'un personnage et l'annulation (Ctrl+Z).

import { els, initDom } from "./dom.js";
import { state, pushUndo, popUndo, clearUndo } from "./state.js";
import { t, getLang, setLang, applyStaticTranslations } from "./i18n.js";
import { buildLinkMap, buildComponents, pickDefaultRoots, findComponentIndex } from "./model.js";
import { loadTemplate, parseTemplate, refreshCharacterList } from "./loader.js";
import { populateUI, setWarning } from "./ui.js";
import { rebuild, applyAllTransforms } from "./render.js";
import { exportTemplate } from "./export.js";

document.addEventListener("DOMContentLoaded", init);

async function init() {
  initDom();
  initSettings();
  initTabs();
  initPanelResize();

  els.exportBtn.addEventListener("click", exportTemplate);

  // Import : charge un fichier SVG local comme personnage courant, sans
  // passer par le serveur (le fichier n'existe que dans la session tant
  // qu'il n'est pas depose dans characters/).
  els.uploadBtn.addEventListener("click", () => els.uploadInput.click());
  els.uploadInput.addEventListener("change", () => {
    const file = els.uploadInput.files[0];
    if (file) uploadCharacter(file);
    els.uploadInput.value = ""; // permet de re-importer le meme fichier
  });

  els.showLinksCheckbox.addEventListener("change", () => {
    state.showLinks = els.showLinksCheckbox.checked;
    document
      .querySelectorAll(".link-point")
      .forEach((c) => c.setAttribute("opacity", state.showLinks ? "1" : "0"));
  });

  els.resetBtn.addEventListener("click", () => {
    pushUndo();
    for (const name of state.angles.keys()) state.angles.set(name, 0);
    document.querySelectorAll(".joint-slider").forEach((s) => (s.value = 0));
    document.querySelectorAll(".joint-value").forEach((s) => (s.textContent = "0°"));
    applyAllTransforms();
  });

  els.rootSelect.addEventListener("change", () => {
    const name = els.rootSelect.value;
    const compIndex = findComponentIndex(name);
    if (compIndex === -1) return;
    pushUndo();
    state.roots.set(compIndex, name);
    rebuild();
  });

  // Changer de personnage repart d'un etat neuf (pose, visibilite, racines)
  // et recadre la vue sur le nouveau contenu.
  els.characterSelect.addEventListener("change", () => {
    state.character = els.characterSelect.value;
    state.angles.clear();
    state.visibility.clear();
    state.roots.clear();
    state.editingPart = null;
    state.hasFitViewport = false;
    load();
  });

  // Recharger rescanne aussi le dossier characters/ (utile apres un export
  // qu'on vient d'y deposer).
  els.reloadBtn.addEventListener("click", async () => {
    await refreshCharacterList();
    await load();
  });

  // La liste s'actualise aussi toute seule : au retour du focus sur la
  // fenetre (on revient du gestionnaire de fichiers apres y avoir depose
  // un export) et a l'ouverture du menu deroulant.
  window.addEventListener("focus", () => refreshCharacterList());
  els.characterSelect.addEventListener("pointerdown", () => refreshCharacterList());

  window.addEventListener("keydown", (evt) => {
    if ((evt.ctrlKey || evt.metaKey) && evt.key.toLowerCase() === "z") {
      evt.preventDefault();
      undo();
    }
  });

  await refreshCharacterList();
  await load();
}

// Reglages (langue, theme) : persistes en localStorage, hors de l'etat
// undo (Ctrl+Z ne doit pas changer la langue ni le theme).
function initSettings() {
  els.settingsBtn.addEventListener("click", () => els.settingsDialog.showModal());
  els.settingsClose.addEventListener("click", () => els.settingsDialog.close());
  // Clic sur le backdrop = fermer. Le contenu vit dans #settings-content
  // (le dialog lui-meme n'a pas de padding), donc un clic dont la cible est
  // le <dialog> ne peut venir que du backdrop.
  els.settingsDialog.addEventListener("click", (evt) => {
    if (evt.target === els.settingsDialog) els.settingsDialog.close();
  });

  els.langSelect.value = getLang();
  els.langSelect.addEventListener("change", () => {
    setLang(els.langSelect.value);
    applyStaticTranslations();
    populateUI(); // regenere tooltips, suffixe (racine) et messages d'info
  });

  // Theme initial : choix memorise, sinon la preference systeme.
  const theme =
    localStorage.getItem("c2c-theme") ||
    (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.dataset.theme = theme;
  els.themeSelect.value = theme;
  els.themeSelect.addEventListener("change", () => {
    document.documentElement.dataset.theme = els.themeSelect.value;
    localStorage.setItem("c2c-theme", els.themeSelect.value);
  });

  applyStaticTranslations();
}

// Onglets Pieces / Articulations : un seul panneau visible a la fois.
function initTabs() {
  const btns = document.querySelectorAll(".tab-btn");
  btns.forEach((btn) => {
    btn.addEventListener("click", () => {
      btns.forEach((b) => b.classList.toggle("active", b === btn));
      els.tabParts.hidden = btn.dataset.tab !== "parts";
      els.tabJoints.hidden = btn.dataset.tab !== "joints";
    });
  });
}

// Largeur du panneau lateral ajustable a la souris (poignee entre le
// panneau et le canvas), bornee et persistee. Double-clic = largeur par
// defaut du CSS.
const PANEL_WIDTH_KEY = "c2c-panel-width";

function initPanelResize() {
  const stored = parseInt(localStorage.getItem(PANEL_WIDTH_KEY), 10);
  if (stored) els.panel.style.width = stored + "px";

  els.panelResizer.addEventListener("pointerdown", (evt) => {
    evt.preventDefault();
    els.panelResizer.setPointerCapture(evt.pointerId);
    els.panelResizer.classList.add("dragging");

    const onMove = (moveEvt) => {
      // Le panneau part du bord gauche : clientX est directement sa largeur.
      const width = Math.min(Math.max(moveEvt.clientX, 220), window.innerWidth * 0.6);
      els.panel.style.width = width + "px";
    };
    const onUp = () => {
      els.panelResizer.removeEventListener("pointermove", onMove);
      els.panelResizer.removeEventListener("pointerup", onUp);
      els.panelResizer.classList.remove("dragging");
      localStorage.setItem(PANEL_WIDTH_KEY, parseInt(els.panel.style.width, 10));
    };
    els.panelResizer.addEventListener("pointermove", onMove);
    els.panelResizer.addEventListener("pointerup", onUp);
  });

  els.panelResizer.addEventListener("dblclick", () => {
    els.panel.style.width = "";
    localStorage.removeItem(PANEL_WIDTH_KEY);
  });
}

async function load() {
  setWarning("");
  try {
    state.parts = await loadTemplate(state.character);
    state.order = [...state.parts.keys()];
    state.linked.clear();
    clearUndo(); // nouveau document : l'historique precedent n'a plus de sens

    buildLinkMap();
    buildComponents();
    pickDefaultRoots();
    populateUI();
    rebuild();
  } catch (err) {
    setWarning(t("err.load", { message: err.message }));
    console.error(err);
  }
}

async function uploadCharacter(file) {
  setWarning("");
  try {
    const parts = parseTemplate(await file.text(), file.name);
    state.character = file.name;
    state.parts = parts;
    state.order = [...parts.keys()];
    state.linked.clear();
    state.angles.clear();
    state.visibility.clear();
    state.roots.clear();
    state.editingPart = null;
    state.hasFitViewport = false;
    clearUndo();

    buildLinkMap();
    buildComponents();
    pickDefaultRoots();
    populateUI();
    rebuild();
    await refreshCharacterList(); // ajoute l'entree du fichier importe au selecteur
  } catch (err) {
    setWarning(t("err.load", { message: err.message }));
    console.error(err);
  }
}

function undo() {
  const snap = popUndo();
  if (!snap) return;
  state.parts = snap.parts;
  state.angles = snap.angles;
  state.visibility = snap.visibility;
  state.roots = snap.roots;
  state.order = snap.order;
  state.linked = snap.linked;

  buildLinkMap();
  buildComponents();
  populateUI();
  rebuild();
}
