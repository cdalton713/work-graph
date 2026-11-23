import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const contractText = readFileSync(new URL("./skills/work-graph/contract.json", import.meta.url));
const contractHash = createHash("sha256").update(contractText).digest("hex").slice(0, 12);

export default defineConfig({
  define: { "import.meta.env.WG_CONTRACT_HASH": JSON.stringify(contractHash) },
  plugins: [react()],
  // `pnpm dev` serves the page; the API still comes from `node server/main.ts`.
  server: { proxy: { "/api": { target: "http://127.0.0.1:4747", changeOrigin: false, headers: { origin: "http://127.0.0.1:4747", host: "127.0.0.1:4747" } } } },
});
