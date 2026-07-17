# SVG RIGGING

Pose, edit and export 2D characters built from plain SVG parts, right in the browser.

**▶ Live version: <https://julienbouchardit.github.io/svg_rigging/>**

## What it does

A character is a single flat SVG file where each piece is a `<g data-part="name">`
containing its own drawing (paths) and its attachment points (circles with
`class="joint"`). Two pieces sharing a joint `id` are automatically linked:
the app builds the skeleton from that, renders the character, and lets you:

- **Pose** — one rotation slider per joint, with a configurable root piece.
- **Reorder** — drag pieces in the list to change the stacking order (top = front).
- **Edit** — drag path anchors, curve control points and joints directly on the canvas.
- **Mirror** — link a `left`/`right` piece pair (🔗) so editing one applies the same
  change to its twin.
- **Show/hide** pieces, undo everything with `Ctrl+Z`.
- **Import / Export** — load a local SVG, and export the current pose as a flat,
  nicely formatted SVG that can be reloaded as a character.

Settings (⚙️): language (English/French) and light/dark theme. The side panel
width is draggable.

## Running locally

The app is static but needs an HTTP server (it fetches the character files):

```sh
python3 -m http.server
# then open http://localhost:8000/
```

Characters live in `characters/`. Any `.svg` dropped there appears in the
character selector (via the server's directory listing, or `characters/characters.json`
on servers without listings — add file names there by hand).

## Project structure

```
index.html          markup
style.css           styles
characters/         character files (one flat SVG each)
src/
  main.js           entry point: wiring, load, undo
  dom.js            shared DOM references
  state.js          global state + undo stack
  i18n.js           translations (en/fr)
  model.js          rig domain: link graph, components, spanning tree, transforms
  path.js           minimal SVG path parser/serializer
  loader.js         character fetching & parsing
  render.js         flat SVG rendering
  ui.js             side panel: part list, sliders, warnings
  editor.js         point editing handles + mirrored propagation
  export.js         formatted SVG export
```
