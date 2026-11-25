import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

type Binding = { tenant: string; connection: string; field: "credential" | "refresh_token" };

function dataKey(text: string, message: string): Buffer {
  const key = Buffer.from(text, "base64");
  if (key.length !== 32 || key.toString("base64").replace(/=+$/, "") !== text.replace(/=+$/, "")) {
    throw new Error(message);
  }
  return key;
}

export function credentialCrypto(env: NodeJS.ProcessEnv = process.env) {
  const current = dataKey(env.WG_DATA_KEY?.trim() ?? "", "WG_DATA_KEY must contain a 32-byte base64 key");
  const old = (env.WG_DATA_KEY_OLD?.trim() || "").split(/[,\s]+/).filter(Boolean)
    .map((text) => dataKey(text, "WG_DATA_KEY_OLD must contain 32-byte base64 keys"));
  const aad = ({ tenant, connection, field }: Binding) => Buffer.from(JSON.stringify([tenant, connection, field]));

  return {
    encrypt(value: string, binding: Binding): string {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", current, nonce).setAAD(aad(binding));
      const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString("base64");
    },
    decrypt(value: string, binding: Binding): string {
      const bytes = Buffer.from(value, "base64");
      for (const key of [current, ...old]) {
        try {
          const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12), { authTagLength: 16 });
          decipher.setAAD(aad(binding)).setAuthTag(bytes.subarray(12, 28));
          return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
        } catch {
          // Try the next key.
        }
      }
      throw new Error("Cannot decrypt database credential");
    },
  };
}

export type CredentialCrypto = ReturnType<typeof credentialCrypto>;

export function coordinatorToken(): string {
  return randomBytes(32).toString("base64url");
}

export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
