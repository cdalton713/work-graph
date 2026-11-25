import { randomBytes, randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { credentialCrypto } from "./crypto.ts";

test("encrypts each value separately and binds it to its row and field", () => {
  const key = randomBytes(32).toString("base64");
  const crypto = credentialCrypto({ WG_DATA_KEY: key });
  const tenant = randomUUID(), connection = randomUUID();
  const row = { tenant, connection, field: "credential" } as const;
  const secret = "example-access-value";
  const encrypted = crypto.encrypt(secret, row);
  expect(encrypted).not.toContain(secret);
  expect(crypto.encrypt(secret, row)).not.toBe(encrypted);
  expect(crypto.decrypt(encrypted, row)).toBe(secret);
  for (const moved of [
    { ...row, tenant: randomUUID() },
    { ...row, connection: randomUUID() },
    { ...row, field: "refresh_token" } as const,
  ]) {
    expect(() => crypto.decrypt(encrypted, moved)).toThrow(/^Cannot decrypt database credential$/);
  }
  const newKey = randomBytes(32).toString("base64");
  expect(() => credentialCrypto({ WG_DATA_KEY: newKey }).decrypt(encrypted, row))
    .toThrow(/^Cannot decrypt database credential$/);
  const rotated = credentialCrypto({ WG_DATA_KEY: newKey, WG_DATA_KEY_OLD: key });
  expect(rotated.decrypt(encrypted, row)).toBe(secret);
  expect(() => crypto.decrypt(rotated.encrypt(secret, row), row)).toThrow("Cannot decrypt");
});

test("requires a valid 32-byte data key for each configured key", () => {
  for (const env of [{}, { WG_DATA_KEY: "short" }, { WG_DATA_KEY: "!".repeat(44) }]) {
    expect(() => credentialCrypto(env)).toThrow(/^WG_DATA_KEY must contain a 32-byte base64 key$/);
  }
  expect(() => credentialCrypto({
    WG_DATA_KEY: randomBytes(32).toString("base64"), WG_DATA_KEY_OLD: "short",
  })).toThrow(/^WG_DATA_KEY_OLD must contain 32-byte base64 keys$/);
});
