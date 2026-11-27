import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import { releaseVersion } from "./server/sentry.ts";
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

export default defineConfig(({ command }) => {
  const { SENTRY_AUTH_TOKEN, SENTRY_ORG, SENTRY_PROJECT_BROWSER } = process.env;
  const release = releaseVersion(process.env);
  // A build with no release name (`dev`) uploads nothing: its maps would match no deployed release.
  const upload = command === "build" && release !== "dev" && Boolean(SENTRY_AUTH_TOKEN && SENTRY_ORG && SENTRY_PROJECT_BROWSER);
  return {
    define: { "import.meta.env.WG_CONTRACT_HASH": JSON.stringify(contractHash) },
    build: { sourcemap: upload ? "hidden" : false },
    plugins: [
      react(),
      compressedAssets(),
      upload && sentryVitePlugin({
        authToken: SENTRY_AUTH_TOKEN,
        org: SENTRY_ORG,
        project: SENTRY_PROJECT_BROWSER,
        telemetry: false,
        release: { name: release, setCommits: false },
        sourcemaps: { assets: "dist/**/*.js", filesToDeleteAfterUpload: "dist/**/*.map" },
      }),
    ],
    // `pnpm dev` serves the page; the API still comes from `node server/main.ts`.
    server: { proxy: {
      "/api": { target: "http://127.0.0.1:4747", changeOrigin: false, headers: { origin: "http://127.0.0.1:4747", host: "127.0.0.1:4747" } },
      "/manifest.json": "http://127.0.0.1:4747",
    } },
  };
});
