// Rendu de la scene SVG. Les pieces sont peintes A PLAT (aucun <g>
// imbrique) : l'arbre couvrant ne sert qu'a calculer les transforms
// absolus. C'est indispensable pour que l'ordre d'empilement choisi par
// drag-and-drop s'applique - avec des <g> imbriques, un enfant serait
// toujours peint par-dessus son parent, quel que soit state.order.
//
// Import circulaire assume avec ui.js et editor.js : les appels ont tous
// lieu a l'execution (jamais au chargement du module), ce que les modules
// ES gerent nativement.

import { SVG_NS, els } from "./dom.js";
import { state } from "./state.js";
import { buildAllTrees, computeAbsoluteTransforms, computeAbsoluteLayout } from "./model.js";
import { addSlidersForTree } from "./ui.js";
import { addEditHandlesForPart } from "./editor.js";

export function rebuild() {
  els.content.innerHTML = "";
  els.jointList.innerHTML = "";
  state.groupEls.clear();
  state.contentEls.clear();
  if (!state.angles.size) {
    for (const name of state.parts.keys()) state.angles.set(name, 0);
  }

  const absolute = new Map();
  for (const { tree, x, y } of buildAllTrees()) {
    computeAbsoluteTransforms(tree, 0, x, y, absolute);
    addSlidersForTree(tree);
  }

  // state.order[0] = devant : parcours inverse pour l'ajouter en dernier
  // au DOM (donc peint au-dessus des autres).
  for (const name of [...state.order].reverse()) {
    const pos = absolute.get(name);
    if (!pos) continue;
    els.content.appendChild(renderPart(name, pos));
  }

  document
    .querySelectorAll(".link-point")
    .forEach((c) => c.setAttribute("opacity", state.showLinks ? "1" : "0"));

  // Les poignees d'edition vivent dans un calque a part, ajoute en dernier
  // (donc peint au-dessus de toutes les pieces) : une piece qui se
  // superpose visuellement ne peut plus jamais les masquer ni intercepter
  // le clic a leur place.
  els.editOverlay = document.createElementNS(SVG_NS, "g");
  els.editOverlay.setAttribute("class", "edit-overlay");
  els.content.appendChild(els.editOverlay);
  if (state.editingPart) addEditHandlesForPart(state.editingPart);

  if (!state.hasFitViewport) {
    fitViewport();
    state.hasFitViewport = true;
  }
}

// Un <g data-part> autonome (aucune imbrication), place par son transform
// absolu. Le contenu dessinable vit dans un sous-groupe dedie pour que le
// toggle afficher/masquer ne touche que le dessin de cette piece.
function renderPart(name, pos) {
  const part = state.parts.get(name);
  const g = document.createElementNS(SVG_NS, "g");
  g.setAttribute("data-part", name);
  g.setAttribute("transform", `translate(${pos.x}, ${pos.y}) rotate(${pos.angle})`);

  const isEditing = state.editingPart === name;
  const contentG = document.createElementNS(SVG_NS, "g");
  contentG.setAttribute("class", "part-content");
  contentG.style.display = state.visibility.get(name) === false ? "none" : "";
  // Quand une autre piece est en edition, celle-ci se desactive visuellement
  // (grisee, non draggable) pour que l'attention reste sur la piece editee.
  contentG.style.opacity = state.editingPart !== null && !isEditing ? "0.3" : "";
  for (const child of part.contentNodes) {
    const clone = child.cloneNode(true);
    if (clone.classList && clone.classList.contains("joint")) {
      clone.classList.add("link-point");
      clone.setAttribute("opacity", state.showLinks || isEditing ? "1" : "0");
    }
    contentG.appendChild(clone);
  }
  g.appendChild(contentG);

  state.groupEls.set(name, g);
  state.contentEls.set(name, contentG);

  return g;
}

export function setPartVisible(name, visible) {
  state.visibility.set(name, visible);
  const contentG = state.contentEls.get(name);
  if (contentG) contentG.style.display = visible ? "" : "none";
}

export function applyAllTransforms() {
  // simplest correct way to reflect a full reset: just rebuild from current state
  rebuild();
}

// Recalcule uniquement les attributs transform des <g> deja presents dans
// le DOM (pas de reconstruction), pour propager un changement d'angle ou
// le deplacement d'un point d'ancrage sans perdre la poignee ou le slider
// en cours de drag (un rebuild() complet les detacherait du document).
export function updateAllTransformsInPlace() {
  for (const [name, pos] of computeAbsoluteLayout()) {
    const g = state.groupEls.get(name);
    if (g) g.setAttribute("transform", `translate(${pos.x}, ${pos.y}) rotate(${pos.angle})`);
  }
}

// Le transform complet d'une piece (translation+rotation cumulees de tous
// ses ancestres) sous forme de chaine, en concatenant l'attribut transform
// de chaque <g> parent jusqu'a els.content. Poser cette chaine telle
// quelle sur un <g> place dans l'overlay reproduit exactement le meme
// positionnement que la piece d'origine (SVG applique la liste de
// transforms nativement), sans avoir a recalculer de matrice a la main.
export function computeFullTransform(pieceG) {
  const chain = [];
  let cur = pieceG;
  while (cur && cur !== els.content) {
    const tf = cur.getAttribute && cur.getAttribute("transform");
    if (tf) chain.unshift(tf);
    cur = cur.parentNode;
  }
  return chain.join(" ");
}

// Adapte le viewBox du <svg> au contenu reellement affiche, avec une marge,
// pour que le personnage reste cadre quel que soit le nombre de pieces ou
// l'angle des articulations.
function fitViewport() {
  let bbox;
  try {
    bbox = els.content.getBBox();
  } catch (e) {
    return; // pas encore dans le DOM / rien a mesurer
  }
  if (!bbox || (bbox.width === 0 && bbox.height === 0)) return;

  const pad = Math.max(bbox.width, bbox.height, 1) * 0.15;
  const x = bbox.x - pad;
  const y = bbox.y - pad;
  const w = bbox.width + pad * 2;
  const h = bbox.height + pad * 2;
  els.svg.setAttribute("viewBox", `${x} ${y} ${w} ${h}`);
}
