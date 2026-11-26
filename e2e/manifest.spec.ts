import { expect } from "@playwright/test";
import { serviceUrl } from "./support/ports.ts";
import { test } from "./support/screens.ts";

test("the signed-out page exposes an install manifest and decodable icons", async ({ page }) => {
  await page.goto(serviceUrl());
  const link = page.locator('link[rel="manifest"]');
  await expect(link).toHaveAttribute("href", "/manifest.json");

  const manifest = await page.evaluate(async () => {
    const response = await fetch("/manifest.json", { credentials: "omit" });
    if (!response.ok || response.headers.get("content-type") !== "application/manifest+json") {
      throw new Error(`Manifest response: ${response.status} ${response.headers.get("content-type")}`);
    }
    return response.json();
  });
  expect(manifest).toMatchObject({
    name: "work-graph", start_url: "/", scope: "/", display: "standalone",
    icons: expect.arrayContaining([
      expect.objectContaining({ sizes: "192x192", purpose: "any" }),
      expect.objectContaining({ sizes: "512x512", purpose: "any" }),
      expect.objectContaining({ sizes: "512x512", purpose: "maskable" }),
    ]),
  });
  for (const icon of manifest.icons) {
    const dimensions = await page.evaluate(async (src: string) => {
      const response = await fetch(src, { credentials: "omit" });
      if (!response.ok || response.headers.get("content-type") !== "image/png") {
        throw new Error(`Icon response: ${response.status} ${response.headers.get("content-type")}`);
      }
      const image = await createImageBitmap(await response.blob());
      return `${image.width}x${image.height}`;
    }, icon.src);
    expect(dimensions).toBe(icon.sizes);
  }
});
