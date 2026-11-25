import { AsyncLocalStorage } from "node:async_hooks";
import { type Site, setSiteSource } from "../src/lib/site.ts";

export const requestSite = new AsyncLocalStorage<Site>();
setSiteSource(() => requestSite.getStore());

export function serverSite(): Site {
  const site = requestSite.getStore();
  if (!site) throw new Error("server operation needs a site");
  return site;
}
