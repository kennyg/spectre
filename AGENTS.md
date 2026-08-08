# AGENTS.md

This file provides guidance when working with code in this repository.

## Common commands
Toolchain is [nub](https://nubjs.com/) (declared in `package.json#devEngines`); the lockfile is a standard
`pnpm-lock.yaml`. There is no separate runtime — nub transpiles TS in memory and runs it on stock `node`, which is
what Obsidian's Electron ships.
- Install deps: `nub install`
- Dev build: `nub run dev` (outputs `main.js` with sourcemaps + copies `ghostty-vt.wasm`)
- Production build: `nub run build` (minified `main.js` + copies `ghostty-vt.wasm`)
- Test: `nub run test` — Node's built-in `node:test`, no test-runner dependency. Must run through `nub`, not plain
  `node`: the tests use extensionless imports (`./lib`), which only nub's augmented resolution handles.
- `nub install` runs the root `postinstall` (see the node-pty note below). Note `--ignore-scripts` is not a clean
  control: nub caches post-script state under `~/.cache/nub/pm/side-effects-v1` and replays it.
- On a fresh clone, build before you test: `ghostty-vt.wasm` is gitignored and the `loadGhostty` test loads it from
  the plugin root, so it only exists once a build has copied it there.

## Architecture overview
- **Obsidian plugin entrypoint**: `main.ts` registers the view and command, resolves the plugin directory, spawns a PTY via node-pty, and renders the terminal using ghostty-web's WASM-powered canvas renderer. Build output is `main.js` (bundled by Vite).
- **Terminal rendering**: Uses `ghostty-web` npm package (Ghostty's VT100 parser compiled to WASM + canvas rendering). Provides full color, cursor styles, ligatures, and GPU-accelerated rendering via an xterm.js-compatible API.
- **WASM file**: `ghostty-vt.wasm` (~413KB) is copied from `node_modules/ghostty-web/` during build. Loaded at runtime via `Ghostty.load(wasmPath)`.
- **FitAddon**: Auto-resizes the terminal canvas to fit the container element using ResizeObserver.
- **PTY backend**: `node-pty` spawns the user's shell. Kept as external in Vite since it's a native Node addon. It is a
  **Node-API** addon, so the shipped prebuild is ABI-stable across Node/Electron versions — there is no need to rebuild
  it against Obsidian's Electron headers. `node-pty@1.1.0`'s npm tarball ships `darwin-*/spawn-helper` without the
  execute bit (upstream microsoft/node-pty#919, still open), which makes every `pty.spawn()` fail with
  `posix_spawnp failed`; the `postinstall` script in `package.json` chmods it back.
- **Build**: `vite.config.ts` bundles ghostty-web's JS into `dist/main.js`, then copies it along with the WASM file to the plugin root as a post-build step. Minification uses Vite 8's built-in (rolldown/oxc) minifier — do not set `minify: "esbuild"`, nothing in the tree provides esbuild.

## Maintaining this file
Keep this file short and high-signal. Record only project knowledge useful to almost every future session; prefer a
pointer to the authoritative file, command, or doc over copying detail that the codebase already shows. Update it in
the same change that invalidates it, and delete anything that has gone stale.
