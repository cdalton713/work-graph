// Tailscale Serve for this server: https://<this machine>.<tailnet>.ts.net -> http://127.0.0.1:<port>,
// for the devices of the tailnet only. The server itself still listens on 127.0.0.1.
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
// The macOS app has the CLI in its bundle, not on PATH.
const CLIS = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];

/** The fields of `tailscale status --json` that this module reads. */
export interface Status {
  BackendState?: string;
  Self?: { DNSName?: string };
  CertDomains?: string[] | null;
}
/** The tailnet name of this machine. */
export interface Tailnet { host: string }

/**
 * The tailnet name of this machine, from `tailscale status --json`. Throws with the reason when
 * the tailnet cannot serve this page.
 */
export function identity(status: Status | null | undefined): Tailnet {
  if (status?.BackendState !== "Running") throw new Error(`Tailscale is ${status?.BackendState ?? "not there"}`);
  const self = status.Self ?? {};
  const host = (self.DNSName ?? "").replace(/\.$/, "").toLowerCase();
  if (!host) throw new Error("Tailscale gives no name for this machine");
  if (!status.CertDomains?.includes(host)) throw new Error("HTTPS certificates are off for this tailnet");
  return { host };
}

async function status(): Promise<{ cli: string; me: Tailnet }> {
  for (const cli of CLIS) {
    try {
      return { cli, me: identity(JSON.parse((await run(cli, ["status", "--json"])).stdout) as Status) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error("Tailscale is not installed");
}

/**
 * Turns Tailscale Serve on for `port` and gives the tailnet identity of this machine. Rejects with
 * the reason when Serve cannot start. Calls `onStop` when Serve stops later, for example when
 * Tailscale quits.
 *
 * Serve runs as a child in the foreground. Tailscale keeps a foreground configuration only while
 * that process lives, so the page leaves the tailnet when this server stops, with no cleanup step.
 */
export async function serve(port: number, onStop: () => void): Promise<Tailnet> {
  const { cli, me } = await status();
  const child = spawn(cli, ["serve", "--https=443", `http://127.0.0.1:${port}`], { stdio: ["ignore", "pipe", "pipe"] });
  const stop = () => child.kill();
  process.once("exit", stop);
  await new Promise<void>((resolve, reject) => {
    let said = "", up = false, late = false;
    const timer = setTimeout(() => {
      late = true;
      stop();
    }, 20_000);
    const hear = (chunk: Buffer) => {
      said += chunk;
      if (up || !said.includes(`https://${me.host}`)) return;
      up = true;
      clearTimeout(timer);
      resolve();
    };
    child.stdout.on("data", hear);
    child.stderr.on("data", hear);
    child.once("error", (error) => reject(error));
    child.once("exit", () => {
      clearTimeout(timer);
      process.off("exit", stop);
      if (up) onStop();
      else reject(new Error(late ? "Tailscale Serve did not start in 20 s" : said.trim().split("\n").pop() || "Tailscale Serve stopped"));
    });
  });
  return me;
}
