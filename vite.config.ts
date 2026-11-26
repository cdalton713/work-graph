import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const contractText = readFileSync(new URL("./skills/work-graph/contract.json", import.meta.url));
const contractHash = createHash("sha256").update(contractText).digest("hex").slice(0, 12);

function compressedAssets(): Plugin {
  return {
    name: "compressed-assets",
    apply: "build",
    // Vite finishes the dynamic import preload references before writing the bundle.
    async writeBundle({ dir }, bundle) {
      if (!dir) return;
      await Promise.all(Object.keys(bundle).filter((name) => /\.(js|css)$/.test(name)).map(async (name) => {
        const file = join(dir, name);
        await writeFile(`${file}.gz`, gzipSync(await readFile(file)));
      }));
    },
  };
}

export default defineConfig({
  define: { "import.meta.env.WG_CONTRACT_HASH": JSON.stringify(contractHash) },
  plugins: [react(), compressedAssets()],
  // `pnpm dev` serves the page; the API still comes from `node server/main.ts`.
  server: { proxy: {
    "/api": { target: "http://127.0.0.1:4747", changeOrigin: false, headers: { origin: "http://127.0.0.1:4747", host: "127.0.0.1:4747" } },
    "/manifest.json": "http://127.0.0.1:4747",
  } },
});
