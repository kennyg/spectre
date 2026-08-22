import { readFileSync } from "fs";
import { GhosttyModule } from "./vt/wasm";
import type { ITheme } from "./theme";

export type { ITheme } from "./theme";

/**
 * Load the official libghostty-vt WebAssembly artifact from disk.
 *
 * The artifact is built wasm32-freestanding and declares no imports, so this
 * is just read-compile-instantiate — there is no glue to keep in sync with a
 * build of the module.
 */
export async function loadGhostty(wasmPath: string): Promise<GhosttyModule> {
  const buf = readFileSync(wasmPath);
  const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return GhosttyModule.instantiate(bytes);
}

/**
 * Read an Obsidian CSS variable from the body element.
 */
export function getCssVar(name: string): string {
  return getComputedStyle(document.body).getPropertyValue(name).trim();
}

/**
 * Build a terminal theme from Obsidian's current CSS variables.
 */
export function buildThemeFromObsidian(): ITheme {
  return {
    background: getCssVar("--background-primary") || "#1e1e1e",
    foreground: getCssVar("--text-normal") || "#d4d4d4",
    cursor: getCssVar("--text-accent") || "#528bff",
    cursorAccent: getCssVar("--background-primary") || "#1e1e1e",
    selectionBackground: getCssVar("--text-selection") || undefined,

    // Map Obsidian's color palette to ANSI colors
    black: getCssVar("--color-base-00") || "#000000",
    red: getCssVar("--color-red") || "#e06c75",
    green: getCssVar("--color-green") || "#98c379",
    yellow: getCssVar("--color-yellow") || "#e5c07b",
    blue: getCssVar("--color-blue") || "#61afef",
    magenta: getCssVar("--color-purple") || "#c678dd",
    cyan: getCssVar("--color-cyan") || "#56b6c2",
    white: getCssVar("--color-base-70") || "#abb2bf",

    brightBlack: getCssVar("--color-base-50") || "#5c6370",
    brightRed: getCssVar("--color-red") || "#e06c75",
    brightGreen: getCssVar("--color-green") || "#98c379",
    brightYellow: getCssVar("--color-yellow") || "#e5c07b",
    brightBlue: getCssVar("--color-blue") || "#61afef",
    brightMagenta: getCssVar("--color-purple") || "#c678dd",
    brightCyan: getCssVar("--color-cyan") || "#56b6c2",
    brightWhite: getCssVar("--color-base-100") || "#ffffff",
  };
}
