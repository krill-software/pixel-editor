import "@krill-software/desktop-ui/styles";
import "./styles.css";

import { mountChrome, showBootError } from "@krill-software/desktop-ui";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getMatches } from "@tauri-apps/plugin-cli";
import { confirm, open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";

import { createEditor, decodePng, type PixelEditor } from "./editor";
import { hexToRgba, rgbaToHex, type RGBA, type Tool } from "./types";

interface PngRead {
  path: string;
  bytes: number[];
}

interface AppState {
  window?: unknown;
  recent?: string[];
  recent_colors?: string[];
}

const DEFAULT_SIZE = 32;
const RECENT_MAX = 12;

// ---- app state --------------------------------------------------------

let editor: PixelEditor;
let docPath: string | null = null;
let savedHash = "";
let persisted: AppState = {};
let recentColors: string[] = [];
let currentColor: RGBA = { r: 221, g: 117, b: 150, a: 255 };

// ---- DOM refs ---------------------------------------------------------

let readoutEl: HTMLElement;
let swatchEl: HTMLElement;
let colorInput: HTMLInputElement;
let hexLabel: HTMLElement;
let recentEl: HTMLElement;
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
  else refreshRecentActive();
}

// Cycle the current color through the saved palette — wheel over the canvas.
function cycleColor(dir: number): void {
  if (recentColors.length < 2) return;
  const cur = rgbaToHex(currentColor);
  let i = recentColors.indexOf(cur);
  i = i === -1 ? 0 : (i + dir + recentColors.length) % recentColors.length;
  const c = hexToRgba(recentColors[i]);
  if (c) setColor(c);
}

function refreshRecentActive(): void {
  if (!recentEl) return;
  const cur = rgbaToHex(currentColor);
  for (const child of Array.from(recentEl.children)) {
    (child as HTMLElement).dataset.active = String((child as HTMLElement).title === cur);
  }
}

function rememberColor(hex: string): void {
  recentColors = [hex, ...recentColors.filter((c) => c !== hex)].slice(0, RECENT_MAX);
  renderRecent();
  persist();
}

function renderRecent(): void {
  recentEl.replaceChildren();
  for (const hex of recentColors) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pe-recent-swatch";
    b.style.background = hex;
    b.title = hex;
    b.dataset.active = String(hex === rgbaToHex(currentColor));
    b.addEventListener("click", () => setColor(hexToRgba(hex) ?? currentColor));
    recentEl.appendChild(b);
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
}

async function openPath(path: string): Promise<void> {
  if (!(await confirmDiscard())) return;
  let read: PngRead;
  try {
    read = await invoke<PngRead>("read_png", { path });
  } catch (e) {
    console.error("read_png failed:", e);
    return;
  }
  try {
    const { width, height, pixels } = await decodePng(new Uint8Array(read.bytes));
    editor.load(width, height, pixels);
    docPath = read.path;
    markClean();
    updateState();
  } catch (e) {
    console.error("decode failed:", e);
  }
}

async function openViaDialog(): Promise<void> {
  const selected = await openDialog({
    multiple: false,
    directory: false,
    filters: [{ name: "PNG", extensions: ["png"] }],
  });
  if (typeof selected === "string") await openPath(selected);
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
  } catch (e) {
    console.error("write_png failed:", e);
  }
}

// window.confirm() is unreliable in WebKitGTK; use the Tauri dialog instead.
async function confirmDiscard(): Promise<boolean> {
  if (!isDirty()) return true;
  return confirm("Discard unsaved changes?", { title: "Pixel Editor", kind: "warning" });
}

// ---- New: size picker (the one app-specific modal — document creation) --

async function pickSizeAndNew(): Promise<void> {
  if (!(await confirmDiscard())) return;
  const backdrop = document.createElement("div");
  backdrop.className = "pe-modal-backdrop";
  const modal = document.createElement("div");
  modal.className = "pe-modal";

  const h = document.createElement("h2");
  h.textContent = "New pixel art";

  const presetRow = document.createElement("div");
  presetRow.className = "pe-preset-row";
  const wInput = numberInput(DEFAULT_SIZE);
  const hInput = numberInput(DEFAULT_SIZE);
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
  const create = document.createElement("button");
  create.type = "button";
  create.className = "pe-btn pe-btn-primary";
  create.textContent = "Create";
  actions.append(cancel, create);

  modal.append(h, presetRow, dims, actions);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  wInput.focus();
  wInput.select();

  const close = () => backdrop.remove();
  const submit = () => {
    const w = clampDim(wInput.value);
    const hh = clampDim(hInput.value);
    close();
    newDoc(w, hh);
  };
  cancel.addEventListener("click", close);
  create.addEventListener("click", submit);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
  backdrop.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); submit(); }
    if (e.key === "Escape") { e.preventDefault(); close(); }
  });
}

function clampDim(v: string): number {
  return Math.max(1, Math.min(512, Math.round(Number(v) || DEFAULT_SIZE)));
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
    showAuxPane: true,
    updater: true,
  });

  // MAIN — the grid canvas, centered in the scrollable main content (below the
  // app-layout main topbar with its window controls).
  const stage = document.createElement("div");
  stage.className = "pe-stage";
  chrome.mainContent!.appendChild(stage);

  editor = createEditor(stage, {
    onChange: afterEdit,
    onPick: (c) => setColor(c, true),
    onHover: (cell) => updateState(cell),
    onHistory: updateTitle,
  });

  // Wheel over the canvas cycles the current color through the saved palette —
  // fast access without reaching for the rail. (The grid fits the window, so
  // there's no scroll to hijack.)
  editor.canvas.addEventListener("wheel", (e) => {
    if (recentColors.length < 2) return;
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

  recentEl = document.createElement("div");
  recentEl.className = "pe-recent";

  colorSection.append(swatchRow, recentEl);

  rail.append(toolsSection, colorSection);
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
    if (e.ctrlKey || e.metaKey || e.altKey) return;
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
  persisted.recent_colors = recentColors;
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
      if (Array.isArray(st.recent_colors)) recentColors = st.recent_colors;
    }
  } catch {
    /* first run */
  }

  setTool("paint");
  setColor(currentColor);
  renderRecent();

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
