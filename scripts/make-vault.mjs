#!/usr/bin/env node
// Create a throwaway Obsidian vault with this plugin linked in, so the real
// plugin can be exercised without touching a personal vault.
//
//   node scripts/make-vault.mjs              create/refresh dev/vault
//   node scripts/make-vault.mjs --path <dir> use a different location
//   node scripts/make-vault.mjs --open       also launch Obsidian on it
//
// The plugin directory is a symlink to the repo root, so a rebuild is picked
// up by Obsidian's "Reload app without saving" — no copying, no drift. That
// also puts the repo's node_modules on the path main.ts uses to resolve
// node-pty at runtime.

import { existsSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync, lstatSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const at = args.indexOf("--path");
const vault = resolve(at === -1 ? join(root, "dev", "vault") : args[at + 1]);

const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const pluginDir = join(vault, ".obsidian", "plugins", manifest.id);

mkdirSync(join(vault, ".obsidian", "plugins"), { recursive: true });

// Relink every run so the symlink can never point at a stale checkout.
if (existsSync(pluginDir) || isLink(pluginDir)) rmSync(pluginDir, { recursive: true, force: true });
symlinkSync(root, pluginDir, "dir");

function isLink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

// Enable the plugin and skip the first-run dialogs that would otherwise sit
// in front of the terminal.
writeFileSync(
  join(vault, ".obsidian", "community-plugins.json"),
  `${JSON.stringify([manifest.id], null, 2)}\n`,
);
writeFileSync(
  join(vault, ".obsidian", "app.json"),
  `${JSON.stringify({ promptDelete: false }, null, 2)}\n`,
);
writeFileSync(
  join(vault, ".obsidian", "core-plugins.json"),
  `${JSON.stringify(["file-explorer", "command-palette"], null, 2)}\n`,
);

writeFileSync(
  join(vault, "Start here.md"),
  [
    "# Spectre dev vault",
    "",
    "Throwaway vault for exercising the plugin. Recreate it any time with",
    "`nub run vault`; nothing in here is worth keeping.",
    "",
    "- Open a terminal with the ribbon icon, `Cmd/Ctrl+J`, or the command palette.",
    "- After `nub run build`, reload with **Cmd/Ctrl+R** to pick up the new `main.js`.",
    "",
    "## Things worth checking by hand",
    "",
    "These are the paths the headless tests and the browser harness cannot reach:",
    "",
    "- [ ] Terminal opens and the shell prompt renders",
    "- [ ] Theme switch (Appearance → dark/light) recolors the terminal live",
    "- [ ] `vim`, `htop`, `less` render and accept input",
    "- [ ] Mouse selection inside `vim` (it enables mouse tracking)",
    "- [ ] Paste with Cmd/Ctrl+V, including a multi-line paste",
    "- [ ] IME input, if you use one",
    "- [ ] Cursor blinks, and goes hollow when the pane loses focus",
    "- [ ] Split panes / multiple terminals, and the tab title following the shell",
    "- [ ] Box-drawing and shade characters: `printf '██▓▒░ ┌─┬─┐\\n'`",
    "",
  ].join("\n"),
);

process.stdout.write(`  vault ready at ${vault}\n`);
process.stdout.write(`  plugin linked from ${root}\n`);

if (args.includes("--open")) {
  const url = `obsidian://open?path=${encodeURIComponent(vault)}`;
  try {
    execFileSync(process.platform === "darwin" ? "open" : "xdg-open", [url]);
    process.stdout.write("  opening in Obsidian…\n");
  } catch {
    process.stdout.write(`  could not launch Obsidian; open this manually:\n  ${url}\n`);
  }
}
