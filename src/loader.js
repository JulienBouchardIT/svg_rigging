// Chargement des personnages : fetch + parsing d'un fichier de characters/
// (une piece = un <g data-part="nom">), et decouverte des fichiers
// disponibles pour le selecteur.

import { els } from "./dom.js";
import { state } from "./state.js";
import { t } from "./i18n.js";
import { extractLinks } from "./model.js";

// Parse le contenu d'un fichier personnage (SVG texte) en Map de pieces.
// Utilise pour les fichiers de characters/ ET pour les fichiers importes
// depuis le disque via le bouton Import.
export function parseTemplate(text, file) {
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  const parts = new Map();
  doc.querySelectorAll("[data-part]").forEach((g) => {
    const name = g.getAttribute("data-part");
    const contentNodes = Array.from(g.children);
    parts.set(name, { name, contentNodes, links: extractLinks(contentNodes) });
  });
  if (!parts.size) throw new Error(t("err.noParts", { file }));
  return parts;
}

export async function loadTemplate(file) {
  const path = "characters/" + file;
  const res = await fetch(path);
  if (!res.ok) throw new Error(t("err.notFound", { path, status: res.status }));
  return parseTemplate(await res.text(), file);
}

// Decouvre les fichiers .svg de characters/, dans l'ordre : listing
// d'annuaire du serveur statique (python3 -m http.server le fournit, zero
// maintenance), sinon manifeste characters/characters.json (serveurs sans
// listing : y lister les fichiers a la main). cache: "no-store" pour que
// le navigateur ne resserve pas une vieille liste.
async function fetchCharacterFiles() {
  try {
    const res = await fetch("characters/", { cache: "no-store" });
    if (res.ok) {
      const doc = new DOMParser().parseFromString(await res.text(), "text/html");
      const files = [...doc.querySelectorAll("a[href]")]
        .map((a) => decodeURIComponent(a.getAttribute("href").split("/").pop()))
        .filter((f) => f.endsWith(".svg"))
        .sort();
      if (files.length) return files;
    }
  } catch (e) {
    // pas de listing : on tente le manifeste
  }
  try {
    const res = await fetch("characters/characters.json", { cache: "no-store" });
    if (res.ok) {
      const list = await res.json();
      if (Array.isArray(list)) {
        return list.filter((f) => typeof f === "string" && f.endsWith(".svg")).sort();
      }
    }
  } catch (e) {
    // pas de manifeste non plus : le selecteur retombera sur le fichier courant
  }
  return [];
}

export async function refreshCharacterList() {
  const files = await fetchCharacterFiles();
  if (!files.includes(state.character)) {
    // Fichier courant absent de la liste : avant le premier chargement on
    // bascule sur le premier disponible (defaut inexistant) ; ensuite on
    // garde son entree, car c'est lui qui est encore affiche a l'ecran.
    if (!state.parts.size && files.length) state.character = files[0];
    else files.unshift(state.character);
  }

  // Ne reconstruit les options que si la liste a change : le refresh est
  // declenche souvent (focus, ouverture du menu) et toucher au DOM d'un
  // <select> ouvert le fait cligner inutilement.
  const current = [...els.characterSelect.options].map((o) => o.value);
  if (files.length === current.length && files.every((f, i) => f === current[i])) {
    els.characterSelect.value = state.character;
    return;
  }

  els.characterSelect.innerHTML = "";
  for (const f of files) {
    const opt = document.createElement("option");
    opt.value = f;
    opt.textContent = f.replace(/\.svg$/, "");
    els.characterSelect.appendChild(opt);
  }
  els.characterSelect.value = state.character;
}
