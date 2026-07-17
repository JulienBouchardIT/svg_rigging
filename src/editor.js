// Edition des points d'une piece : poignees draggables sur les points du
// path (ancres + points de controle) et sur les points d'attache (joints),
// avec propagation du meme delta a la piece jumelle liee (toggle 🔗).
//
// Import circulaire assume avec render.js (appels a l'execution seulement).

import { SVG_NS, els } from "./dom.js";
import { state, pushUndo } from "./state.js";
import { t } from "./i18n.js";
import { buildLinkMap, buildComponents, pickDefaultRoots, linkedCounterpart } from "./model.js";
import { parsePathD, serializePathD, anchorsFromSegments, catmullRomD } from "./path.js";
import { rebuild, computeFullTransform, updateAllTransformsInPlace } from "./render.js";
import { populateUI } from "./ui.js";

// Le <g> de l'overlay portant le transform complet de la piece en edition :
// repere de conversion pointeur -> coordonnees locales pour les gestes.
let overlayWrapper = null;

export function addEditHandlesForPart(name) {
  const pieceG = state.groupEls.get(name);
  const contentG = state.contentEls.get(name);
  const part = state.parts.get(name);
  if (!pieceG || !contentG || !part) return;

  // Un <g> dans l'overlay, avec le meme transform complet que la piece,
  // mais peint en dernier : les poignees se retrouvent exactement au bon
  // endroit sans jamais etre sous une autre piece.
  const wrapper = document.createElementNS(SVG_NS, "g");
  wrapper.setAttribute("transform", computeFullTransform(pieceG));
  els.editOverlay.appendChild(wrapper);
  overlayWrapper = wrapper;

  addEditHandles(wrapper, contentG, part, name);
}

// Ajoute les poignees draggables d'une piece en edition : les points du/des
// path (ancrages + points de controle des courbes) et ses points d'ancrage
// (jointures). Les autres pieces restent inertes (pas de poignees).
// "container" est le <g> wrapper de l'overlay (meme transform complet que
// la piece, cf computeFullTransform) : les poignees y sont placees avec
// leurs coordonnees locales BRUTES, exactement comme si elles vivaient dans
// la piece elle-meme - seul l'endroit ou elles sont peintes change.
function addEditHandles(container, contentG, part, partName) {
  // Les poignees affichees dependent de l'outil actif : "move" = tous les
  // points, "setting" = seulement les joints (clic = renommer l'id),
  // "resize"/"rotate" = aucune poignee (geste global sur le canvas).
  if (state.editTool === "resize" || state.editTool === "rotate") return;

  const srcPaths = part.contentNodes.filter((el) => el.tagName === "path");
  const liveClones = contentG.querySelectorAll("path");

  // Modele Catmull-Rom : on n'edite que les ancres, les points de controle
  // sont derives des voisines a chaque deplacement — aucune poignee de
  // controle, la courbe reste lisse par construction.
  if (state.editTool === "move") srcPaths.forEach((srcPathEl, pathIndex) => {
    const liveClone = liveClones[pathIndex];
    const { anchors } = anchorsFromSegments(parsePathD(srcPathEl.getAttribute("d")));
    anchors.forEach((a, anchorIndex) => {
      addHandle(container, partName, a, "anchor", { srcPathEl, liveClone, anchorIndex });
    });
  });

  contentG.querySelectorAll("circle.joint").forEach((jointEl) => {
    const cx = parseFloat(jointEl.getAttribute("cx"));
    const cy = parseFloat(jointEl.getAttribute("cy"));
    addHandle(container, partName, { x: cx, y: cy }, "joint", { jointId: jointEl.getAttribute("id"), jointEl });
  });
}

const HANDLE_STYLE = {
  anchor: { r: 0.35, fill: "#2196F3" },
  joint: { r: 0.45, fill: "#FF5722" },
};

function addHandle(container, partName, point, kind, extra) {
  const style = HANDLE_STYLE[kind];
  const handle = document.createElementNS(SVG_NS, "circle");
  handle.setAttribute("cx", point.x);
  handle.setAttribute("cy", point.y);
  handle.setAttribute("r", style.r);
  handle.setAttribute("fill", style.fill);
  handle.setAttribute("fill-opacity", "0.85");
  handle.setAttribute("class", "edit-handle edit-handle-" + kind);
  handle.addEventListener("pointerdown", (evt) => {
    if (state.editTool === "setting") {
      if (kind === "joint") renameJoint(evt, partName, extra);
      return;
    }
    startHandleDrag(evt, container, partName, kind, extra, handle);
  });
  container.appendChild(handle);
}

// Outil "setting" : cliquer un joint permet de renommer son id. C'est l'id
// qui relie les pieces entre elles, donc tout le squelette est recalcule.
function renameJoint(evt, partName, extra) {
  evt.preventDefault();
  evt.stopPropagation();
  const oldId = extra.jointId;
  const newId = window.prompt(t("prompt.jointId"), oldId);
  if (!newId || newId === oldId) return;

  pushUndo();
  const part = state.parts.get(partName);
  const link = part.links.find((l) => l.id === oldId);
  if (link) link.id = newId;
  const srcJoint = part.contentNodes.find(
    (el) => el.classList && el.classList.contains("joint") && el.getAttribute("id") === oldId
  );
  if (srcJoint) srcJoint.setAttribute("id", newId);

  buildLinkMap();
  buildComponents();
  pickDefaultRoots();
  populateUI();
  rebuild();
}

function startHandleDrag(evt, container, partName, kind, extra, handle) {
  evt.preventDefault();
  evt.stopPropagation();
  pushUndo();
  handle.setPointerCapture(evt.pointerId);

  const onMove = (moveEvt) => {
    const pt = els.svg.createSVGPoint();
    pt.x = moveEvt.clientX;
    pt.y = moveEvt.clientY;
    const ctm = container.getScreenCTM();
    if (!ctm) return;
    const local = pt.matrixTransform(ctm.inverse());
    handle.setAttribute("cx", local.x);
    handle.setAttribute("cy", local.y);

    if (kind === "joint") updateJointPosition(partName, extra, local.x, local.y);
    else updateAnchor(partName, extra, local.x, local.y);
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    // Resynchronise proprement l'UI (poignees fraiches, sliders, etc.)
    // maintenant que le drag est termine.
    rebuild();
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

// Deplace une ancre et regenere le d complet en spline lisse passant par
// les ancres (Catmull-Rom -> Bezier). Le contour ferme le reste par
// construction : plus de points de controle a synchroniser, plus de M/S
// coincidents a gerer.
function updateAnchor(partName, extra, x, y) {
  const { srcPathEl, liveClone, anchorIndex } = extra;
  const { anchors, closed } = anchorsFromSegments(parsePathD(srcPathEl.getAttribute("d")));
  const anchor = anchors[anchorIndex];
  if (!anchor) return;
  const dx = x - anchor.x;
  const dy = y - anchor.y;
  anchor.x = x;
  anchor.y = y;

  const newD = catmullRomD(anchors, closed);
  srcPathEl.setAttribute("d", newD);
  if (liveClone) liveClone.setAttribute("d", newD);

  propagateAnchorDelta(partName, extra, dx, dy);
}

// Applique a la piece jumelle liee le meme deplacement (delta, pas valeur
// absolue : chaque piece garde ses propres coordonnees locales), sur
// l'ancre de meme index, puis regenere sa courbe lisse. Les jumelles sont
// supposees avoir la meme structure de dessin.
function propagateAnchorDelta(partName, extra, dx, dy) {
  const otherName = linkedCounterpart(partName);
  if (!otherName) return;
  const paths = state.parts.get(partName).contentNodes.filter((el) => el.tagName === "path");
  const otherPaths = state.parts.get(otherName).contentNodes.filter((el) => el.tagName === "path");
  const pathIndex = paths.indexOf(extra.srcPathEl);
  const otherPathEl = otherPaths[pathIndex];
  if (!otherPathEl) return;

  const { anchors, closed } = anchorsFromSegments(parsePathD(otherPathEl.getAttribute("d")));
  const anchor = anchors[extra.anchorIndex];
  if (!anchor) return;
  anchor.x += dx;
  anchor.y += dy;

  const newD = catmullRomD(anchors, closed);
  otherPathEl.setAttribute("d", newD);

  const otherContent = state.contentEls.get(otherName);
  if (otherContent) {
    const live = otherContent.querySelectorAll("path")[pathIndex];
    if (live) live.setAttribute("d", newD);
  }
}

function updateJointPosition(partName, extra, x, y) {
  const part = state.parts.get(partName);
  const link = part.links.find((l) => l.id === extra.jointId);
  const dx = link ? x - link.cx : 0;
  const dy = link ? y - link.cy : 0;
  if (link) {
    link.cx = x;
    link.cy = y;
  }
  const srcJoint = part.contentNodes.find(
    (el) => el.classList && el.classList.contains("joint") && el.getAttribute("id") === extra.jointId
  );
  if (srcJoint) {
    srcJoint.setAttribute("cx", x);
    srcJoint.setAttribute("cy", y);
  }
  if (extra.jointEl) {
    extra.jointEl.setAttribute("cx", x);
    extra.jointEl.setAttribute("cy", y);
  }

  propagateJointDelta(partName, extra.jointId, dx, dy);

  buildLinkMap();
  buildComponents();
  updateAllTransformsInPlace();
}

// --- Outils resize / rotate ------------------------------------------------
//
// Geste global : cliquer-glisser n'importe ou sur le canvas transforme la
// geometrie de la piece en edition (paths ET joints) autour de son centre.
// Resize : facteur = rapport des distances au centre. Rotate : difference
// d'angle autour du centre. La jumelle liee (🔗) subit la meme
// transformation autour de son propre centre. Tout est calcule a partir
// d'un instantane pris au debut du geste (pas d'accumulation d'erreurs).

export function initTransformGestures() {
  els.svg.addEventListener("pointerdown", (evt) => {
    if (!state.editingPart) return;
    if (state.editTool !== "resize" && state.editTool !== "rotate") return;
    startTransformGesture(evt);
  });
}

function geometryCenter({ paths, links }) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (p) => {
    if (!p) return;
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  };
  for (const segs of paths) for (const seg of segs) { add(seg.p); add(seg.c1); add(seg.c2); }
  for (const l of links) add({ x: l.cx, y: l.cy });
  if (minX === Infinity) return { x: 0, y: 0 };
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

function buildGestureTargets() {
  const names = [state.editingPart];
  const twin = linkedCounterpart(state.editingPart);
  if (twin) names.push(twin);
  return names
    .map((name) => {
      const part = state.parts.get(name);
      const contentG = state.contentEls.get(name);
      if (!part || !contentG) return null;
      const srcPaths = part.contentNodes.filter((el) => el.tagName === "path");
      const originals = {
        paths: srcPaths.map((el) => parsePathD(el.getAttribute("d"))),
        links: part.links.map((l) => ({ ...l })),
      };
      return { part, contentG, srcPaths, originals, center: geometryCenter(originals) };
    })
    .filter(Boolean);
}

// Reapplique la geometrie d'origine transformee par mapPoint (source +
// clones live + links), comme updateAnchor/updateJointPosition mais
// pour tous les points d'un coup.
function applyGeometry(tgt, mapPoint) {
  const liveClones = tgt.contentG.querySelectorAll("path");
  tgt.originals.paths.forEach((segs0, i) => {
    const segs = segs0.map((seg) => {
      const s = { ...seg }; // conserve type ET marqueur smooth
      if (seg.p) s.p = mapPoint(seg.p);
      if (seg.c1) s.c1 = mapPoint(seg.c1);
      if (seg.c2) s.c2 = mapPoint(seg.c2);
      return s;
    });
    const d = serializePathD(segs);
    tgt.srcPaths[i].setAttribute("d", d);
    if (liveClones[i]) liveClones[i].setAttribute("d", d);
  });
  tgt.originals.links.forEach((l0, idx) => {
    const link = tgt.part.links[idx];
    const p = mapPoint({ x: l0.cx, y: l0.cy });
    link.cx = p.x;
    link.cy = p.y;
    const srcJoint = tgt.part.contentNodes.find(
      (el) => el.classList && el.classList.contains("joint") && el.getAttribute("id") === link.id
    );
    if (srcJoint) {
      srcJoint.setAttribute("cx", p.x);
      srcJoint.setAttribute("cy", p.y);
    }
    const live = [...tgt.contentG.querySelectorAll("circle.joint")].find(
      (el) => el.getAttribute("id") === link.id
    );
    if (live) {
      live.setAttribute("cx", p.x);
      live.setAttribute("cy", p.y);
    }
  });
}

function startTransformGesture(evt) {
  const mode = state.editTool;
  const targets = buildGestureTargets();
  if (!targets.length || !overlayWrapper) return;
  evt.preventDefault();
  pushUndo();

  // Le repere reste celui de la piece au debut du geste (le transform du
  // wrapper n'est pas retouche pendant le drag) : la conversion
  // pointeur -> local est stable meme si la piece bouge sous l'effet du
  // deplacement de ses joints.
  const toLocal = (e) => {
    const pt = els.svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const ctm = overlayWrapper.getScreenCTM();
    return ctm ? pt.matrixTransform(ctm.inverse()) : null;
  };
  const start = toLocal(evt);
  if (!start) return;
  const center = targets[0].center; // centre de la piece editee

  const onMove = (moveEvt) => {
    const cur = toLocal(moveEvt);
    if (!cur) return;
    let makeMap;
    if (mode === "resize") {
      const d0 = Math.hypot(start.x - center.x, start.y - center.y) || 1e-6;
      const k = Math.max(Math.hypot(cur.x - center.x, cur.y - center.y) / d0, 0.05);
      makeMap = (c) => (p) => ({ x: c.x + (p.x - c.x) * k, y: c.y + (p.y - c.y) * k });
    } else {
      const angle =
        Math.atan2(cur.y - center.y, cur.x - center.x) -
        Math.atan2(start.y - center.y, start.x - center.x);
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      makeMap = (c) => (p) => ({
        x: c.x + (p.x - c.x) * cos - (p.y - c.y) * sin,
        y: c.y + (p.x - c.x) * sin + (p.y - c.y) * cos,
      });
    }
    // Chaque cible (piece editee, jumelle liee) est transformee autour de
    // son propre centre, avec le meme facteur / le meme angle.
    for (const tgt of targets) applyGeometry(tgt, makeMap(tgt.center));
    buildLinkMap();
    buildComponents();
    updateAllTransformsInPlace();
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    rebuild();
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

// Meme delta sur le joint correspondant de la piece jumelle liee. Les ids
// de joints different entre jumelles (knee_l / knee_r, ou hip partage) :
// la correspondance se fait par position dans la liste des joints, les
// jumelles etant supposees avoir la meme structure.
function propagateJointDelta(partName, jointId, dx, dy) {
  const otherName = linkedCounterpart(partName);
  if (!otherName) return;
  const part = state.parts.get(partName);
  const other = state.parts.get(otherName);
  const index = part.links.findIndex((l) => l.id === jointId);
  const otherLink = other.links[index];
  if (!otherLink) return;
  otherLink.cx += dx;
  otherLink.cy += dy;

  const srcJoint = other.contentNodes.find(
    (el) => el.classList && el.classList.contains("joint") && el.getAttribute("id") === otherLink.id
  );
  if (srcJoint) {
    srcJoint.setAttribute("cx", otherLink.cx);
    srcJoint.setAttribute("cy", otherLink.cy);
  }
  const otherContent = state.contentEls.get(otherName);
  if (otherContent) {
    const live = [...otherContent.querySelectorAll("circle.joint")].find(
      (el) => el.getAttribute("id") === otherLink.id
    );
    if (live) {
      live.setAttribute("cx", otherLink.cx);
      live.setAttribute("cy", otherLink.cy);
    }
  }
}
