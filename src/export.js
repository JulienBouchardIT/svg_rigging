// Export : recompose la pose courante (angles des sliders, pieces
// masquees) en un fichier plat compatible avec loader.js (une piece = un
// <g data-part> autonome, aucune imbrication) et declenche son
// telechargement, joliment formate.

import { SVG_NS } from "./dom.js";
import { state } from "./state.js";
import { computeAbsoluteLayout } from "./model.js";

export function exportTemplate() {
  const absolute = computeAbsoluteLayout();

  const outSvg = document.createElementNS(SVG_NS, "svg");
  outSvg.setAttribute("xmlns", SVG_NS);
  const measureG = document.createElementNS(SVG_NS, "g");
  outSvg.appendChild(measureG);

  // state.order[0] = piece "devant" : on parcourt a l'envers pour l'ajouter
  // en dernier au fichier plat (donc peinte au-dessus des autres).
  const paintOrder = [...state.order].reverse();
  for (const name of paintOrder) {
    if (state.visibility.get(name) === false) continue;
    const part = state.parts.get(name);
    const pos = absolute.get(name);
    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("data-part", name);
    g.setAttribute("transform", `translate(${pos.x}, ${pos.y}) rotate(${pos.angle})`);
    for (const child of part.contentNodes) {
      const clone = child.cloneNode(true);
      // Les joints sont indispensables pour recharger le fichier comme
      // personnage (ce sont eux qui relient les pieces) : toujours
      // exportes, mais invisibles si l'affichage des points est coche off.
      if (clone.classList && clone.classList.contains("joint")) {
        if (state.showLinks) clone.removeAttribute("opacity");
        else clone.setAttribute("opacity", "0");
      }
      g.appendChild(clone);
    }
    measureG.appendChild(g);
  }

  // getBBox() exige que l'element soit attache a un document rendu.
  outSvg.style.position = "absolute";
  outSvg.style.visibility = "hidden";
  document.body.appendChild(outSvg);
  const bbox = measureG.getBBox();
  document.body.removeChild(outSvg);
  outSvg.removeAttribute("style");

  // On aplatit : les <g data-part> deviennent des enfants directs du svg,
  // measureG n'etait qu'un outil de mesure.
  while (measureG.firstChild) outSvg.appendChild(measureG.firstChild);
  outSvg.removeChild(measureG);

  const pad = Math.max(bbox.width, bbox.height, 1) * 0.05;
  outSvg.setAttribute(
    "viewBox",
    `${bbox.x - pad} ${bbox.y - pad} ${bbox.width + pad * 2} ${bbox.height + pad * 2}`
  );

  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' + formatXml(outSvg) + "\n";
  const blob = new Blob([xml], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = state.character;
  a.click();
  URL.revokeObjectURL(url);
}

// Serialisation lisible (un element par ligne, indentation 2 espaces) :
// XMLSerializer sort tout sur une seule ligne, penible a relire/editer.
// Suffisant ici car le document exporte ne contient aucun noeud texte.
function xmlEscape(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

function formatXml(el, indent = "") {
  const attrs = [...el.attributes].map((a) => ` ${a.name}="${xmlEscape(a.value)}"`).join("");
  const children = [...el.children];
  if (!children.length) return `${indent}<${el.tagName}${attrs} />`;
  const inner = children.map((c) => formatXml(c, indent + "  ")).join("\n");
  return `${indent}<${el.tagName}${attrs}>\n${inner}\n${indent}</${el.tagName}>`;
}
