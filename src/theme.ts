/**
 * Terminal color theme.
 *
 * Field names follow the xterm.js/ghostty-web convention so the shape stays
 * familiar, but this is Spectre's own type now — nothing outside this repo
 * defines it.
 */
export interface ITheme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground?: string;

  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;

  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

/** The 16 ANSI slots in palette order, for indexing a theme by color number. */
export const ANSI_ORDER = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow",
  "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
] as const satisfies readonly (keyof ITheme)[];

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Parse one rgb() channel, which may be a number or a percentage. */
function parseChannel(raw: string): number | null {
  const n = raw.endsWith("%") ? (Number.parseFloat(raw) / 100) * 255 : Number.parseFloat(raw);
  return Number.isFinite(n) ? Math.max(0, Math.min(255, Math.round(n))) : null;
}

/**
 * Parse a CSS color into RGB.
 *
 * Only the notations Obsidian actually emits for its theme variables are
 * handled — hex and rgb()/rgba(). Anything else returns null so the caller
 * can fall back rather than render a silently wrong color.
 */
export function parseColor(css: string): Rgb | null {
  const value = css.trim();
  if (value === "") return null;

  const hex = /^#([0-9a-f]{3,8})$/i.exec(value);
  if (hex) {
    const digits = hex[1];
    if (digits.length === 3 || digits.length === 4) {
      return {
        r: parseInt(digits[0] + digits[0], 16),
        g: parseInt(digits[1] + digits[1], 16),
        b: parseInt(digits[2] + digits[2], 16),
      };
    }
    if (digits.length === 6 || digits.length === 8) {
      return {
        r: parseInt(digits.slice(0, 2), 16),
        g: parseInt(digits.slice(2, 4), 16),
        b: parseInt(digits.slice(4, 6), 16),
      };
    }
    return null;
  }

  const fn = /^rgba?\(([^)]+)\)$/i.exec(value);
  if (fn) {
    const parts = fn[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const [r, g, b] = parts.slice(0, 3).map(parseChannel);
    if (r === null || g === null || b === null) return null;
    return { r, g, b };
  }

  return null;
}

export function rgbToCss({ r, g, b }: Rgb): string {
  return `rgb(${r},${g},${b})`;
}

/**
 * Expand a theme's 16 ANSI colors into the full 256-entry palette
 * libghostty expects: 16 themed colors, the 6×6×6 color cube, then the
 * 24-step grayscale ramp, per the xterm convention.
 */
export function buildPalette(theme: ITheme, fallback: Rgb = { r: 0, g: 0, b: 0 }): Rgb[] {
  const palette: Rgb[] = [];

  for (const slot of ANSI_ORDER) {
    palette.push(parseColor(theme[slot] as string) ?? fallback);
  }

  const cube = [0, 95, 135, 175, 215, 255];
  for (let r = 0; r < 6; r++) {
    for (let g = 0; g < 6; g++) {
      for (let b = 0; b < 6; b++) {
        palette.push({ r: cube[r], g: cube[g], b: cube[b] });
      }
    }
  }

  for (let i = 0; i < 24; i++) {
    const level = 8 + i * 10;
    palette.push({ r: level, g: level, b: level });
  }

  return palette;
}
