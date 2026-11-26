import { readFileSync } from "node:fs";

const template = JSON.parse(readFileSync(new URL("./manifest.template.json", import.meta.url), "utf8"));

export function manifestResponse(appName?: string): Response {
  const manifest = appName ? { ...template, name: appName, short_name: appName } : template;
  return new Response(JSON.stringify(manifest), {
    headers: { "Content-Type": "application/manifest+json" },
  });
}
