import { defineConfig } from "vite";
import { builtinModules } from "module";
import { copyFileSync, existsSync } from "fs";
import { resolve } from "path";

export default defineConfig(({ mode }) => {
  const production = mode === "production";

  return {
    build: {
      lib: {
        entry: resolve(__dirname, "src/main.ts"),
        formats: ["cjs"],
        fileName: () => "main.js",
      },
      outDir: "dist",
      sourcemap: production ? false : "inline",
      minify: production,
      target: "es2022",
      rollupOptions: {
        external: [
          "obsidian",
          "node-pty",
          ...builtinModules,
          ...builtinModules.map((m) => `node:${m}`),
        ],
        output: {
          codeSplitting: false,
        },
      },
    },
    plugins: [
      {
        name: "post-build",
        closeBundle() {
          copyFileSync(resolve(__dirname, "dist", "main.js"), resolve(__dirname, "main.js"));
          // ghostty-vt.wasm is fetched to the plugin root by scripts/fetch-wasm.mjs
          // (the `wasm` script, which `dev` and `build` run first), so there is
          // nothing to copy — just confirm the pinned artifact is in place.
          if (!existsSync(resolve(__dirname, "ghostty-vt.wasm"))) {
            throw new Error("ghostty-vt.wasm is missing — run `nub run wasm`");
          }
          console.log("  Copied main.js to plugin root (ghostty-vt.wasm already pinned)");
        },
      },
    ],
  };
});
