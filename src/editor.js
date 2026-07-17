// Edition des points d'une piece : poignees draggables sur les points du
// path (ancres + points de controle) et sur les points d'attache (joints),
// avec propagation du meme delta a la piece jumelle liee (toggle 🔗).
//
// Import circulaire assume avec render.js (appels a l'execution seulement).

import { SVG_NS, els } from "./dom.js";
import { state, pushUndo } from "./state.js";
import { buildLinkMap, buildComponents, linkedCounterpart } from "./model.js";
import { parsePathD, serializePathD } from "./path.js";
import { rebuild, computeFullTransform, updateAllTransformsInPlace } from "./render.js";

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
  const srcPaths = part.contentNodes.filter((el) => el.tagName === "path");
  const liveClones = contentG.querySelectorAll("path");

  srcPaths.forEach((srcPathEl, pathIndex) => {
    const liveClone = liveClones[pathIndex];
    const segments = parsePathD(srcPathEl.getAttribute("d"));
    segments.forEach((seg, segIndex) => {
      if (seg.type === "C") {
        addHandle(container, partName, seg.c1, "control", { srcPathEl, liveClone, segIndex, key: "c1" });
        addHandle(container, partName, seg.c2, "control", { srcPathEl, liveClone, segIndex, key: "c2" });
      }
      if (seg.p) {
        addHandle(container, partName, seg.p, "anchor", { srcPathEl, liveClone, segIndex, key: "p" });
      }
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
  control: { r: 0.25, fill: "#4CAF50" },
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
  handle.addEventListener("pointerdown", (evt) => startHandleDrag(evt, container, partName, kind, extra, handle));
  container.appendChild(handle);
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
    else updatePathPoint(partName, extra, kind, local.x, local.y);
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

function updatePathPoint(partName, extra, kind, x, y) {
  const { srcPathEl, liveClone, segIndex, key } = extra;
  const segments = parsePathD(srcPathEl.getAttribute("d"));
  const seg = segments[segIndex];
  const point = kind === "anchor" ? seg.p : seg[key];
  const dx = x - point.x;
  const dy = y - point.y;
  if (kind === "anchor") seg.p = { x, y };
  else seg[key] = { x, y };
  const newD = serializePathD(segments);
  srcPathEl.setAttribute("d", newD);
  if (liveClone) liveClone.setAttribute("d", newD);

  propagatePathDelta(partName, extra, kind, dx, dy);
}

// Applique a la piece jumelle liee le meme deplacement (delta, pas valeur
// absolue : chaque piece garde ses propres coordonnees locales). La
// correspondance se fait par position (meme index de path, meme segment),
// les jumelles etant supposees avoir la meme structure de dessin.
function propagatePathDelta(partName, extra, kind, dx, dy) {
  const otherName = linkedCounterpart(partName);
  if (!otherName) return;
  const paths = state.parts.get(partName).contentNodes.filter((el) => el.tagName === "path");
  const otherPaths = state.parts.get(otherName).contentNodes.filter((el) => el.tagName === "path");
  const pathIndex = paths.indexOf(extra.srcPathEl);
  const otherPathEl = otherPaths[pathIndex];
  if (!otherPathEl) return;

  const segments = parsePathD(otherPathEl.getAttribute("d"));
  const seg = segments[extra.segIndex];
  const point = seg && (kind === "anchor" ? seg.p : seg[extra.key]);
  if (!point) return;
  point.x += dx;
  point.y += dy;
  const newD = serializePathD(segments);
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
