// Etat global de l'application et pile d'annulation (Ctrl+Z).
//
// pushUndo() prend un instantane "profond" de tout ce qui peut etre
// modifie interactivement (dessin des pieces, angles, visibilite, racine,
// ordre, liens jumelles). Il doit etre appele AVANT chaque geste modifiant
// quelque chose (debut de drag, clic sur un toggle...), jamais
// pendant/apres, sinon l'etat "avant" serait deja corrompu.

export const state = {
  parts: new Map(),      // name -> { name, contentNodes: [Element], links: [{id,cx,cy}] }
  linkMap: new Map(),    // linkId -> [{part, cx, cy}]
  edges: [],             // { id, a:{part,cx,cy}, b:{part,cx,cy} } - une entree par paire de pieces partageant l'id
  sharedPoints: [],      // linkId partage par plus de 2 pieces (plusieurs membres au meme point d'ancrage)
  components: [],        // array of Set(partName)
  adjacency: new Map(),  // partName -> [{neighbor, edge}]
  roots: new Map(),      // componentIndex -> partName chosen as root
  angles: new Map(),     // partName -> degrees (its own joint rotation, 0 for roots)
  groupEls: new Map(),   // partName -> the <g> element rendered for it (for fast transform updates)
  contentEls: new Map(), // partName -> the <g> wrapping only its own drawable content (for the show/hide toggle)
  visibility: new Map(), // partName -> false quand la piece est masquee via le toggle
  linked: new Set(),     // pieces left/right liees : editer l'une applique le meme delta a sa jumelle
  showLinks: false,
  hasFitViewport: false, // le cadrage auto ne doit avoir lieu qu'au tout premier chargement
  editingPart: null,     // nom de la piece actuellement en edition (points draggables), ou null
  editTool: "move",      // outil actif en mode edition : "move" | "resize" | "rotate" | "setting"
  order: [],             // ordre des pieces choisi par l'utilisateur ; index 0 = devant (au-dessus)
  character: "template.svg", // fichier charge dans characters/, choisi via le selecteur
};

const undoStack = [];
const MAX_UNDO = 50;

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

export function pushUndo() {
  undoStack.push(snapshotState());
  if (undoStack.length > MAX_UNDO) undoStack.shift();
}

// Retire et retourne le dernier instantane, ou null. L'application de
// l'instantane (et la reconstruction de l'UI) est orchestree par main.js.
export function popUndo() {
  return undoStack.pop() || null;
}

export function clearUndo() {
  undoStack.length = 0;
}
