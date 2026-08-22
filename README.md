# Spectre

Embedded terminal view for Obsidian, powered by [libghostty-vt](https://github.com/ghostty-org/ghostty) — the
Ghostty project's own terminal engine, compiled to WebAssembly — with a canvas renderer on top. Unofficial: not
affiliated with the Ghostty project.

## Features

- Full color and TUI support (vim, htop, etc.)
- Terminal colors follow your active Obsidian theme
- Ribbon icon to open the terminal
- Multiple terminal tabs with "+" button or command palette
- Tab management commands (new, close, next, previous terminal)
- Toggle with Cmd/Ctrl+J

## Installation

Build from source. There is no one-click install, and that is a deliberate
consequence of what this plugin is — see [Why not BRAT?](#why-not-brat) below.

1. Clone this repo into your vault's plugin directory:
   ```bash
   cd /path/to/vault/.obsidian/plugins
   git clone https://github.com/kennyg/spectre.git spectre
   cd spectre
   ```
2. Install dependencies and build ([nub](https://nubjs.com/)):
   ```bash
   nub install
   nub run build
   ```
   The build downloads the pinned `ghostty-vt.wasm` from ghostty-org and verifies its checksum, so the first
   build needs network access.
3. Enable "Spectre" in Obsidian → Settings → Community Plugins

### Why not BRAT?

BRAT — and the Obsidian community plugin store — install exactly three files:
`main.js`, `manifest.json` and `styles.css`. Spectre needs two more at runtime:

- `ghostty-vt.wasm`, the terminal engine (~900 KB)
- `node-pty`'s native addon, which is what allocates the pseudo-terminal

Without a pseudo-terminal a shell reports `isatty() == false` and no window
size, so there is no prompt, no resize, and no `vim` or `htop`. The addon is
platform-specific compiled code, so it cannot be bundled into `main.js`.

Delivering a native binary through a plugin installer would mean writing an
executable into your vault at runtime and loading it with full process
privileges — in a directory that is often cloud-synced and writable by other
plugins. Building from source avoids that entirely: you get the binary from
npm with a lockfile integrity check, on your own machine.

Spectre also spawns your shell with your privileges. It is worth reading before
you run it, and building from source makes that the natural thing to do.

## Development

1. Install dependencies:
   ```bash
   nub install
   ```
2. Build the plugin:
   ```bash
   nub run dev
   ```
3. Link it into a vault. For a throwaway vault to test against:
   ```bash
   nub run vault          # creates dev/vault with this repo linked in
   nub run vault -- --open
   ```
   For your own vault, symlink the repo to `.obsidian/plugins/spectre/` and
   enable it in Obsidian. Either way, `Cmd/Ctrl+R` reloads after a rebuild.

## Verifying the engine

`ghostty-vt.wasm` is pinned by commit and SHA-256 in `ghostty-vt.pin.json` and
fetched from ghostty-org's commit-addressed CDN. `nub run wasm` checks the
checksum and the minisign signature — made by Ghostty's release key, recorded
in the pin — on every build, so a tampered or substituted artifact fails before
it is ever loaded.

To repin to a newer engine:

```bash
node scripts/fetch-wasm.mjs --update <ghostty-commit-sha>
nub run wasm:keys
nub run test
```

## Production build

```bash
nub run build
```

## Tests

```bash
nub run test
```

## Origin

Spectre began in February 2026 as a fork of
[ComputelessComputer/obsidian-ghostty](https://github.com/ComputelessComputer/obsidian-ghostty), which vendored
Ghostty's Zig source and compiled a native VT renderer. That approach was replaced wholesale: the vendored tree and
Zig toolchain were removed and the plugin was rebuilt on the `ghostty-web` WASM package. No implementation code
remains in common, so Spectre is maintained as an independent plugin rather than a fork. Credit to the original
project for the starting point.

In August 2026 the `ghostty-web` dependency was dropped too. The Ghostty project now publishes libghostty-vt as a
signed WebAssembly artifact from its own CI, so Spectre consumes that directly and supplies its own bindings and
renderer. The engine is pinned by commit and checksum in `ghostty-vt.pin.json`, which makes the build reproducible
and puts Spectre on the same VT engine as Ghostty itself rather than a third-party fork of it.

"Ghostty" is the [Ghostty terminal emulator](https://ghostty.org/) by Mitchell Hashimoto. Spectre uses the
libghostty-vt WebAssembly artifact published by that project, and is not affiliated with, endorsed by, or supported
by it.

## License

MIT
