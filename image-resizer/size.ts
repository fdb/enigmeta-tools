// Parsing and formatting of sizes typed by a person: pixels, percentages,
// factors (×2, 2x, 1/3) and print lengths (mm, cm, in) at a given resolution.

export type Unit = "px" | "pct" | "mm" | "cm";

const MM_PER_INCH = 25.4;

const NUM = String.raw`(\d+(?:\.\d*)?|\.\d+)`;

/** A factor like "2", "×2", "x2", "2x", "*2", "50%", "1/3", "0.5". */
export function parseFactor(input: string): number | null {
  const s = normalise(input);
  if (!s) return null;
  let m: RegExpMatchArray | null;
  if ((m = s.match(new RegExp(`^[x*]?${NUM}x?$`)))) return positive(parseFloat(m[1]));
  if ((m = s.match(new RegExp(`^${NUM}%$`)))) return positive(parseFloat(m[1]) / 100);
  if ((m = s.match(new RegExp(`^${NUM}/${NUM}$`)))) return positive(parseFloat(m[1]) / parseFloat(m[2]));
  return null;
}

/**
 * Parse a width or height field into pixels. A bare number is read in the
 * current unit; an explicit suffix (px, %, mm, cm, in) or factor overrides it.
 */
export function parseLength(input: string, unit: Unit, original: number, ppi: number): number | null {
  const s = normalise(input);
  if (!s) return null;
  let m: RegExpMatchArray | null;
  // Factors: ×2, x2, 2x, *2, 1/3.
  if ((m = s.match(new RegExp(`^(?:[x*]${NUM}|${NUM}x)$`)))) {
    return px(original * parseFloat(m[1] ?? m[2]));
  }
  if ((m = s.match(new RegExp(`^${NUM}/${NUM}$`)))) return px((original * parseFloat(m[1])) / parseFloat(m[2]));
  m = s.match(new RegExp(`^${NUM}(px|%|mm|cm|in|")?$`));
  if (!m) return null;
  const v = parseFloat(m[1]);
  const u = m[2] ?? unitSuffix(unit);
  switch (u) {
    case "px":
      return px(v);
    case "%":
      return px((original * v) / 100);
    case "mm":
      return px((v / MM_PER_INCH) * ppi);
    case "cm":
      return px(((v * 10) / MM_PER_INCH) * ppi);
    case "in":
    case '"':
      return px(v * ppi);
  }
  return null;
}

/** Show a pixel size in a unit. */
export function formatLength(pixels: number, unit: Unit, original: number, ppi: number): string {
  switch (unit) {
    case "px":
      return String(pixels);
    case "pct":
      return trim((pixels / original) * 100, 1);
    case "mm":
      return trim((pixels / ppi) * MM_PER_INCH, 1);
    case "cm":
      return trim((pixels / ppi) * (MM_PER_INCH / 10), 2);
  }
}

/** Print size in mm, for the readout. */
export function toMm(pixels: number, ppi: number): number {
  return (pixels / ppi) * MM_PER_INCH;
}

/** "×2", "×0.5", "×⅓" style label for a factor. */
export function formatFactor(f: number): string {
  for (const [v, s] of [
    [1 / 2, "½"],
    [1 / 3, "⅓"],
    [1 / 4, "¼"],
    [2 / 3, "⅔"],
    [3 / 4, "¾"],
  ] as const) {
    if (Math.abs(f - v) < 1e-4) return `×${s}`;
  }
  return `×${trim(f, f < 1 ? 3 : 2)}`;
}

export function trim(v: number, digits: number): string {
  return v.toFixed(digits).replace(/\.?0+$/, "");
}

function normalise(s: string): string {
  return s.trim().toLowerCase().replace(/,/g, ".").replace(/×/g, "x").replace(/\s+/g, "");
}

function unitSuffix(u: Unit): string {
  return u === "pct" ? "%" : u;
}

function px(v: number): number | null {
  if (!Number.isFinite(v) || v <= 0) return null;
  return Math.max(1, Math.round(v));
}

function positive(v: number): number | null {
  return Number.isFinite(v) && v > 0 ? v : null;
}
