// Parseur/serialiseur de path SVG minimal, suffisant pour M/L/C/S (absolu
// ou relatif) : convertit tout en segments absolus explicites (S devient
// C), ce qui donne des poignees d'edition independantes faciles a
// manipuler. Module pur : aucune dependance.

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

export function serializePathD(segments) {
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
