# AGENTS.md

This file provides guidance when working with code in this repository.

## Naming

The plugin is **Spectre** (manifest id `spectre`, repo `kennyg/spectre`). Renamed from
`ghostty-terminal` in August 2026: that id collided with a different published community plugin, and the project
shares no implementation with the upstream it originally forked from — see the README's Origin section.

Do not "tidy up" the remaining `ghostty` identifiers. They name the real dependency and must stay: the
`ghostty-vt.wasm` artifact, its `ghostty-vt.pin.json` pin, the `src/vt/` bindings, and the `loadGhostty` helper.
Only the plugin's own identity — manifest id and name, view type `spectre-terminal-view`, `.spectre-terminal-*`
CSS classes, icon id `spectre-logo` — carries the Spectre name.

## Common commands
Toolchain is [nub](https://nubjs.com/) (declared in `package.json#devEngines`); the lockfile is a standard
`pnpm-lock.yaml`. There is no separate runtime — nub transpiles TS in memory and runs it on stock `node`, which is
what Obsidian's Electron ships.
- Install deps: `nub install`
- Dev build: `nub run dev` (inline sourcemaps)
- Production build: `nub run build` (minified `main.js`)
- Test: `nub run test` — Node's built-in `node:test`, no test-runner dependency. Must run through `nub`, not plain
  `node`: the tests use extensionless imports (`./lib`, `./wasm`), which only nub's augmented resolution handles.
- Fetch/verify the WASM: `nub run wasm`. `dev`, `build` and `test` all run it first, so there is no build-before-test
  ordering to remember — but the **first** run of any of them needs network.
- `nub install` runs the root `postinstall` (see the node-pty note below). Note `--ignore-scripts` is not a clean
  control: nub caches post-script state under `~/.cache/nub/pm/side-effects-v1` and replays it.

## Architecture overview
Layered, and the layering is the point: everything terminal-semantic lives in libghostty, and each layer up adds
only what the one below cannot do.

- **`src/vt/`** — bindings to libghostty-vt. `wasm.ts` loads the module, reads every C struct layout from
  `ghostty_type_json()` at startup (so field moves are absorbed, not hardcoded), and hand-assembles a trampoline
  module to install JS callbacks in the wasm function table. `terminal.ts` wraps it: write, resize, scroll,
  snapshot, theme, selection, paste, key/mouse encoding. **DOM-free, and therefore the only layer under test** —
  33 headless tests in `src/vt/terminal.test.ts`.
- **`src/renderer.ts`** — canvas renderer. Consumes a `FrameSnapshot` and paints it. Owns no terminal state.
- **`src/terminal.ts`** — DOM facade: event listeners, the requestAnimationFrame loop, fit/resize.
- **`dev/`** — two dev fixtures, neither part of the plugin build. `nub run harness` serves a browser harness at
  <http://localhost:5199/dev/> (a Terminal against a fake echo shell, plus an in-page self-test) for the renderer
  and DOM facade, which need a canvas and real events. `nub run vault` builds a throwaway Obsidian vault at
  `dev/vault/` with the repo symlinked in as the plugin, for everything only a real Obsidian can exercise;
  `Start here.md` lists what to check by hand.
- **`src/main.ts`** — Obsidian plugin entrypoint: registers the view and commands, resolves the plugin directory,
  spawns the PTY, wires it to the terminal. Build output is `main.js` (bundled by Vite).
- **`src/vt/keys.ts` is generated** from libghostty's header at the pinned commit. Do not hand-edit;
  regenerate with `nub run wasm:keys` whenever the pin moves.

- **WASM artifact**: `ghostty-vt.wasm` (~900KB) is the official build published by ghostty-org, **not** a
  repackaged npm dependency. `scripts/fetch-wasm.mjs` downloads it from a commit-addressed URL and verifies size,
  sha256 and expected exports against `ghostty-vt.pin.json`. The artifact is gitignored; the pin is the committed
  input. Repin with `node scripts/fetch-wasm.mjs --update <ghostty-commit-sha>`, then `nub run wasm:keys` and
  `nub run test`.
- **PTY backend**: `node-pty` spawns the user's shell. Kept as external in Vite since it's a native Node addon. It is a
  **Node-API** addon, so the shipped prebuild is ABI-stable across Node/Electron versions — there is no need to rebuild
  it against Obsidian's Electron headers. `node-pty@1.1.0`'s npm tarball ships `darwin-*/spawn-helper` without the
  execute bit (upstream microsoft/node-pty#919, still open), which makes every `pty.spawn()` fail with
  `posix_spawnp failed`; the `postinstall` script in `package.json` chmods it back.
- **Build**: `vite.config.ts` bundles to `dist/main.js` and copies it to the plugin root. Minification uses Vite 8's
  built-in (rolldown/oxc) minifier — do not set `minify: "esbuild"`, nothing in the tree provides esbuild.

## Before changing `src/vt/`
Read `.context/HANDOFF.md` (gitignored). It records the libghostty-vt ABI quirks that cost real time to establish
against the artifact and are not recoverable from the C headers — callback trampolines, indirect struct passing,
handle-vs-slot indirection, enum values that read backwards — plus the upstream-update history.

## Maintaining this file
Keep this file short and high-signal. Record only project knowledge useful to almost every future session; prefer a
pointer to the authoritative file, command, or doc over copying detail that the codebase already shows. Update it in
the same change that invalidates it, and delete anything that has gone stale.
