// Le domaine du rig : graphe des points d'attache, composantes connexes,
// arbre couvrant par composante et transforms absolus d'une pose. Aucune
// manipulation du DOM de la page ici (seulement la lecture des attributs
// des pieces chargees).

import { state } from "./state.js";

export const COMPONENT_SPACING = 20;
const ROOT_OFFSET_X = 15;
const ROOT_OFFSET_Y = 10;

export function extractLinks(contentNodes) {
  const links = [];
  for (const el of contentNodes) {
    if (el.classList && el.classList.contains("joint")) {
      const cx = parseFloat(el.getAttribute("cx"));
      const cy = parseFloat(el.getAttribute("cy"));
      if (!Number.isNaN(cx) && !Number.isNaN(cy)) {
        links.push({ id: el.getAttribute("id"), cx, cy });
      }
    }
  }
  return links;
}

// Un id partage par N pieces (N >= 2) cree une paire d'attache pour chaque
// combinaison de 2 pieces. La construction de l'arbre (BFS) se charge
// ensuite de ne garder que les liens utiles : si un id est partage par 3
// pieces ou plus, celle la plus proche de la racine devient le point
// d'ancrage commun et les autres deviennent ses enfants, tous attaches au
// meme endroit (ex: deux jambes sur le meme point de hanche).
function computeLinkGraph(parts) {
  const linkMap = new Map();
  for (const part of parts.values()) {
    for (const link of part.links) {
      if (!linkMap.has(link.id)) linkMap.set(link.id, []);
      linkMap.get(link.id).push({ part: part.name, cx: link.cx, cy: link.cy });
    }
  }

  const edges = [];
  const sharedPoints = [];
  for (const [id, entries] of linkMap.entries()) {
    if (entries.length < 2) continue;
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        edges.push({ id, a: entries[i], b: entries[j] });
      }
    }
    if (entries.length > 2) sharedPoints.push({ id, entries });
  }
  return { linkMap, edges, sharedPoints };
}

function computeComponents(parts, edges, order) {
  const adjacency = new Map();
  for (const name of parts.keys()) adjacency.set(name, []);
  for (const edge of edges) {
    adjacency.get(edge.a.part).push({ neighbor: edge.b.part, edge });
    adjacency.get(edge.b.part).push({ neighbor: edge.a.part, edge });
  }

  const visited = new Set();
  const components = [];
  const sortedNames = order && order.length ? order.filter((n) => parts.has(n)) : [...parts.keys()].sort();
  for (const start of sortedNames) {
    if (visited.has(start)) continue;
    const comp = new Set();
    const queue = [start];
    visited.add(start);
    while (queue.length) {
      const cur = queue.shift();
      comp.add(cur);
      for (const { neighbor } of adjacency.get(cur)) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
    components.push(comp);
  }
  return { components, adjacency };
}

export function buildLinkMap() {
  const g = computeLinkGraph(state.parts);
  state.linkMap = g.linkMap;
  state.edges = g.edges;
  state.sharedPoints = g.sharedPoints;
}

export function buildComponents() {
  const c = computeComponents(state.parts, state.edges, state.order);
  state.components = c.components;
  state.adjacency = c.adjacency;
}

// Choisit automatiquement quelle piece reste fixe (la racine) plutot que
// de pivoter. "hip" est le point central de convention pour ce personnage :
// si une piece du groupe le porte, elle devient candidate. Parmi les
// candidates, une piece nommee "body" est preferee (le tronc), meme si elle
// finit par accumuler plus de points d'attache que ses voisines (bras,
// poitrine...). A defaut, on prend la piece qui a le moins de points
// d'attache (heuristique la moins specifique, en cas de groupe sans hanche).
const CENTRAL_JOINT_NAMES = ["hip"];

function computeDefaultRoot(parts, comp) {
  const byFewestJoints = (a, b) => {
    const diff = parts.get(a).links.length - parts.get(b).links.length;
    return diff !== 0 ? diff : a.localeCompare(b);
  };

  const central = [...comp]
    .filter((name) => parts.get(name).links.some((l) => CENTRAL_JOINT_NAMES.includes(l.id)))
    .sort(byFewestJoints);

  const candidates = central.length ? central : [...comp].sort(byFewestJoints);
  return candidates.includes("body") ? "body" : candidates[0];
}

export function pickDefaultRoots() {
  state.roots.clear();
  state.components.forEach((comp, i) => {
    if (state.roots.has(i) && comp.has(state.roots.get(i))) return;
    state.roots.set(i, computeDefaultRoot(state.parts, comp));
  });
}

export function findComponentIndex(partName) {
  return state.components.findIndex((c) => c.has(partName));
}

// Piece jumelle d'une piece gauche/droite : meme nom avec left <-> right
// (ex: upper_leg_left <-> upper_leg_right). null si elle n'existe pas.
export function counterpartOf(name) {
  let other = null;
  if (name.includes("left")) other = name.replace("left", "right");
  else if (name.includes("right")) other = name.replace("right", "left");
  return other && state.parts.has(other) ? other : null;
}

// La jumelle a modifier en miroir, ou null si le lien n'est pas actif.
export function linkedCounterpart(name) {
  return state.linked.has(name) ? counterpartOf(name) : null;
}

// L'arbre ne sert qu'a calculer les positions (et l'ordre des sliders) :
// la peinture, elle, suit uniquement state.order via le rendu a plat de
// rebuild(). Le tri des enfants garde une liste de sliders stable.
function buildSpanningTree(adjacency, comp, rootName, order) {
  const rank = new Map((order || []).map((name, i) => [name, i]));
  const rankOf = (name) => (rank.has(name) ? rank.get(name) : Infinity);

  const visited = new Set([rootName]);
  const root = { name: rootName, children: [], localPoint: null, parentPoint: null, linkId: null };
  const queue = [root];
  while (queue.length) {
    const node = queue.shift();
    const neighbors = [...adjacency.get(node.name)].sort((a, b) => rankOf(b.neighbor) - rankOf(a.neighbor));
    for (const { neighbor, edge } of neighbors) {
      if (visited.has(neighbor)) continue;
      visited.add(neighbor);
      // figure out which side of the edge belongs to node (parent) vs neighbor (child)
      const parentSide = edge.a.part === node.name ? edge.a : edge.b;
      const childSide = edge.a.part === node.name ? edge.b : edge.a;
      const child = {
        name: neighbor,
        children: [],
        localPoint: { x: childSide.cx, y: childSide.cy }, // in child's own local space
        parentPoint: { x: parentSide.cx, y: parentSide.cy }, // in parent's local space
        linkId: edge.id,
      };
      node.children.push(child);
      queue.push(child);
    }
  }
  return root;
}

// Un arbre couvrant par composante connexe, avec l'offset de placement de
// sa racine sur la scene.
export function buildAllTrees() {
  return state.components.map((comp, i) => ({
    tree: buildSpanningTree(state.adjacency, comp, state.roots.get(i), state.order),
    x: ROOT_OFFSET_X + i * COMPONENT_SPACING,
    y: ROOT_OFFSET_Y,
  }));
}

function rotatePoint(angleDeg, p) {
  const r = (angleDeg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c };
}

// Position + orientation absolues (translation ET rotation, cumulees le
// long de l'arbre) de chaque piece dans sa pose actuelle : les rotations
// 2D se cumulent par simple addition d'angles, ce qui permet un rendu et
// un export a plat (aucune piece imbriquee dans une autre) tout en
// conservant la pose exacte.
export function computeAbsoluteTransforms(node, parentAngle, parentX, parentY, out) {
  let angle, x, y;
  if (node.parentPoint === null) {
    angle = 0;
    x = parentX;
    y = parentY;
  } else {
    const localAngle = state.angles.get(node.name) || 0;
    angle = parentAngle + localAngle;
    const rotatedLocal = rotatePoint(localAngle, node.localPoint);
    const tLocal = { x: node.parentPoint.x - rotatedLocal.x, y: node.parentPoint.y - rotatedLocal.y };
    const rotatedTLocal = rotatePoint(parentAngle, tLocal);
    x = rotatedTLocal.x + parentX;
    y = rotatedTLocal.y + parentY;
  }
  out.set(node.name, { angle, x, y });
  for (const child of node.children) computeAbsoluteTransforms(child, angle, x, y, out);
}

// Le layout complet de la pose courante : partName -> { x, y, angle }.
export function computeAbsoluteLayout() {
  const absolute = new Map();
  for (const { tree, x, y } of buildAllTrees()) {
    computeAbsoluteTransforms(tree, 0, x, y, absolute);
  }
  return absolute;
}
