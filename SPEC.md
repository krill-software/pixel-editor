# Pixel Editor — Spec (v1)

A small pixel-art editor for Linux. Set a grid size, pick a color, and place
colored pixels to build sprite-scale art — then save it as a PNG where one
cell is one image pixel. Think a stripped-down Aseprite whose whole surface is
the grid and a handful of tools, with no timeline, no layers, no palette
management to learn.

## Identity

| Field | Value |
|---|---|
| Slug (directory) | `pixel-editor` |
| productName | `Pixel Editor` |
| Binary | `krill-pixel-editor` |
| Identifier | `software.krill.pixel-editor` |
| Document format | PNG (`.png`, `image/png`) — one grid cell = one image pixel |
| Icon glyph | Lucide `grid-2x2` |

## The idea

Pixel art is literally an image where each cell is a single pixel, so **the
PNG is the document**: Save writes the grid at its native resolution (a 32×32
canvas → a 32×32 PNG), and Open reads any PNG's pixels straight back into a
grid of its dimensions. Perfect round-trip, no proprietary project format,
transparency preserved. The "document" is the pixels; the grid size is just
the image's width and height.

Distinct from **paint** (krill's freeform full-resolution raster tool): pixel
editor is grid-snapped and low-resolution by design — you work in cells, the
canvas is scaled up on screen, and what you export is the small image, not the
zoomed view.

## The model

```ts
interface Doc {
  width: number;          // grid columns (= PNG width)
  height: number;         // grid rows    (= PNG height)
  pixels: Uint8ClampedArray; // width*height*4, RGBA, row-major; a=0 is empty
  path: string | null;    // the .png on disk, or null for an unsaved doc
}
```

- A cell is one RGBA pixel. `alpha = 0` means empty (transparent) — empty cells
  show a checkerboard, and export as transparent PNG pixels.
- The grid dimensions are the document's dimensions; there is no separate
  "canvas size" preference. New picks them once; Open inherits them from the
  file.

## Layout — app shell (mountChrome layout: "app")

The app-style workspace via `mountChrome({ layout: "app" })` — no titlebar, no
status line; the aux pane leads with a hamburger (the menu), the main pane
carries its own top strip with the window controls.

```
+------------------+-----------------------------------------------+
| ☰                | untitled.png • · 32 × 32 · 12, 8     —  □  ×  |  main topbar
+------------------+-----------------------------------------------+
|  TOOLS           |                                               |
|  ▢ Paint  B      |        the grid (canvas, scaled up,           |
|  ▢ Erase  E      |        checkerboard behind empty cells,       |
|  ▢ Pick   I      |        1px grid lines)                        |
|                  |                                               |
|  COLOR           |                                               |
|  [ swatch ] #hex |                                               |
|  recent ▢▢▢▢▢    |                                               |
+------------------+-----------------------------------------------+
```

- **Aux (left, tool rail):** below the hamburger strip — the three M1 tools
  (Paint / Erase / Pick) each with a one-key shortcut, then the color block:
  current swatch, hex readout, a native color input to change it, and a strip of
  recently used colors.
- **Main:** its own top strip carries the **readout** (filename + dirty dot ·
  `{W} × {H}` · hovered cell `x, y`) on the left and the window controls on the
  right; below it, the canvas — the logical grid rendered at an integer scale,
  centered, with a transparency checkerboard behind it and 1px grid lines.
- The document name + dirty state also ride the **window-manager title**
  (taskbar). Menu actions (New / Open / Save / …) live in the hamburger menu and
  on their canonical shortcuts.

## Tools (M1)

| Tool | Key | Action |
|---|---|---|
| Paint | `B` | Set the cell(s) under the pointer to the current color. Click-drag paints a run. |
| Erase | `E` | Set cell(s) to transparent (`alpha = 0`). |
| Pick  | `I` | Eyedropper — adopt the color under the pointer as the current color. |

- **Undo / redo** (`Ctrl+Z` / `Ctrl+Shift+Z`): each stroke (press → release) is
  one snapshot on the stack.
- Current color is a single RGBA value; the recent-colors strip remembers the
  last several distinct colors used (cross-document, persisted).
- **Cursor preview.** The hovered cell shows a box of the current color (an
  accent outline always; Paint fills it) so you see exactly what will land.
- **Wheel = palette.** Scrolling over the canvas cycles the current color
  through the saved palette — fast access without reaching for the rail.

## File handling — the `.png` is the document

- **New** (`Ctrl+N`): prompt for grid size — square presets (16, 32, 64) plus a
  custom `W × H` — and open an empty (all-transparent) grid.
- **Open** (`Ctrl+O`): read a PNG, decode it to RGBA in the webview (an
  `Image` → offscreen canvas → `getImageData`), and load it as a grid of the
  file's dimensions. Rust hands over the raw bytes; decoding is the canvas's job.
- **Save / Save As** (`Ctrl+S` / `Ctrl+Shift+S`): render the grid to an
  offscreen canvas at native resolution, `toBlob('image/png')`, and write the
  bytes. Default filename `sprite.png`. `Ctrl+S` rewrites the open path.
- **Dirty tracking:** hash of the pixel buffer vs. last-saved hash.
- CLI arg + drag-drop open a `.png`.

## Keybindings (M1)

| Action | Key |
|---|---|
| New / Open | `Ctrl+N` / `Ctrl+O` |
| Save / Save As | `Ctrl+S` / `Ctrl+Shift+S` |
| Undo / Redo | `Ctrl+Z` / `Ctrl+Shift+Z` |
| Paint / Erase / Pick | `B` / `E` / `I` |
| Quit | `Ctrl+Q` |

## Non-goals (v1)

- No layers, no frames, no animation timeline.
- No bucket/flood fill, no shape tools, no selection/move (M2 candidates).
- No zoom/pan controls in M1 — the grid fits the window at an integer scale
  (zoom is an M2 comfort feature).
- No palette files, no indexed-color mode — RGBA throughout.
- No formats other than PNG. No SVG, no `.ase`/`.aseprite`.
- No settings panel, no multi-window, no telemetry.

## Stack

Tauri 2 + TypeScript + Vite + pnpm, like every krill app. Chrome + palette via
[`@krill-software/desktop-ui`](https://github.com/krill-software/desktop-ui)
(pinned tag): `mountChrome()`, canonical actions, empty-state helper. Rust is a
thin byte courier over [`krill-desktop-core`](https://github.com/krill-software/desktop-core)
(`read_png` / `write_png` via `fs`, state I/O, dev fixture) — PNG encode/decode
lives in the webview canvas, so no Rust image crate in v1.

## Window

Canonical krill dimensions: 1296 × 800 default, 720 × 445 minimum, centered.

## Milestones

1. **M1 — place pixels.** *(this pass)* Grid canvas (checkerboard + grid lines),
   New with size picker, Paint / Erase / Pick tools with drag, current color +
   native picker + recent strip, undo/redo, Open / Save / Save As as PNG, CLI +
   drag-drop, dirty tracking.
2. **M2 — comfort.** Zoom & pan, bucket fill, a swappable working palette, mirror
   draw, configurable export scale (e.g. 32×32 art exported at 8×).
3. **M3 — polish.** Whatever the use teaches; candidates: line/rectangle shapes,
   grid resize/crop of an open doc.

> Graduated 2026-06-18; ships v0.1.0 (M1 feature set). M2 (zoom/pan, bucket
> fill, swappable palette, export scale) is now post-v1 work.
