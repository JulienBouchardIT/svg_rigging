// Internationalisation. La langue est persistee en localStorage, hors de
// l'etat undo (Ctrl+Z ne doit pas changer la langue). Les textes statiques
// du HTML portent data-i18n (ou data-i18n-title pour les tooltips) et sont
// traduits par applyStaticTranslations() ; les textes generes passent par
// t(cle, variables).

const I18N = {
  fr: {
    "app.title": "Assembleur de personnage 2D",
    "settings.title": "Paramètres",
    "settings.language": "Langue :",
    "settings.theme": "Thème :",
    "settings.light": "Clair",
    "settings.dark": "Sombre",
    "settings.close": "Fermer",
    "label.character": "Personnage :",
    "btn.reload": "Recharger",
    "btn.resetAngles": "Reset angles",
    "btn.export": "Exporter",
    "btn.upload": "Importer",
    "label.showJoints": "afficher les points d'attache",
    "label.root": "Racine :",
    "tab.parts": "Pièces",
    "tab.joints": "Articulations",
    "title.drag": "Glisser pour réordonner (haut = devant)",
    "title.eye": "Afficher / masquer cette pièce",
    "title.edit": "Éditer les points de cette pièce (path et ancrages)",
    "title.link": "Lier à {name} : l'édition modifie les deux pièces",
    "label.rootSuffix": "  (racine)",
    "warn.freeEnd": 'Point "{id}" de "{part}" n\'a pas de correspondance (extrémité libre).',
    "warn.shared": 'Point "{id}" partagé par {count} pièces ({parts}) : toutes attachées au même point d\'ancrage.',
    "err.load": "Erreur de chargement : {message}. Si la page est ouverte en file://, lance un petit serveur local, ex: `python3 -m http.server` puis ouvre http://localhost:8000/",
    "err.notFound": "{path} introuvable ({status})",
    "err.noParts": "aucune pièce (<g data-part>) trouvée dans {file}",
  },
  en: {
    "app.title": "2D Character Assembler",
    "settings.title": "Settings",
    "settings.language": "Language:",
    "settings.theme": "Theme:",
    "settings.light": "Light",
    "settings.dark": "Dark",
    "settings.close": "Close",
    "label.character": "Character:",
    "btn.reload": "Reload",
    "btn.resetAngles": "Reset angles",
    "btn.export": "Export",
    "btn.upload": "Import",
    "label.showJoints": "show attachment points",
    "label.root": "Root:",
    "tab.parts": "Parts",
    "tab.joints": "Joints",
    "title.drag": "Drag to reorder (top = front)",
    "title.eye": "Show / hide this part",
    "title.edit": "Edit this part's points (path and anchors)",
    "title.link": "Link with {name}: editing modifies both parts",
    "label.rootSuffix": "  (root)",
    "warn.freeEnd": 'Point "{id}" of "{part}" has no match (free end).',
    "warn.shared": 'Point "{id}" shared by {count} parts ({parts}): all attached to the same anchor point.',
    "err.load": "Load error: {message}. If the page is opened as file://, start a small local server, e.g. `python3 -m http.server` then open http://localhost:8000/",
    "err.notFound": "{path} not found ({status})",
    "err.noParts": "no part (<g data-part>) found in {file}",
  },
};

let currentLang = localStorage.getItem("c2c-lang") || "en";

export function getLang() {
  return currentLang;
}

export function setLang(lang) {
  currentLang = lang;
  localStorage.setItem("c2c-lang", lang);
}

export function t(key, vars = {}) {
  let text = (I18N[currentLang] && I18N[currentLang][key]) || I18N.en[key] || key;
  for (const [k, v] of Object.entries(vars)) text = text.replaceAll("{" + k + "}", v);
  return text;
}

export function applyStaticTranslations() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.getAttribute("data-i18n"));
  });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => {
    el.title = t(el.getAttribute("data-i18n-title"));
  });
  document.documentElement.lang = currentLang;
}
