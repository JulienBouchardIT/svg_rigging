// Charge un fichier de characters/ (une piece = un <g data-part="nom">),
// relie automatiquement les points d'attache (cercles class="joint")
// qui portent le meme id entre deux pieces, et permet de poser/afficher
// le personnage de facon interactive.

const SVG_NS = "http://www.w3.org/2000/svg";
const COMPONENT_SPACING = 20;

const state = {
  parts: new Map(),      // name -> { name, contentNodes: [Element], links: [{id,cx,cy}] }
  linkMap: new Map(),    // linkId -> [{part, cx, cy}]
  edges: [],             // { id, a:{part,cx,cy}, b:{part,cx,cy} } - une entree par paire de pieces partageant l'id
  sharedPoints: [],      // linkId partage par plus de 2 pieces (plusieurs membres au meme point d'ancrage)
  components: [],        // array of Set(partName)
  roots: new Map(),      // componentIndex -> partName chosen as root
  angles: new Map(),     // partName -> degrees (its own joint rotation, 0 for roots)
  groupEls: new Map(),   // partName -> the <g> element rendered for it (for fast transform updates)
  contentEls: new Map(), // partName -> the <g> wrapping only its own drawable content (for the show/hide toggle)
  visibility: new Map(), // partName -> false quand la piece est masquee via le toggle
  linked: new Set(),     // pieces left/right liees : editer l'une applique le meme delta a sa jumelle
  showLinks: false,
  hasFitViewport: false, // le cadrage auto ne doit avoir lieu qu'au tout premier chargement
  editingPart: null,     // nom de la piece actuellement en edition (points draggables), ou null
  order: [],             // ordre des pieces choisi par l'utilisateur ; index 0 = devant (au-dessus)
  character: "template.svg", // fichier charge dans characters/, choisi via le selecteur
};

const undoStack = [];
const MAX_UNDO = 50;

const els = {};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  els.svg = document.getElementById("stage");
  els.content = document.getElementById("content");
  els.partList = document.getElementById("part-list");
  els.jointList = document.getElementById("joint-list");
  els.warnings = document.getElementById("warnings");
  els.rootSelect = document.getElementById("root-select");
  els.characterSelect = document.getElementById("character-select");
  els.showLinksCheckbox = document.getElementById("show-links");
  els.resetBtn = document.getElementById("reset-angles");
  els.reloadBtn = document.getElementById("reload");
  els.exportBtn = document.getElementById("export-svg");

  els.exportBtn.addEventListener("click", exportTemplate);

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

// Decouvre les fichiers .svg de characters/ via le listing d'annuaire du
// serveur statique (python3 -m http.server le fournit). Sans listing, le
// selecteur retombe sur le fichier courant seul.
async function refreshCharacterList() {
  let files = [];
  try {
    const res = await fetch("characters/");
    if (res.ok) {
      const doc = new DOMParser().parseFromString(await res.text(), "text/html");
      files = [...doc.querySelectorAll("a[href]")]
        .map((a) => decodeURIComponent(a.getAttribute("href").split("/").pop()))
        .filter((f) => f.endsWith(".svg"))
        .sort();
    }
  } catch (e) {
    // pas de listing disponible : on garde juste le fichier courant
  }
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

// --- Annuler (Ctrl+Z) ------------------------------------------------------
//
// Instantane "profond" de tout ce qui peut etre modifie interactivement
// (dessin des pieces, angles, visibilite, racine, ordre). pushUndo() doit
// etre appele AVANT chaque geste modifiant quelque chose (debut de drag,
// clic sur un toggle...), jamais pendant/apres, sinon l'etat "avant" serait
// deja corrompu.
function snapshotState() {
  const parts = new Map();
  for (const [name, part] of state.parts) {
    parts.set(name, {
      name,
      contentNodes: part.contentNodes.map((el) => el.cloneNode(true)),
      links: part.links.map((l) => ({ ...l })),
    });
  }
  return {
    parts,
    angles: new Map(state.angles),
    visibility: new Map(state.visibility),
    roots: new Map(state.roots),
    order: [...state.order],
    linked: new Set(state.linked),
  };
}

function pushUndo() {
  undoStack.push(snapshotState());
  if (undoStack.length > MAX_UNDO) undoStack.shift();
}

function undo() {
  if (!undoStack.length) return;
  const snap = undoStack.pop();
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

// La page charge un unique fichier : characters/template.svg. Une piece est
// un <g data-part="nom"> contenant son propre dessin (path, cercles
// class="joint"), pieces posees a plat les unes a cote des autres dans ce
// fichier (voir template.svg pour l'ajout/edition des pieces).
async function load() {
  setWarning("");
  try {
    state.parts = await loadTemplate(state.character);
    state.order = [...state.parts.keys()];
    state.linked.clear();
    undoStack.length = 0; // nouveau document : l'historique precedent n'a plus de sens

    buildLinkMap();
    buildComponents();
    pickDefaultRoots();
    populateUI();
    rebuild();
  } catch (err) {
    setWarning(
      "Erreur de chargement : " +
        err.message +
        ". Si la page est ouverte en file://, lance un petit serveur local, ex: `python3 -m http.server` puis ouvre http://localhost:8000/"
    );
    console.error(err);
  }
}

function extractLinks(contentNodes) {
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

async function loadTemplate(file) {
  const path = "characters/" + file;
  const res = await fetch(path);
  if (!res.ok) throw new Error(path + " introuvable (" + res.status + ")");

  const text = await res.text();
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  const parts = new Map();
  doc.querySelectorAll("[data-part]").forEach((g) => {
    const name = g.getAttribute("data-part");
    const contentNodes = Array.from(g.children);
    parts.set(name, { name, contentNodes, links: extractLinks(contentNodes) });
  });
  if (!parts.size) throw new Error("aucune piece (<g data-part>) trouvee dans " + file);
  return parts;
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

function buildLinkMap() {
  const g = computeLinkGraph(state.parts);
  state.linkMap = g.linkMap;
  state.edges = g.edges;
  state.sharedPoints = g.sharedPoints;
}

function buildComponents() {
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

function pickDefaultRoots() {
  state.roots.clear();
  state.components.forEach((comp, i) => {
    if (state.roots.has(i) && comp.has(state.roots.get(i))) return;
    state.roots.set(i, computeDefaultRoot(state.parts, comp));
  });
}

function findComponentIndex(partName) {
  return state.components.findIndex((c) => c.has(partName));
}

// Piece jumelle d'une piece gauche/droite : meme nom avec left <-> right
// (ex: upper_leg_left <-> upper_leg_right). null si elle n'existe pas.
function counterpartOf(name) {
  let other = null;
  if (name.includes("left")) other = name.replace("left", "right");
  else if (name.includes("right")) other = name.replace("right", "left");
  return other && state.parts.has(other) ? other : null;
}

// La jumelle a modifier en miroir, ou null si le lien n'est pas actif.
function linkedCounterpart(name) {
  return state.linked.has(name) ? counterpartOf(name) : null;
}

function populateUI() {
  // Root selector
  els.rootSelect.innerHTML = "";
  for (const name of state.order) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    els.rootSelect.appendChild(opt);
  }
  const firstRoot = state.roots.get(0);
  if (firstRoot) els.rootSelect.value = firstRoot;

  // Part list : poignee de drag-and-drop (reordonner, index 0 = devant, en
  // haut de la liste), bouton oeil (afficher/masquer), bouton crayon (editer
  // les points). Quand une piece est en edition, les autres se desactivent.
  els.partList.innerHTML = "";
  state.order.forEach((name) => {
    const li = document.createElement("li");
    const compIndex = findComponentIndex(name);
    const isRoot = state.roots.get(compIndex) === name;
    const isEditing = state.editingPart === name;
    const disabledByEdit = state.editingPart !== null && !isEditing;
    if (isEditing) li.classList.add("editing");

    const dragHandle = document.createElement("span");
    dragHandle.className = "drag-handle";
    dragHandle.textContent = "⠿";
    dragHandle.title = "Glisser pour reordonner (haut = devant)";
    dragHandle.draggable = !disabledByEdit;

    dragHandle.addEventListener("dragstart", (evt) => {
      evt.dataTransfer.setData("text/plain", name);
      evt.dataTransfer.effectAllowed = "move";
      requestAnimationFrame(() => li.classList.add("dragging"));
    });
    dragHandle.addEventListener("dragend", () => li.classList.remove("dragging"));

    li.addEventListener("dragover", (evt) => {
      if (disabledByEdit) return;
      evt.preventDefault();
      evt.dataTransfer.dropEffect = "move";
      li.classList.add("drag-over");
    });
    li.addEventListener("dragleave", () => li.classList.remove("drag-over"));
    li.addEventListener("drop", (evt) => {
      evt.preventDefault();
      li.classList.remove("drag-over");
      if (disabledByEdit) return;
      const draggedName = evt.dataTransfer.getData("text/plain");
      const rect = li.getBoundingClientRect();
      const insertAfter = evt.clientY - rect.top > rect.height / 2;
      reorderPart(draggedName, name, insertAfter);
    });

    const eyeBtn = document.createElement("button");
    eyeBtn.type = "button";
    eyeBtn.className = "icon-btn eye-btn" + (state.visibility.get(name) === false ? " off" : "");
    eyeBtn.textContent = "👁";
    eyeBtn.title = "Afficher / masquer cette piece";
    eyeBtn.disabled = disabledByEdit;
    eyeBtn.addEventListener("click", () => {
      pushUndo();
      const nowVisible = state.visibility.get(name) === false;
      setPartVisible(name, nowVisible);
      eyeBtn.classList.toggle("off", !nowVisible);
    });

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "icon-btn edit-btn" + (isEditing ? " active" : "");
    editBtn.textContent = "✏️";
    editBtn.title = "Editer les points de cette piece (path et ancrages)";
    editBtn.disabled = disabledByEdit;
    editBtn.addEventListener("click", () => {
      state.editingPart = isEditing ? null : name;
      populateUI();
      rebuild();
    });

    const label = document.createElement("span");
    label.textContent = name + (isRoot ? "  (racine)" : "");

    li.appendChild(dragHandle);
    li.appendChild(eyeBtn);
    li.appendChild(editBtn);

    // Toggle lien pour les pieces left/right : quand il est actif, editer
    // l'une des deux jumelles applique le meme deplacement a l'autre. Le
    // lien est symetrique, donc active/desactive sur les deux a la fois.
    const counterpart = counterpartOf(name);
    if (counterpart) {
      const linkBtn = document.createElement("button");
      linkBtn.type = "button";
      linkBtn.className = "icon-btn link-btn" + (state.linked.has(name) ? " active" : "");
      linkBtn.textContent = "🔗";
      linkBtn.title = `Lier a ${counterpart} : l'edition modifie les deux pieces`;
      linkBtn.disabled = disabledByEdit;
      linkBtn.addEventListener("click", () => {
        pushUndo();
        if (state.linked.has(name)) {
          state.linked.delete(name);
          state.linked.delete(counterpart);
        } else {
          state.linked.add(name);
          state.linked.add(counterpart);
        }
        populateUI();
      });
      li.appendChild(linkBtn);
    }

    li.appendChild(label);
    els.partList.appendChild(li);
  });

  // Infos : extremites libres (id non apparie) et points d'ancrage partages
  // par plusieurs pieces (ex: deux jambes sur le meme point de hanche).
  const messages = [];
  for (const [id, entries] of state.linkMap.entries()) {
    if (entries.length === 1) {
      messages.push(`Point "${id}" de "${entries[0].part}" n'a pas de correspondance (extrémité libre).`);
    }
  }
  for (const shared of state.sharedPoints) {
    messages.push(
      `Point "${shared.id}" partagé par ${shared.entries.length} pièces (${shared.entries
        .map((e) => e.part)
        .join(", ")}) : toutes attachées au même point d'ancrage.`
    );
  }
  setWarning(messages.join("\n"));
}

function setWarning(text) {
  els.warnings.textContent = text;
  els.warnings.style.display = text ? "block" : "none";
}

// Deplace draggedName juste avant (ou apres) targetName dans l'ordre
// d'empilement, via glisser-deposer dans la liste. Affecte la liste, le
// rendu (quelle piece est peinte par-dessus quand plusieurs se
// superposent) et l'export.
function reorderPart(draggedName, targetName, insertAfter) {
  if (!draggedName || draggedName === targetName) return;
  const from = state.order.indexOf(draggedName);
  if (from === -1) return;

  pushUndo();
  const order = state.order;
  order.splice(from, 1);
  let to = order.indexOf(targetName);
  if (insertAfter) to += 1;
  order.splice(to, 0, draggedName);

  populateUI();
  rebuild();
}

// Build a directed spanning tree per component, rooted at state.roots[i],
// compute each part's absolute transform from it, then render FLAT <g>
// elements in stacking order (state.order[0] = front = last in the DOM).
// Le rendu a plat est indispensable pour que l'ordre choisi par
// drag-and-drop s'applique : avec des <g> imbriques, un enfant serait
// toujours peint par-dessus son parent, quel que soit state.order.
function rebuild() {
  els.content.innerHTML = "";
  els.jointList.innerHTML = "";
  state.groupEls.clear();
  state.contentEls.clear();
  if (!state.angles.size) {
    for (const name of state.parts.keys()) state.angles.set(name, 0);
  }

  const absolute = new Map();
  state.components.forEach((comp, compIndex) => {
    const rootName = state.roots.get(compIndex);
    const tree = buildSpanningTree(state.adjacency, comp, rootName, state.order);
    computeAbsoluteTransforms(tree, 0, 15 + compIndex * COMPONENT_SPACING, 10, absolute);
    addSlidersForTree(tree);
  });

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

// Le transform complet d'une piece (translation+rotation cumulees de tous
// ses ancestres) sous forme de chaine, en concatenant l'attribut transform
// de chaque <g> parent jusqu'a els.content. Poser cette chaine telle
// quelle sur un <g> place dans l'overlay reproduit exactement le meme
// positionnement que la piece d'origine (SVG applique la liste de
// transforms nativement), sans avoir a recalculer de matrice a la main.
function computeFullTransform(pieceG) {
  const chain = [];
  let cur = pieceG;
  while (cur && cur !== els.content) {
    const t = cur.getAttribute && cur.getAttribute("transform");
    if (t) chain.unshift(t);
    cur = cur.parentNode;
  }
  return chain.join(" ");
}

function addEditHandlesForPart(name) {
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

function addSlidersForTree(node) {
  if (node.parentPoint !== null) addJointSlider(node);
  for (const child of node.children) addSlidersForTree(child);
}

function setPartVisible(name, visible) {
  state.visibility.set(name, visible);
  const contentG = state.contentEls.get(name);
  if (contentG) contentG.style.display = visible ? "" : "none";
}

function addJointSlider(node) {
  const wrapper = document.createElement("div");
  wrapper.className = "joint";

  const label = document.createElement("label");
  label.textContent = `${node.name} @ ${node.linkId}`;

  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "-180";
  slider.max = "180";
  slider.value = state.angles.get(node.name) || 0;
  slider.className = "joint-slider";
  slider.disabled = state.editingPart !== null && state.editingPart !== node.name;

  const valueSpan = document.createElement("span");
  valueSpan.className = "joint-value";
  valueSpan.textContent = `${slider.value}°`;

  // pushUndo() une seule fois au debut du geste (pointerdown), pas a chaque
  // "input" (qui se declenche en continu pendant qu'on glisse le slider).
  slider.addEventListener("pointerdown", () => pushUndo());
  slider.addEventListener("input", () => {
    state.angles.set(node.name, Number(slider.value));
    valueSpan.textContent = `${slider.value}°`;
    // Rendu a plat : tourner une articulation deplace aussi tous ses
    // descendants, on recalcule donc les transforms absolus de tout le monde.
    updateAllTransformsInPlace();
  });

  wrapper.appendChild(label);
  wrapper.appendChild(slider);
  wrapper.appendChild(valueSpan);
  els.jointList.appendChild(wrapper);
}

function applyAllTransforms() {
  // simplest correct way to reflect a full reset: just rebuild the tree from current state
  rebuild();
}

// Recalcule uniquement les attributs transform des <g> deja presents dans
// le DOM (pas de reconstruction), pour propager le deplacement d'un point
// d'ancrage aux pieces qui en dependent sans perdre la poignee en cours de
// drag (un rebuild() complet la detacherait du document).
function updateAllTransformsInPlace() {
  const absolute = new Map();
  state.components.forEach((comp, compIndex) => {
    const rootName = state.roots.get(compIndex);
    const tree = buildSpanningTree(state.adjacency, comp, rootName, state.order);
    computeAbsoluteTransforms(tree, 0, 15 + compIndex * COMPONENT_SPACING, 10, absolute);
  });
  for (const [name, pos] of absolute) {
    const g = state.groupEls.get(name);
    if (g) g.setAttribute("transform", `translate(${pos.x}, ${pos.y}) rotate(${pos.angle})`);
  }
}

// --- Edition des points (path et ancrages) -------------------------------
//
// Parseur/serialiseur de path minimal, suffisant pour M/L/C/S (absolu ou
// relatif) : convertit tout en segments absolus explicites (S devient C),
// ce qui donne des poignees independantes faciles a manipuler.
function parsePathD(d) {
  const tokens = d.match(/[MLCSZmlcsz]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) || [];
  let i = 0;
  let cur = { x: 0, y: 0 };
  let lastControl = null;
  const segments = [];
  const num = () => parseFloat(tokens[i++]);

  while (i < tokens.length) {
    const cmd = tokens[i++];
    switch (cmd) {
      case "M": {
        cur = { x: num(), y: num() };
        segments.push({ type: "M", p: { ...cur } });
        lastControl = null;
        break;
      }
      case "m": {
        cur = { x: cur.x + num(), y: cur.y + num() };
        segments.push({ type: "M", p: { ...cur } });
        lastControl = null;
        break;
      }
      case "L": {
        cur = { x: num(), y: num() };
        segments.push({ type: "L", p: { ...cur } });
        lastControl = null;
        break;
      }
      case "l": {
        cur = { x: cur.x + num(), y: cur.y + num() };
        segments.push({ type: "L", p: { ...cur } });
        lastControl = null;
        break;
      }
      case "C": {
        const c1 = { x: num(), y: num() };
        const c2 = { x: num(), y: num() };
        const p = { x: num(), y: num() };
        segments.push({ type: "C", c1, c2, p });
        cur = p;
        lastControl = c2;
        break;
      }
      case "c": {
        const c1 = { x: cur.x + num(), y: cur.y + num() };
        const c2 = { x: cur.x + num(), y: cur.y + num() };
        const p = { x: cur.x + num(), y: cur.y + num() };
        segments.push({ type: "C", c1, c2, p });
        cur = p;
        lastControl = c2;
        break;
      }
      case "S": {
        const c1 = lastControl ? { x: 2 * cur.x - lastControl.x, y: 2 * cur.y - lastControl.y } : { ...cur };
        const c2 = { x: num(), y: num() };
        const p = { x: num(), y: num() };
        segments.push({ type: "C", c1, c2, p });
        cur = p;
        lastControl = c2;
        break;
      }
      case "s": {
        const c1 = lastControl ? { x: 2 * cur.x - lastControl.x, y: 2 * cur.y - lastControl.y } : { ...cur };
        const c2 = { x: cur.x + num(), y: cur.y + num() };
        const p = { x: cur.x + num(), y: cur.y + num() };
        segments.push({ type: "C", c1, c2, p });
        cur = p;
        lastControl = c2;
        break;
      }
      case "Z":
      case "z":
        segments.push({ type: "Z" });
        break;
      default:
        i = tokens.length; // commande non geree : on arrete plutot que de corrompre le path
    }
  }
  return segments;
}

function serializePathD(segments) {
  const n = (v) => (Math.round(v * 1000) / 1000).toString();
  const parts = [];
  for (const seg of segments) {
    if (seg.type === "M") parts.push(`M ${n(seg.p.x)} ${n(seg.p.y)}`);
    else if (seg.type === "L") parts.push(`L ${n(seg.p.x)} ${n(seg.p.y)}`);
    else if (seg.type === "C")
      parts.push(`C ${n(seg.c1.x)} ${n(seg.c1.y)} ${n(seg.c2.x)} ${n(seg.c2.y)} ${n(seg.p.x)} ${n(seg.p.y)}`);
    else if (seg.type === "Z") parts.push("Z");
  }
  return parts.join(" ");
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

function rotatePoint(angleDeg, p) {
  const r = (angleDeg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c };
}

// Position + orientation absolues (translation ET rotation, cumulees le
// long de l'arbre) de chaque piece dans sa pose actuelle : les rotations
// 2D se cumulent par simple addition d'angles, ce qui permet d'exporter un
// fichier plat (aucune piece imbriquee dans une autre) tout en conservant
// la pose exacte affichee a l'ecran.
function computeAbsoluteTransforms(node, parentAngle, parentX, parentY, out) {
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

// Recompose la pose courante (angles des sliders, pieces masquees, points
// d'ancrage visibles ou non) en un fichier plat characters/template.svg-like
// (une piece = un <g data-part> autonome, aucune imbrication) et declenche
// son telechargement. Compatible en relecture avec loadTemplate().
function exportTemplate() {
  const absolute = new Map();
  state.components.forEach((comp, i) => {
    const tree = buildSpanningTree(state.adjacency, comp, state.roots.get(i), state.order);
    computeAbsoluteTransforms(tree, 0, 15 + i * COMPONENT_SPACING, 10, absolute);
  });

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
