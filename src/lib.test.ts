import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { join } from "path";

describe("loadGhostty", () => {
  it("loads the pinned artifact from the plugin root", async () => {
    const { loadGhostty } = await import("./lib");
    const wasmPath = join(import.meta.dirname, "..", "ghostty-vt.wasm");

    const ghostty = await loadGhostty(wasmPath);

    assert.ok(ghostty.exports.memory instanceof WebAssembly.Memory);
    assert.ok(ghostty.sizeOf("GhosttyStyle") > 0);
    assert.strictEqual(typeof ghostty.fn("ghostty_terminal_new"), "function");
  });
});

describe("buildThemeFromObsidian", () => {
  it("maps CSS variables to ITheme fields", async () => {
    // Mock the DOM globals that getCssVar relies on
    const cssVars: Record<string, string> = {
      "--background-primary": "#282c34",
      "--text-normal": "#abb2bf",
      "--text-accent": "#61afef",
      "--text-selection": "#3e4451",
      "--color-base-00": "#21252b",
      "--color-red": "#e06c75",
      "--color-green": "#98c379",
      "--color-yellow": "#e5c07b",
      "--color-blue": "#61afef",
      "--color-purple": "#c678dd",
      "--color-cyan": "#56b6c2",
      "--color-base-70": "#abb2bf",
      "--color-base-50": "#5c6370",
      "--color-base-100": "#ffffff",
    };

    const mockGetPropertyValue = mock.fn((name: string) => cssVars[name] ?? "");
    globalThis.getComputedStyle = (() => ({
      getPropertyValue: mockGetPropertyValue,
    })) as any;
    globalThis.document = { body: {} } as any;

    // Re-import to pick up the mocked globals.
    // Node's ESM loader caches by resolved URL, so a query string forces a fresh
    // module instance. The extension is required — `./lib?t=…` does not resolve.
    const { buildThemeFromObsidian } = await import(`./lib.ts?t=${Date.now()}`);

    const theme = buildThemeFromObsidian();

    assert.strictEqual(theme.background, "#282c34");
    assert.strictEqual(theme.foreground, "#abb2bf");
    assert.strictEqual(theme.cursor, "#61afef");
    assert.strictEqual(theme.cursorAccent, "#282c34");
    assert.strictEqual(theme.selectionBackground, "#3e4451");
    assert.strictEqual(theme.black, "#21252b");
    assert.strictEqual(theme.red, "#e06c75");
    assert.strictEqual(theme.green, "#98c379");
    assert.strictEqual(theme.yellow, "#e5c07b");
    assert.strictEqual(theme.blue, "#61afef");
    assert.strictEqual(theme.magenta, "#c678dd");
    assert.strictEqual(theme.cyan, "#56b6c2");
    assert.strictEqual(theme.white, "#abb2bf");
    assert.strictEqual(theme.brightBlack, "#5c6370");
    assert.strictEqual(theme.brightWhite, "#ffffff");
  });

  it("falls back to defaults when CSS variables are empty", async () => {
    const mockGetPropertyValue = mock.fn(() => "");
    globalThis.getComputedStyle = (() => ({
      getPropertyValue: mockGetPropertyValue,
    })) as any;
    globalThis.document = { body: {} } as any;

    const { buildThemeFromObsidian } = await import(`./lib.ts?t=${Date.now()}`);

    const theme = buildThemeFromObsidian();

    assert.strictEqual(theme.background, "#1e1e1e");
    assert.strictEqual(theme.foreground, "#d4d4d4");
    assert.strictEqual(theme.cursor, "#528bff");
    assert.strictEqual(theme.selectionBackground, undefined);
    assert.strictEqual(theme.black, "#000000");
    assert.strictEqual(theme.brightWhite, "#ffffff");
  });
});
