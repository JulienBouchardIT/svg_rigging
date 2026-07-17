// Le panneau lateral : liste des pieces (drag-and-drop d'ordre, oeil,
// crayon, lien jumelle), selecteur de racine, sliders d'articulations et
// messages d'information.
//
// Import circulaire assume avec render.js (appels a l'execution seulement).

import { els } from "./dom.js";
import { state, pushUndo } from "./state.js";
import { t } from "./i18n.js";
import { findComponentIndex, counterpartOf } from "./model.js";
import { rebuild, setPartVisible, updateAllTransformsInPlace } from "./render.js";

export function populateUI() {
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
    dragHandle.title = t("title.drag");
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
    eyeBtn.title = t("title.eye");
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
    editBtn.title = t("title.edit");
    editBtn.disabled = disabledByEdit;
    editBtn.addEventListener("click", () => {
      state.editingPart = isEditing ? null : name;
      populateUI();
      rebuild();
    });

    const label = document.createElement("span");
    label.textContent = name + (isRoot ? t("label.rootSuffix") : "");

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
      linkBtn.title = t("title.link", { name: counterpart });
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
      messages.push(t("warn.freeEnd", { id, part: entries[0].part }));
    }
  }
  for (const shared of state.sharedPoints) {
    messages.push(
      t("warn.shared", {
        id: shared.id,
        count: shared.entries.length,
        parts: shared.entries.map((e) => e.part).join(", "),
      })
    );
  }
  setWarning(messages.join("\n"));
}

export function setWarning(text) {
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

export function addSlidersForTree(node) {
  if (node.parentPoint !== null) addJointSlider(node);
  for (const child of node.children) addSlidersForTree(child);
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
