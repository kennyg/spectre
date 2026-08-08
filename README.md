# Spectre

Embedded terminal view for Obsidian, rendered with [ghostty-web](https://github.com/coder/ghostty-web) (WASM + canvas). Unofficial — not affiliated with the Ghostty project.

## Features

- Full color and TUI support (vim, htop, etc.)
- Terminal colors follow your active Obsidian theme
- Ribbon icon to open the terminal
- Multiple terminal tabs with "+" button or command palette
- Tab management commands (new, close, next, previous terminal)
- Toggle with Cmd/Ctrl+J

## Installation

### Using BRAT (recommended)

1. Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) community plugin
2. Open BRAT settings → **Add Beta Plugin**
3. Enter: `kennyg/obsidian-spectre`
4. Enable "Spectre" in Community Plugins

### Manual

1. Clone this repo into your vault's plugin directory:
   ```bash
   cd /path/to/vault/.obsidian/plugins
   git clone https://github.com/kennyg/obsidian-spectre.git spectre
   cd spectre
   ```
2. Install dependencies and build ([nub](https://nubjs.com/)):
   ```bash
   nub install
   nub run build
   ```
3. Enable "Spectre" in Obsidian → Settings → Community Plugins

## Development

1. Install dependencies:
   ```bash
   nub install
   ```
2. Build the plugin:
   ```bash
   nub run dev
   ```
3. Symlink the plugin folder into your vault at `.obsidian/plugins/spectre/` and enable it in Obsidian.

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

"Ghostty" is the [Ghostty terminal emulator](https://ghostty.org/) by Mitchell Hashimoto. Spectre uses the
`ghostty-web` package and is not affiliated with, endorsed by, or supported by that project.

## License

MIT
