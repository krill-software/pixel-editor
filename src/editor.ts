// The grid: an RGBA pixel buffer rendered onto a canvas, scaled up by an
// integer factor so each cell is a crisp block. The buffer (`pixels`) is the
// source of truth; the canvas is a view of it. PNG encode/decode happens here
// too — the canvas is the codec, so Rust never touches image bytes' meaning.

import type { RGBA, Tool } from "./types";

export interface EditorOptions {
  /** Fired after any stroke that changed the buffer (drives dirty + recent). */
  onChange?: (lastColor: RGBA | null) => void;
  /** Fired when the eyedropper adopts a color. */
  onPick?: (color: RGBA) => void;
  /** Fired as the pointer moves over cells (or leaves: null). */
  onHover?: (cell: { x: number; y: number } | null) => void;
  /** Fired when undo/redo availability changes. */
  onHistory?: () => void;
}

const MAX_UNDO = 100;
const GRIDLINE_MIN_SCALE = 5; // below this, grid lines would dominate the art

export interface PixelEditor {
  readonly canvas: HTMLCanvasElement;
  width: number;
  height: number;
  load(width: number, height: number, pixels?: Uint8ClampedArray<ArrayBuffer>): void;
  setTool(tool: Tool): void;
  setColor(color: RGBA): void;
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  fit(): void;
  hash(): string;
  toPngBlob(): Promise<Blob>;
}

export function createEditor(host: HTMLElement, opts: EditorOptions = {}): PixelEditor {
  let width = 1;
  let height = 1;
  let pixels = new Uint8ClampedArray(4);
  let scale = 1;

  let tool: Tool = "paint";
  let color: RGBA = { r: 221, g: 117, b: 150, a: 255 }; // krill accent to start

  const undoStack: Uint8ClampedArray<ArrayBuffer>[] = [];
  const redoStack: Uint8ClampedArray<ArrayBuffer>[] = [];

  // The display canvas (scaled view), a cursor-overlay canvas drawn on top
  // (the brush preview — the hovered cell shows the color that will land), and
  // a native-resolution scratch canvas (one cell = one pixel) used to blit the
  // buffer and to encode/decode PNG.
  const frame = document.createElement("div");
  frame.className = "pe-frame";
  const canvas = document.createElement("canvas");
  canvas.className = "pe-canvas";
  const cursor = document.createElement("canvas");
  cursor.className = "pe-cursor";
  frame.append(canvas, cursor);
  host.appendChild(frame);
  const ctx = canvas.getContext("2d")!;
  const cctx = cursor.getContext("2d")!;

  const scratch = document.createElement("canvas");
  const sctx = scratch.getContext("2d", { willReadFrequently: true })!;

  let lastHover: { x: number; y: number } | null = null;

  // ---- buffer access ---------------------------------------------------

  function idx(x: number, y: number): number {
    return (y * width + x) * 4;
  }

  function getCell(x: number, y: number): RGBA {
    const i = idx(x, y);
    return { r: pixels[i], g: pixels[i + 1], b: pixels[i + 2], a: pixels[i + 3] };
  }

  function setCell(x: number, y: number, c: RGBA): boolean {
    const i = idx(x, y);
    if (
      pixels[i] === c.r && pixels[i + 1] === c.g &&
      pixels[i + 2] === c.b && pixels[i + 3] === c.a
    ) {
      return false;
    }
    pixels[i] = c.r;
    pixels[i + 1] = c.g;
    pixels[i + 2] = c.b;
    pixels[i + 3] = c.a;
    return true;
  }

  // ---- rendering -------------------------------------------------------

  function fit(): void {
    // Largest integer scale that fits the host, leaving a little breathing room.
    const pad = 48;
    const availW = Math.max(0, host.clientWidth - pad);
    const availH = Math.max(0, host.clientHeight - pad);
    const next = Math.max(1, Math.floor(Math.min(availW / width, availH / height)));
    scale = Number.isFinite(next) && next > 0 ? next : 1;
    resizeCanvas();
    render();
    renderCursor();
  }

  function resizeCanvas(): void {
    const dpr = window.devicePixelRatio || 1;
    const cssW = width * scale;
    const cssH = height * scale;
    for (const cv of [canvas, cursor]) {
      cv.style.width = `${cssW}px`;
      cv.style.height = `${cssH}px`;
      cv.width = Math.round(cssW * dpr);
      cv.height = Math.round(cssH * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // The brush preview: a box at the hovered cell. Paint fills it with the
  // current color (so you see exactly what lands); every tool gets a
  // Shimmering-Blush outline — the krill cursor color.
  function renderCursor(): void {
    const cssW = width * scale;
    const cssH = height * scale;
    cctx.clearRect(0, 0, cssW, cssH);
    if (!lastHover || scale < 3) return;
    const s = scale;
    const px = lastHover.x * s;
    const py = lastHover.y * s;
    if (tool === "paint") {
      cctx.fillStyle = `rgba(${color.r}, ${color.g}, ${color.b}, ${color.a / 255})`;
      cctx.fillRect(px, py, s, s);
    }
    cctx.lineWidth = 2;
    cctx.strokeStyle = "#dd7596";
    cctx.strokeRect(px + 1, py + 1, s - 2, s - 2);
  }

  function render(): void {
    const cssW = width * scale;
    const cssH = height * scale;
    ctx.clearRect(0, 0, cssW, cssH);

    // 1. Transparency checkerboard — one square per cell, alternating two
    //    faint Space-Cadet-alpha tones over Ghost White. (Alpha derivations of
    //    the ink are allowed alongside the locked palette.)
    ctx.fillStyle = "#fafaff";
    ctx.fillRect(0, 0, cssW, cssH);
    ctx.fillStyle = "rgba(48, 52, 63, 0.06)";
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if ((x + y) % 2 === 1) ctx.fillRect(x * scale, y * scale, scale, scale);
      }
    }

    // 2. The pixels — blit the buffer at native size into the scratch canvas,
    //    then draw it scaled with smoothing OFF so blocks stay crisp.
    scratch.width = width;
    scratch.height = height;
    sctx.putImageData(new ImageData(pixels.slice(), width, height), 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(scratch, 0, 0, cssW, cssH);

    // 3. Grid lines — only when cells are big enough that the lines read as
    //    guides rather than noise.
    if (scale >= GRIDLINE_MIN_SCALE) {
      ctx.strokeStyle = "rgba(48, 52, 63, 0.10)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 1; x < width; x++) {
        ctx.moveTo(x * scale + 0.5, 0);
        ctx.lineTo(x * scale + 0.5, cssH);
      }
      for (let y = 1; y < height; y++) {
        ctx.moveTo(0, y * scale + 0.5);
        ctx.lineTo(cssW, y * scale + 0.5);
      }
      ctx.stroke();
    }
  }

  // ---- pointer → cell + stroke handling --------------------------------

  function cellAt(e: PointerEvent): { x: number; y: number } | null {
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left) / scale);
    const y = Math.floor((e.clientY - rect.top) / scale);
    if (x < 0 || y < 0 || x >= width || y >= height) return null;
    return { x, y };
  }

  let strokeBefore: Uint8ClampedArray<ArrayBuffer> | null = null;
  let strokeChanged = false;
  let lastCell: { x: number; y: number } | null = null;

  function applyAt(x: number, y: number): void {
    if (tool === "pick") {
      const c = getCell(x, y);
      if (c.a === 0) return; // empty cell — nothing to pick
      color = c;
      opts.onPick?.({ ...c });
      return;
    }
    const c = tool === "erase" ? { r: 0, g: 0, b: 0, a: 0 } : color;
    if (setCell(x, y, c)) strokeChanged = true;
  }

  // Bresenham so a fast drag paints a continuous run, not dotted gaps.
  function applyLine(a: { x: number; y: number }, b: { x: number; y: number }): void {
    let x0 = a.x, y0 = a.y;
    const dx = Math.abs(b.x - x0), dy = -Math.abs(b.y - y0);
    const sx = x0 < b.x ? 1 : -1, sy = y0 < b.y ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      applyAt(x0, y0);
      if (x0 === b.x && y0 === b.y) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }

  canvas.addEventListener("pointerdown", (e) => {
    const cell = cellAt(e);
    if (!cell) return;
    canvas.setPointerCapture(e.pointerId);
    if (tool === "pick") {
      applyAt(cell.x, cell.y); // one-shot, no stroke/undo
      return;
    }
    strokeBefore = pixels.slice();
    strokeChanged = false;
    lastCell = cell;
    applyAt(cell.x, cell.y);
    render();
  });

  canvas.addEventListener("pointermove", (e) => {
    const cell = cellAt(e);
    lastHover = cell;
    opts.onHover?.(cell);
    if (strokeBefore && cell) {
      if (lastCell) applyLine(lastCell, cell);
      else applyAt(cell.x, cell.y);
      lastCell = cell;
      render();
    }
    renderCursor();
  });

  function endStroke(): void {
    if (!strokeBefore) return;
    if (strokeChanged) {
      undoStack.push(strokeBefore);
      if (undoStack.length > MAX_UNDO) undoStack.shift();
      redoStack.length = 0;
      opts.onChange?.(tool === "erase" ? null : { ...color });
      opts.onHistory?.();
    }
    strokeBefore = null;
    lastCell = null;
  }

  canvas.addEventListener("pointerup", endStroke);
  canvas.addEventListener("pointercancel", endStroke);
  canvas.addEventListener("pointerleave", () => {
    lastHover = null;
    renderCursor();
    opts.onHover?.(null);
  });

  // ---- public API ------------------------------------------------------

  return {
    canvas,
    get width() { return width; },
    get height() { return height; },

    load(w, h, px) {
      width = w;
      height = h;
      pixels = px ? px.slice() : new Uint8ClampedArray(w * h * 4); // all transparent
      undoStack.length = 0;
      redoStack.length = 0;
      lastHover = null;
      opts.onHistory?.();
      fit();
    },

    setTool(t) { tool = t; renderCursor(); },
    setColor(c) { color = { ...c }; renderCursor(); },

    undo() {
      const prev = undoStack.pop();
      if (!prev) return;
      redoStack.push(pixels.slice());
      pixels = prev;
      render();
      opts.onChange?.(null);
      opts.onHistory?.();
    },

    redo() {
      const next = redoStack.pop();
      if (!next) return;
      undoStack.push(pixels.slice());
      pixels = next;
      render();
      opts.onChange?.(null);
      opts.onHistory?.();
    },

    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
    fit,

    // A cheap content hash for dirty tracking (FNV-1a over the buffer).
    hash() {
      let h = 0x811c9dc5;
      for (let i = 0; i < pixels.length; i++) {
        h ^= pixels[i];
        h = Math.imul(h, 0x01000193);
      }
      return `${width}x${height}:${(h >>> 0).toString(16)}`;
    },

    toPngBlob() {
      scratch.width = width;
      scratch.height = height;
      sctx.putImageData(new ImageData(pixels.slice(), width, height), 0, 0);
      return new Promise<Blob>((resolve, reject) => {
        scratch.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png");
      });
    },
  };
}

/** Decode PNG bytes into a flat RGBA buffer + dimensions, via the webview. */
export async function decodePng(
  bytes: Uint8Array<ArrayBuffer>,
): Promise<{ width: number; height: number; pixels: Uint8ClampedArray<ArrayBuffer> }> {
  const blob = new Blob([bytes], { type: "image/png" });
  const bmp = await createImageBitmap(blob);
  const c = document.createElement("canvas");
  c.width = bmp.width;
  c.height = bmp.height;
  const cx = c.getContext("2d", { willReadFrequently: true })!;
  cx.drawImage(bmp, 0, 0);
  bmp.close();
  const data = cx.getImageData(0, 0, bmp.width, bmp.height);
  return { width: bmp.width, height: bmp.height, pixels: data.data };
}
