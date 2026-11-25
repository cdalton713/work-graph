import { spawn } from "node:child_process";
import { once } from "node:events";
import { test, expect } from "vitest";

test("the local service starts on loopback, serves service config, and stops", async () => {
  const child = spawn(process.execPath, ["server/testing/service-dev.ts", "--port", "0"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  let started = false;
  let output = "";
  try {
    const url = await new Promise<string>((resolve, reject) => {
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        const match = /http:\/\/127\.0\.0\.1:\d+/.exec(output);
        if (match) resolve(match[0]);
      });
      child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
      child.once("error", reject);
      void exited.then(() => reject(new Error(output)));
    });
    started = true;
    const response = await fetch(url + "/api/config");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ auth: true, signIn: "linear", user: null });
    const signedIn = await fetch(url + "/auth/login", { redirect: "manual" });
    expect(signedIn.status).toBe(302);
    const cookie = signedIn.headers.get("set-cookie")!.split(";")[0];
    const account = await fetch(url + "/api/account", { headers: { cookie } });
    expect(await account.json()).toMatchObject({ human: "Ada", pageUrl: url, onboarding: { name: false } });
  } finally {
    child.kill("SIGTERM");
    const result = await exited;
    if (started) expect(result).toEqual([0, null]);
  }
}, 20_000);
