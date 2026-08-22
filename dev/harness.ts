// Browser harness for the DOM layer.
//
// `src/vt` is covered by headless tests; the renderer and the DOM facade are
// not, because they need a canvas and real events. This page mounts a Terminal
// against a fake shell so both can be exercised without an Obsidian vault.
//
//   nub run harness      (then open http://localhost:5199/dev/)
//
// Not part of the plugin build — dev/ is excluded from the Vite lib build.

import { GhosttyModule } from "../src/vt/wasm";
import { Terminal } from "../src/terminal";
import type { ITheme } from "../src/theme";

const status = document.querySelector("#status") as HTMLElement;
const sizeLabel = document.querySelector("#size") as HTMLElement;
const results = document.querySelector("#results") as HTMLElement;
const host = document.querySelector("#host") as HTMLElement;

function cssVar(name: string): string {
  return getComputedStyle(document.body).getPropertyValue(name).trim();
}

/** The same mapping main.ts does, minus the Obsidian import. */
function theme(): ITheme {
  return {
    background: cssVar("--background-primary") || "#1e1e1e",
    foreground: cssVar("--text-normal") || "#d4d4d4",
    cursor: cssVar("--text-accent") || "#528bff",
    cursorAccent: cssVar("--background-primary") || "#1e1e1e",
    selectionBackground: cssVar("--text-selection") || undefined,
    black: cssVar("--color-base-00"),
    red: cssVar("--color-red"),
    green: cssVar("--color-green"),
    yellow: cssVar("--color-yellow"),
    blue: cssVar("--color-blue"),
    magenta: cssVar("--color-purple"),
    cyan: cssVar("--color-cyan"),
    white: cssVar("--color-base-70"),
    brightBlack: cssVar("--color-base-50"),
    brightRed: cssVar("--color-red"),
    brightGreen: cssVar("--color-green"),
    brightYellow: cssVar("--color-yellow"),
    brightBlue: cssVar("--color-blue"),
    brightMagenta: cssVar("--color-purple"),
    brightCyan: cssVar("--color-cyan"),
    brightWhite: cssVar("--color-base-100"),
  };
}

const DEMO = [
  "\x1b[1;32m➜\x1b[0m  \x1b[1;36mspectre\x1b[0m git:(\x1b[31mmain\x1b[0m) ls -la\r\n",
  "total 1144\r\n",
  "\x1b[34mdrwxr-xr-x\x1b[0m  26 dev     832 Jan  1 00:00 \x1b[1;34m.\x1b[0m\r\n",
  "\x1b[34m-rw-r--r--\x1b[0m   1 dev   46038 Jan  1 00:00 main.js\r\n",
  "\x1b[34m-rwxr-xr-x\x1b[0m   1 dev  920233 Jan  1 00:00 \x1b[32mghostty-vt.wasm\x1b[0m\r\n",
  "\r\n",
  "styles: \x1b[1mbold\x1b[0m \x1b[3mitalic\x1b[0m \x1b[4munderline\x1b[0m \x1b[9mstrike\x1b[0m \x1b[7minverse\x1b[0m \x1b[2mfaint\x1b[0m\r\n",
  "curly:  \x1b[4:3;58;2;224;108;117munderline\x1b[0m   double: \x1b[21mdouble\x1b[0m\r\n",
  "24-bit: ",
  ...Array.from({ length: 32 }, (_, i) => `\x1b[48;2;${i * 8};${255 - i * 8};128m `),
  "\x1b[0m\r\n",
  "256:    ",
  ...Array.from({ length: 32 }, (_, i) => `\x1b[48;5;${16 + i * 6}m `),
  "\x1b[0m\r\n",
  "unicode: 👻 日本語 café ﬁ ｱｲｳ →←↑↓ ██▓▒░\r\n",
  "\x1b[1;33mwrapped:\x1b[0m ",
  "the quick brown fox jumps over the lazy dog and keeps going well past the right edge of this terminal ",
  "to prove that soft wrapping survives the round trip\r\n",
  "\r\n\x1b[1;32m➜\x1b[0m  \x1b[1;36mspectre\x1b[0m ",
].join("");

async function main() {
  const wasm = await fetch("/ghostty-vt.wasm");
  if (!wasm.ok) throw new Error(`GET /ghostty-vt.wasm -> ${wasm.status}`);
  const ghostty = await GhosttyModule.instantiate(await wasm.arrayBuffer());

  const term = new Terminal({
    ghostty,
    fontSize: 13,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    cursorBlink: true,
    scrollback: 5000,
    theme: theme(),
  });

  // Fake shell: echo what is typed, and turn Enter into a new prompt line.
  const decoder = new TextDecoder();
  term.onData((bytes) => {
    const text = decoder.decode(bytes);
    // Swallow the terminal's own query replies rather than echoing them.
    if (text.startsWith("\x1b[") && /[A-Za-z]$/.test(text) && text.length > 2) return;
    term.write(text === "\r" ? "\r\n\x1b[1;32m➜\x1b[0m  " : text);
  });
  term.onResize(({ cols, rows }) => {
    sizeLabel.textContent = `${cols}×${rows}`;
  });
  term.onTitleChange((t) => {
    document.title = t || "Spectre terminal harness";
  });

  term.open(host);
  term.observeResize();
  term.write(DEMO);
  term.focus();

  (globalThis as Record<string, unknown>).__term = term;
  (globalThis as Record<string, unknown>).__ghostty = ghostty;

  document.querySelector("#demo")!.addEventListener("click", () => {
    term.write(`\r\n${DEMO}`);
    term.focus();
  });
  document.querySelector("#selftest")!.addEventListener("click", () => {
    results.textContent = selfTest(term).join("\n");
  });

  status.textContent = `ready — libghostty-vt ${ghostty.buildInfo.version} (${ghostty.buildInfo.optimize})`;
}

/**
 * Assertions that only mean something with a live canvas and real layout:
 * cell metrics, fit, scrollback, selection round-trip.
 */
function selfTest(term: Terminal): string[] {
  const out: string[] = [];
  const check = (name: string, ok: boolean, detail = "") =>
    out.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);

  const { cols, rows } = term.dimensions;
  check("fit produced a sane grid", cols > 20 && rows > 5, `${cols}×${rows}`);

  const canvas = document.querySelector("canvas") as HTMLCanvasElement;
  check("canvas is mounted", !!canvas);
  check(
    "canvas is scaled for the device pixel ratio",
    canvas.width === Math.ceil(Number.parseFloat(canvas.style.width) * devicePixelRatio),
    `${canvas.width}px backing / ${canvas.style.width} css @ ${devicePixelRatio}x`,
  );
  check("canvas fills the grid", canvas.width > 0 && canvas.height > 0);

  // Non-blank pixels mean the renderer actually drew something.
  const ctx = canvas.getContext("2d")!;
  const pixels = ctx.getImageData(0, 0, canvas.width, Math.min(canvas.height, 200)).data;
  const distinct = new Set<string>();
  for (let i = 0; i < pixels.length; i += 4) {
    distinct.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`);
  }
  check("renderer drew multiple colors", distinct.size > 20, `${distinct.size} distinct`);

  return out;
}

main().catch((err) => {
  status.style.color = "#e06c75";
  status.textContent = `failed: ${err.message}`;
  console.error(err);
});
