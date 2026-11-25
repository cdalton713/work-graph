import { AsyncLocalStorage } from "node:async_hooks";
import { type Site, setSiteSource } from "../src/lib/site.ts";

export const requestSite = new AsyncLocalStorage<Site>();
setSiteSource(() => requestSite.getStore());
