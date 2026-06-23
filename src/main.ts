import "@krill-software/desktop-ui/styles";
import "./styles.css";

import { FAMILY_ORDER, familyOf, mountChrome, parseGpl, showBootError } from "@krill-software/desktop-ui";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getMatches } from "@tauri-apps/plugin-cli";
import { confirm, message, open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";

import { createEditor, decodePng, type PixelEditor } from "./editor";
import { hexToRgba, rgbaToHex, type RGBA, type Tool } from "./types";

interface PngRead {
  path: string;
  bytes: number[];
}

interface AppState {
  window?: unknown;
  recent?: string[];
  /** The saved palette. `recent_colors` is the legacy key, read once for migration. */
  palette?: string[];
  recent_colors?: string[];
}

const DEFAULT_SIZE = 32;
// Pixel art is small by design. A grid larger than this isn't a pixel-editor
// document — at a window-fitting integer scale you can't see or click cells.
// New clamps to this; Open rejects PNGs above it (pointing at paint instead).
const MAX_GRID = 512;

// ---- app state --------------------------------------------------------

let editor: PixelEditor;
let docPath: string | null = null;
let savedHash = "";
let persisted: AppState = {};
let palette: string[] = [];
let currentColor: RGBA = { r: 221, g: 117, b: 150, a: 255 };

// Folder paging — the .png files alongside the open document, natural-sorted.
// Stepping through them (chevrons / Ctrl+[ / Ctrl+]) replaces a File→Open per
// sprite. Still one document on screen; this is navigation, not a project tree.
let siblings: string[] = [];
let prevBtn: HTMLButtonElement;
let nextBtn: HTMLButtonElement;

// Live tiling preview — the document repeated PREVIEW_TILES × PREVIEW_TILES at
// actual pixel size, so you can judge how a tile reads when it repeats.
const PREVIEW_TILES = 5;
let previewCanvas: HTMLCanvasElement;
let previewCtx: CanvasRenderingContext2D | null = null;

// ---- DOM refs ---------------------------------------------------------

let readoutEl: HTMLElement;
let swatchEl: HTMLElement;
let colorInput: HTMLInputElement;
let hexLabel: HTMLElement;
let paletteEl: HTMLElement;
let toolButtons: Record<Tool, HTMLButtonElement>;
let hoveredCell: { x: number; y: number } | null = null;

// ---- helpers ----------------------------------------------------------

function basename(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(i + 1) : path;
}

function isDirty(): boolean {
  return editor.hash() !== savedHash;
}

// App layout has no titlebar or status line, so the main-pane topbar carries
// the readout: filename + dirty dot · dimensions · hovered cell. The WM title
// (and body[data-dirty]) still track the document for the taskbar.
function updateTitle(): void {
  const name = docPath ? basename(docPath) : "untitled.png";
  document.body.dataset.dirty = String(isDirty());
  const label = `${isDirty() ? "• " : ""}${name} — Pixel Editor`;
  document.title = label;
  getCurrentWindow().setTitle(label).catch(() => {});
  renderReadout();
}

function updateState(cell?: { x: number; y: number } | null): void {
  hoveredCell = cell ?? null;
  renderReadout();
}

function renderReadout(): void {
  if (!readoutEl) return;
  const name = docPath ? basename(docPath) : "untitled.png";
  const dirty = isDirty() ? ` <span class="pe-dot">•</span>` : "";
  const cell = hoveredCell ? ` · ${hoveredCell.x}, ${hoveredCell.y}` : "";
  readoutEl.innerHTML = `${name}${dirty}<span class="pe-sep">·</span>${editor.width} × ${editor.height}${cell}`;
}

// ---- color -----------------------------------------------------------

function setColor(c: RGBA, fromPick = false): void {
  currentColor = { ...c };
  editor.setColor(currentColor);
  const hex = rgbaToHex(currentColor);
  swatchEl.style.background = hex;
  hexLabel.textContent = hex;
  colorInput.value = hex;
  if (fromPick) rememberColor(hex);
  else refreshActive();
}

// Cycle the current color through the saved palette — wheel over the canvas.
// Walks the same grouped order the rail shows, so wheeling moves through
// neighbouring hues group by group.
function cycleColor(dir: number): void {
  const order = paletteOrder();
  if (order.length < 2) return;
  const cur = rgbaToHex(currentColor);
  let i = order.indexOf(cur);
  i = i === -1 ? 0 : (i + dir + order.length) % order.length;
  const c = hexToRgba(order[i]);
  if (c) setColor(c);
}

// The palette bucketed into hue families (shared `familyOf`, so the labels and
// banding match color-editor), each family sorted dark → light. Empty families
// are dropped. `palette` itself stays insertion-ordered; this is a display view.
function groupedPalette(): Array<{ fam: string; hexes: string[] }> {
  const byFamily = new Map<string, string[]>();
  for (const hex of palette) {
    const rgb = hexToRgba(hex);
    const fam = rgb ? familyOf(rgb.r, rgb.g, rgb.b) : "Neutral";
    const arr = byFamily.get(fam) ?? [];
    arr.push(hex);
    byFamily.set(fam, arr);
  }
  const out: Array<{ fam: string; hexes: string[] }> = [];
  for (const fam of FAMILY_ORDER) {
    const arr = byFamily.get(fam);
    if (!arr || arr.length === 0) continue;
    arr.sort((a, b) => hexToHsl(a).l - hexToHsl(b).l);
    out.push({ fam, hexes: arr });
  }
  return out;
}

// The grouped palette flattened to a single ordering — what the wheel cycles
// through, matching the on-screen order group by group.
function paletteOrder(): string[] {
  return groupedPalette().flatMap((g) => g.hexes);
}

function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const rgb = hexToRgba(hex);
  if (!rgb) return { h: 0, s: 0, l: 0 };
  const r = rgb.r / 255, g = rgb.g / 255, b = rgb.b / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: h / 6, s, l };
}

function refreshActive(): void {
  if (!paletteEl) return;
  const cur = rgbaToHex(currentColor);
  for (const sw of Array.from(paletteEl.querySelectorAll<HTMLElement>(".pe-palette-swatch"))) {
    sw.dataset.active = String(sw.title === cur);
  }
}

// Painting a fresh color folds it into the palette (deduped). No cap — an
// explicitly built or loaded palette shouldn't silently shed colors.
function rememberColor(hex: string): void {
  if (palette.includes(hex)) { refreshActive(); return; }
  palette = [...palette, hex];
  renderPalette();
  persist();
}

function renderPalette(): void {
  if (!paletteEl) return;
  paletteEl.replaceChildren();
  const cur = rgbaToHex(currentColor);
  for (const { fam, hexes } of groupedPalette()) {
    const group = document.createElement("div");
    group.className = "pe-color-group";
    const heading = document.createElement("h4");
    heading.className = "pe-color-group-h";
    heading.textContent = fam;
    const grid = document.createElement("div");
    grid.className = "pe-color-group-grid";
    for (const hex of hexes) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "pe-palette-swatch";
      b.style.background = hex;
      b.title = hex;
      b.dataset.active = String(hex === cur);
      b.addEventListener("click", () => setColor(hexToRgba(hex) ?? currentColor));
      grid.appendChild(b);
    }
    group.append(heading, grid);
    paletteEl.appendChild(group);
  }
}

// ---- tools -----------------------------------------------------------

function setTool(t: Tool): void {
  editor.setTool(t);
  for (const k of Object.keys(toolButtons) as Tool[]) {
    toolButtons[k].dataset.active = String(k === t);
  }
}

// ---- document lifecycle ----------------------------------------------

function markClean(): void {
  savedHash = editor.hash();
  updateTitle();
}

function afterEdit(lastColor: RGBA | null): void {
  if (lastColor) rememberColor(rgbaToHex(lastColor));
  updateTitle();
}

function newDoc(w: number, h: number): void {
  editor.load(w, h);
  docPath = null;
  markClean();
  updateState();
  void syncPager();
}

// ---- folder paging ---------------------------------------------------

// Refresh the sibling list for the current document's folder, then update the
// chevrons. Natural sort (numeric) so tile_2 precedes tile_10.
async function syncPager(): Promise<void> {
  if (docPath) {
    try {
      const list = await invoke<string[]>("list_siblings", { path: docPath });
      list.sort((a, b) => basename(a).localeCompare(basename(b), undefined, { numeric: true, sensitivity: "base" }));
      siblings = list;
    } catch (e) {
      console.error("list_siblings failed:", e);
      siblings = [docPath];
    }
  } else {
    siblings = [];
  }
  renderPager();
}

// Step to the next (+1) / previous (-1) .png in the folder. No wrap — the
// chevrons disable at the ends. openPath() handles the unsaved-changes prompt.
async function page(dir: number): Promise<void> {
  if (!docPath || siblings.length < 2) return;
  const idx = siblings.indexOf(docPath);
  if (idx < 0) return;
  const next = idx + dir;
  if (next < 0 || next >= siblings.length) return;
  await openPath(siblings[next]);
}

function renderPager(): void {
  if (!prevBtn || !nextBtn) return;
  const idx = docPath ? siblings.indexOf(docPath) : -1;
  const show = siblings.length >= 2 && idx >= 0;
  prevBtn.hidden = !show;
  nextBtn.hidden = !show;
  prevBtn.disabled = idx <= 0;
  nextBtn.disabled = idx >= siblings.length - 1;
}

async function openPath(path: string): Promise<void> {
  // Read + decode first (so we know the size before touching the open doc),
  // then validate, then prompt to discard, then load. Failures surface as a
  // dialog — a swallowed error reads as "Open does nothing".
  let read: PngRead;
  try {
    read = await invoke<PngRead>("read_png", { path });
  } catch (e) {
    console.error("read_png failed:", e);
    await message(String(e), { title: "Couldn’t open file", kind: "error" });
    return;
  }

  let decoded: { width: number; height: number; pixels: Uint8ClampedArray<ArrayBuffer> };
  try {
    decoded = await decodePng(new Uint8Array(read.bytes));
  } catch (e) {
    console.error("decode failed:", e);
    await message(`${basename(read.path)} isn’t a PNG this app can read.`, { title: "Couldn’t open file", kind: "error" });
    return;
  }

  if (decoded.width > MAX_GRID || decoded.height > MAX_GRID) {
    await message(
      `${basename(read.path)} is ${decoded.width} × ${decoded.height}. Pixel Editor edits sprite-scale art up to ${MAX_GRID} × ${MAX_GRID} — for full-size images, use paint.`,
      { title: "Image too large", kind: "warning" },
    );
    return;
  }

  if (!(await confirmDiscard())) return;
  editor.load(decoded.width, decoded.height, decoded.pixels);
  docPath = read.path;
  markClean();
  updateState();
  await syncPager();
}

async function openViaDialog(): Promise<void> {
  const selected = await openDialog({
    multiple: false,
    directory: false,
    filters: [{ name: "PNG", extensions: ["png"] }],
  });
  if (typeof selected === "string") await openPath(selected);
}

// Load a .gpl palette (the shared krill palette format, also written by
// color-editor) into the recent-colors strip. Rust read_text couriers the
// file; the shared desktop-ui parser does the rest.
async function openPalette(): Promise<void> {
  const selected = await openDialog({
    multiple: false,
    directory: false,
    filters: [{ name: "GIMP Palette", extensions: ["gpl"] }],
  });
  if (typeof selected !== "string") return;
  let text: string;
  try {
    text = await invoke<string>("read_text", { path: selected });
  } catch (e) {
    console.error("open palette failed:", e);
    return;
  }
  const hexes: string[] = [];
  for (const c of parseGpl(text).colors) {
    const norm = c.hex.toLowerCase();
    if (!hexes.includes(norm)) hexes.push(norm);
  }
  if (hexes.length === 0) return;
  // Replace the palette with the whole file — every color, not a capped slice.
  palette = hexes;
  renderPalette();
  persist();
  const first = hexToRgba(palette[0]);
  if (first) setColor(first);
}

async function save(): Promise<void> {
  if (docPath) await writePng(docPath);
  else await saveAs();
}

async function saveAs(): Promise<void> {
  const chosen = await saveDialog({
    title: "Save PNG as…",
    defaultPath: docPath ? basename(docPath) : "sprite.png",
    filters: [{ name: "PNG", extensions: ["png"] }],
  });
  if (typeof chosen !== "string") return;
  await writePng(chosen);
}

async function writePng(path: string): Promise<void> {
  try {
    const blob = await editor.toPngBlob();
    const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
    const abs = await invoke<string>("write_png", { path, bytes });
    docPath = abs;
    markClean();
    await syncPager();
  } catch (e) {
    console.error("write_png failed:", e);
  }
}

// window.confirm() is unreliable in WebKitGTK; use the Tauri dialog instead.
async function confirmDiscard(): Promise<boolean> {
  if (!isDirty()) return true;
  return confirm("Discard unsaved changes?", { title: "Pixel Editor", kind: "warning" });
}

// ---- Size picker modal (shared by New and Resize) ---------------------

interface SizeOpts {
  title: string;
  width: number;
  height: number;
  confirmLabel: string;
}

/** Resolve to the chosen { width, height }, or null if cancelled. */
function pickSize(o: SizeOpts): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "pe-modal-backdrop";
    const modal = document.createElement("div");
    modal.className = "pe-modal";

    const h = document.createElement("h2");
    h.textContent = o.title;

    const presetRow = document.createElement("div");
    presetRow.className = "pe-preset-row";
    const wInput = numberInput(o.width);
    const hInput = numberInput(o.height);
    for (const n of [16, 32, 64]) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "pe-preset";
      b.textContent = `${n}×${n}`;
      b.addEventListener("click", () => { wInput.value = String(n); hInput.value = String(n); });
      presetRow.appendChild(b);
    }

    const dims = document.createElement("div");
    dims.className = "pe-dims";
    dims.append(field("Width", wInput), times(), field("Height", hInput));

    const actions = document.createElement("div");
    actions.className = "pe-modal-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "pe-btn";
    cancel.textContent = "Cancel";
    const confirmBtn = document.createElement("button");
    confirmBtn.type = "button";
    confirmBtn.className = "pe-btn pe-btn-primary";
    confirmBtn.textContent = o.confirmLabel;
    actions.append(cancel, confirmBtn);

    modal.append(h, presetRow, dims, actions);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    wInput.focus();
    wInput.select();

    const done = (value: { width: number; height: number } | null) => {
      backdrop.remove();
      resolve(value);
    };
    cancel.addEventListener("click", () => done(null));
    confirmBtn.addEventListener("click", () => done({ width: clampDim(wInput.value), height: clampDim(hInput.value) }));
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) done(null); });
    backdrop.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); done({ width: clampDim(wInput.value), height: clampDim(hInput.value) }); }
      if (e.key === "Escape") { e.preventDefault(); done(null); }
    });
  });
}

async function pickSizeAndNew(): Promise<void> {
  if (!(await confirmDiscard())) return;
  const s = await pickSize({ title: "New pixel art", width: DEFAULT_SIZE, height: DEFAULT_SIZE, confirmLabel: "Create" });
  if (s) newDoc(s.width, s.height);
}

// Resize the current canvas, keeping the art (anchored top-left; cropped or
// extended with transparent cells). Undoable.
async function resizeCanvas(): Promise<void> {
  const s = await pickSize({
    title: "Resize canvas",
    width: editor.width,
    height: editor.height,
    confirmLabel: "Resize",
  });
  if (!s) return;
  editor.resize(s.width, s.height);
  updateTitle();
  updateState();
}

function clampDim(v: string): number {
  return Math.max(1, Math.min(MAX_GRID, Math.round(Number(v) || DEFAULT_SIZE)));
}

function numberInput(value: number): HTMLInputElement {
  const i = document.createElement("input");
  i.type = "number";
  i.min = "1";
  i.max = "512";
  i.value = String(value);
  i.className = "pe-num";
  return i;
}

function field(label: string, input: HTMLInputElement): HTMLElement {
  const l = document.createElement("label");
  l.className = "pe-field";
  const s = document.createElement("span");
  s.textContent = label;
  l.append(s, input);
  return l;
}

function times(): HTMLElement {
  const s = document.createElement("span");
  s.className = "pe-times";
  s.textContent = "×";
  return s;
}

// ---- chrome ----------------------------------------------------------

function initChrome(version: string): void {
  const chrome = mountChrome({
    productName: "Pixel Editor",
    version,
    layout: "app",
    actions: {
      "new": () => void pickSizeAndNew(),
      "open": () => void openViaDialog(),
      "save": () => void save(),
      "save-as": () => void saveAs(),
      "undo": () => editor.undo(),
      "redo": () => editor.redo(),
    },
    customMenu: [
      { group: "file", items: [
        { label: "Open palette…", action: () => void openPalette() },
        { label: "Previous file", shortcut: "Ctrl+[", action: () => void page(-1) },
        { label: "Next file", shortcut: "Ctrl+]", action: () => void page(1) },
      ] },
      { group: "image", items: [{ label: "Resize canvas…", shortcut: "Ctrl+R", action: () => void resizeCanvas() }] },
    ],
    showAuxPane: true,
    updater: true,
  });

  // MAIN — the grid canvas, centered in the scrollable main content (below the
  // app-layout main topbar with its window controls).
  const stage = document.createElement("div");
  stage.className = "pe-stage";
  chrome.mainContent!.appendChild(stage);

  // Folder-paging chevrons — anchored to the stage (the edit area) so they sit
  // at its edges, clear of the preview panel. Hidden until a saved doc has
  // siblings.
  prevBtn = pagerButton("prev", "Previous file  (Ctrl+[)", ICON.chevronLeft, () => void page(-1));
  nextBtn = pagerButton("next", "Next file  (Ctrl+])", ICON.chevronRight, () => void page(1));
  stage.append(prevBtn, nextBtn);

  // Preview panel — right of the edit area, repeating the tile at actual size.
  buildPreview(chrome.mainContent!);

  editor = createEditor(stage, {
    onChange: afterEdit,
    onPick: (c) => setColor(c, true),
    onHover: (cell) => updateState(cell),
    onHistory: updateTitle,
    onRender: renderPreview,
  });

  // Wheel over the canvas cycles the current color through the saved palette —
  // fast access without reaching for the rail. (The grid fits the window, so
  // there's no scroll to hijack.)
  editor.canvas.addEventListener("wheel", (e) => {
    if (palette.length < 2) return;
    e.preventDefault();
    cycleColor(e.deltaY > 0 ? 1 : -1);
  }, { passive: false });

  // Readout in the main topbar (app layout has no status line).
  readoutEl = document.createElement("div");
  readoutEl.className = "pe-readout mono";
  chrome.viewport.querySelector(".main-topbar")?.prepend(readoutEl);

  // AUX — tool rail + color block (below the hamburger strip the app layout
  // already put at the top of the pane).
  buildRail(chrome.aux!);
}

function buildRail(aux: HTMLElement): void {
  const rail = document.createElement("div");
  rail.className = "pe-rail";
  rail.setAttribute("aria-label", "Tools");
  aux.appendChild(rail);

  // Tools
  const toolsSection = section("Tools");
  toolButtons = {
    paint: toolButton("paint", "Paint", "B", ICON.brush),
    erase: toolButton("erase", "Erase", "E", ICON.eraser),
    pick: toolButton("pick", "Pick", "I", ICON.pipette),
  };
  toolsSection.append(toolButtons.paint, toolButtons.erase, toolButtons.pick);

  // Color
  const colorSection = section("Color");
  const swatchRow = document.createElement("label");
  swatchRow.className = "pe-swatch-row";
  swatchRow.title = "Change color";
  swatchEl = document.createElement("span");
  swatchEl.className = "pe-swatch";
  colorInput = document.createElement("input");
  colorInput.type = "color";
  colorInput.className = "pe-color-input";
  colorInput.addEventListener("input", () => {
    const c = hexToRgba(colorInput.value);
    if (c) { setColor(c); rememberColor(rgbaToHex(c)); }
  });
  hexLabel = document.createElement("span");
  hexLabel.className = "pe-hex mono";
  swatchRow.append(swatchEl, colorInput, hexLabel);

  paletteEl = document.createElement("div");
  paletteEl.className = "pe-palette";

  colorSection.append(swatchRow, paletteEl);

  rail.append(toolsSection, colorSection);
}

function buildPreview(mainContent: HTMLElement): void {
  const pane = document.createElement("aside");
  pane.className = "pe-preview-pane";

  const heading = document.createElement("div");
  heading.className = "pe-section-h";
  heading.textContent = `Preview · ${PREVIEW_TILES}×${PREVIEW_TILES}`;

  previewCanvas = document.createElement("canvas");
  previewCanvas.className = "pe-preview-canvas";
  previewCtx = previewCanvas.getContext("2d");

  pane.append(heading, previewCanvas);
  mainContent.appendChild(pane);
}

// Repaint the tiling preview from the editor's current native buffer. Fired on
// every editor render (so it tracks live edits) plus open / new / resize.
function renderPreview(): void {
  if (!previewCtx) return;
  const w = editor.width;
  const h = editor.height;
  const pw = w * PREVIEW_TILES;
  const ph = h * PREVIEW_TILES;
  if (previewCanvas.width !== pw || previewCanvas.height !== ph) {
    previewCanvas.width = pw;
    previewCanvas.height = ph;
    previewCanvas.style.width = `${pw}px`;
    previewCanvas.style.height = `${ph}px`;
  }

  // Transparency checkerboard (Space-Cadet-alpha over Ghost White, matching the
  // canvas), in fixed 4px blocks independent of tile size.
  previewCtx.fillStyle = "#fafaff";
  previewCtx.fillRect(0, 0, pw, ph);
  previewCtx.fillStyle = "rgba(48, 52, 63, 0.06)";
  const block = 4;
  for (let y = 0; y < ph; y += block) {
    for (let x = 0; x < pw; x += block) {
      if ((x / block + y / block) % 2 === 1) previewCtx.fillRect(x, y, block, block);
    }
  }

  // The tile, repeated at actual size (no scaling).
  previewCtx.imageSmoothingEnabled = false;
  const src = editor.nativeCanvas();
  for (let ty = 0; ty < PREVIEW_TILES; ty++) {
    for (let tx = 0; tx < PREVIEW_TILES; tx++) {
      previewCtx.drawImage(src, tx * w, ty * h);
    }
  }
}

function pagerButton(side: "prev" | "next", title: string, icon: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `pe-pager pe-pager-${side}`;
  b.title = title;
  b.setAttribute("aria-label", title);
  b.innerHTML = icon;
  b.hidden = true;
  b.addEventListener("click", onClick);
  return b;
}

function section(title: string): HTMLElement {
  const s = document.createElement("section");
  s.className = "pe-section";
  const h = document.createElement("h3");
  h.className = "pe-section-h";
  h.textContent = title;
  s.appendChild(h);
  return s;
}

function toolButton(id: Tool, label: string, key: string, icon: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "pe-tool";
  b.dataset.tool = id;
  b.innerHTML = icon;
  const span = document.createElement("span");
  span.className = "pe-tool-label";
  span.textContent = label;
  const kbd = document.createElement("kbd");
  kbd.textContent = key;
  b.append(span, kbd);
  b.addEventListener("click", () => setTool(id));
  return b;
}

// ---- keyboard (tool keys; file/undo shortcuts come from the registry) --

function installKeyboard(): void {
  window.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
    // Folder paging — Ctrl+] / Ctrl+[ step through the current folder.
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      if (e.code === "BracketRight") { e.preventDefault(); void page(1); return; }
      if (e.code === "BracketLeft") { e.preventDefault(); void page(-1); return; }
      return;
    }
    if (e.altKey) return;
    switch (e.code) {
      case "KeyB": setTool("paint"); break;
      case "KeyE": setTool("erase"); break;
      case "KeyI": setTool("pick"); break;
      default: return;
    }
    e.preventDefault();
  });
}

// ---- drag-drop -------------------------------------------------------

async function installFileDrop(): Promise<void> {
  const wv = getCurrentWebview();
  await wv.onDragDropEvent(async (e) => {
    if (e.payload.type === "drop") {
      const path = e.payload.paths[0];
      if (path && /\.png$/i.test(path)) await openPath(path);
    }
  });
}

// ---- persistence -----------------------------------------------------

function persist(): void {
  persisted.palette = palette;
  delete persisted.recent_colors; // migrated to `palette`
  try {
    void invoke("save_state", { state: persisted }).catch(() => {});
  } catch {
    /* not under tauri */
  }
}

// ---- icons (Lucide, currentColor) ------------------------------------

const ICON = {
  brush: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m14.622 17.897-10.68-2.913"/><path d="M18.376 2.622a1 1 0 1 1 3.002 3.002L17.36 9.643a.5.5 0 0 0 0 .707l.944.944a2.41 2.41 0 0 1 0 3.408l-.944.944a.5.5 0 0 1-.707 0L8.354 9.354a.5.5 0 0 1 0-.707l.944-.944a2.41 2.41 0 0 1 3.408 0l.944.944a.5.5 0 0 0 .707 0z"/><path d="M9 8c-1.804 2.71-3.97 3.46-6.583 3.948a.507.507 0 0 0-.302.819l7.32 8.883a1 1 0 0 0 1.185.204C12.735 21.122 14 19.5 14 17"/></svg>`,
  eraser: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/></svg>`,
  pipette: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z"/></svg>`,
  chevronLeft: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>`,
  chevronRight: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>`,
};

// ---- boot ------------------------------------------------------------

async function boot(): Promise<void> {
  const version = await getVersion().catch(() => "0.0.0");
  initChrome(version);
  installKeyboard();
  try {
    await installFileDrop();
  } catch {
    /* drop events unavailable */
  }

  try {
    const st = await invoke<AppState | null>("load_state");
    if (st) {
      persisted = st;
      if (Array.isArray(st.palette)) palette = st.palette;
      else if (Array.isArray(st.recent_colors)) palette = st.recent_colors; // legacy
    }
  } catch {
    /* first run */
  }

  setTool("paint");
  setColor(currentColor);
  renderPalette();

  // Boot into a ready default grid — this is a creation tool; an empty state
  // would just be a New click in the way.
  newDoc(DEFAULT_SIZE, DEFAULT_SIZE);

  window.addEventListener("resize", () => editor.fit());

  // CLI arg / dev fixture open.
  let opened = false;
  try {
    const matches = await getMatches();
    const arg = matches.args.file?.value;
    if (typeof arg === "string" && arg.length > 0) {
      await openPath(arg);
      opened = true;
    }
  } catch {
    /* cli plugin unavailable */
  }
  if (!opened && import.meta.env.DEV) {
    try {
      const dev = await invoke<string | null>("dev_test_file");
      if (dev) await openPath(dev);
    } catch {
      /* no fixture */
    }
  }
}

boot().catch((e) => {
  console.error("boot failed:", e);
  showBootError(e);
});
