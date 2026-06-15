// One cell of the grid is one RGBA image pixel. `a === 0` means the cell is
// empty (transparent) — it shows the checkerboard and exports as a transparent
// PNG pixel.
export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

export type Tool = "paint" | "erase" | "pick";

export function rgbaToHex({ r, g, b }: RGBA): string {
  const h = (n: number) => n.toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

export function hexToRgba(hex: string, a = 255): RGBA | null {
  const v = hex.trim().toLowerCase();
  const m6 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/.exec(v);
  if (m6) {
    return { r: parseInt(m6[1], 16), g: parseInt(m6[2], 16), b: parseInt(m6[3], 16), a };
  }
  const m3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(v);
  if (m3) {
    const dup = (c: string) => parseInt(c + c, 16);
    return { r: dup(m3[1]), g: dup(m3[2]), b: dup(m3[3]), a };
  }
  return null;
}
