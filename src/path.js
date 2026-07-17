// Parseur/serialiseur de path SVG minimal, suffisant pour M/L/C/S (absolu
// ou relatif) : convertit tout en segments absolus explicites. Les S sont
// materialises en courbes completes (c1 calcule par reflexion) pour les
// calculs, mais gardent un marqueur `smooth` : la serialisation les
// re-emet en S (c1 implicite), le type des noeuds du fichier ne change
// donc jamais. Module pur : aucune dependance.

export function parsePathD(d) {
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
        segments.push({ type: "C", smooth: true, c1, c2, p });
        cur = p;
        lastControl = c2;
        break;
      }
      case "s": {
        const c1 = lastControl ? { x: 2 * cur.x - lastControl.x, y: 2 * cur.y - lastControl.y } : { ...cur };
        const c2 = { x: cur.x + num(), y: cur.y + num() };
        const p = { x: cur.x + num(), y: cur.y + num() };
        segments.push({ type: "C", smooth: true, c1, c2, p });
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

// --- Courbes lisses par les ancres (Catmull-Rom -> Bezier) ----------------
//
// Le modele d'edition ne manipule que des ancres : les points de controle
// sont derives des ancres voisines (spline de Catmull-Rom convertie en
// Beziers cubiques exactes), la courbe reste donc lisse quoi qu'on fasse.

const CLOSE_EPS = 1e-3; // la serialisation arrondit a 3 decimales

// Extrait les ancres d'un path parse (les points d'arrivee des segments).
// Un contour dont la derniere ancre coincide avec la premiere (le style
// des pieces : ferme sans Z) est detecte comme boucle et dedouble.
export function anchorsFromSegments(segments) {
  const anchors = [];
  for (const seg of segments) if (seg.p) anchors.push({ x: seg.p.x, y: seg.p.y });
  const first = anchors[0];
  const last = anchors[anchors.length - 1];
  const closed =
    anchors.length > 2 &&
    Math.abs(first.x - last.x) <= CLOSE_EPS &&
    Math.abs(first.y - last.y) <= CLOSE_EPS;
  if (closed) anchors.pop();
  return { anchors, closed };
}

// Genere le d complet passant par les ancres. Ferme : les voisins se
// prennent modulo la liste et la courbe revient a la premiere ancre.
// Ouvert : les extremites dupliquent leur voisin manquant. `tension`
// controle la rondeur (6 = Catmull-Rom standard ; plus grand = plus tendu).
export function catmullRomD(anchors, closed, tension = 6) {
  const n = anchors.length;
  if (!n) return "";
  const segs = [{ type: "M", p: { ...anchors[0] } }];
  const count = closed ? n : n - 1;
  for (let i = 0; i < count; i++) {
    const p0 = anchors[closed ? (i - 1 + n) % n : Math.max(i - 1, 0)];
    const p1 = anchors[i];
    const p2 = anchors[(i + 1) % n];
    const p3 = anchors[closed ? (i + 2) % n : Math.min(i + 2, n - 1)];
    segs.push({
      type: "C",
      c1: { x: p1.x + (p2.x - p0.x) / tension, y: p1.y + (p2.y - p0.y) / tension },
      c2: { x: p2.x - (p3.x - p1.x) / tension, y: p2.y - (p3.y - p1.y) / tension },
      p: { ...p2 },
    });
  }
  return serializePathD(segs);
}

export function serializePathD(segments) {
  const n = (v) => (Math.round(v * 1000) / 1000).toString();
  const parts = [];
  for (const seg of segments) {
    if (seg.type === "M") parts.push(`M ${n(seg.p.x)} ${n(seg.p.y)}`);
    else if (seg.type === "L") parts.push(`L ${n(seg.p.x)} ${n(seg.p.y)}`);
    else if (seg.type === "C" && seg.smooth)
      // Issu d'un S : c1 reste implicite (reflet du c2 precedent), le
      // noeud garde son type dans le fichier.
      parts.push(`S ${n(seg.c2.x)} ${n(seg.c2.y)} ${n(seg.p.x)} ${n(seg.p.y)}`);
    else if (seg.type === "C")
      parts.push(`C ${n(seg.c1.x)} ${n(seg.c1.y)} ${n(seg.c2.x)} ${n(seg.c2.y)} ${n(seg.p.x)} ${n(seg.p.y)}`);
    else if (seg.type === "Z") parts.push("Z");
  }
  return parts.join(" ");
}
