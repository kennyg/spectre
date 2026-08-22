import { defineConfig } from "vite";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// Dev-only config for the browser harness (dev/index.html).
//
// Root is the repo root so the harness can fetch /ghostty-vt.wasm, which the
// build pins there. The plugin's own vite.config.ts is a CJS library build and
// cannot serve anything, hence a second config rather than a mode flag.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export default defineConfig({
  root,
  server: { port: 5199, open: "/dev/" },
});
