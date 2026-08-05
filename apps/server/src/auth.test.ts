import { describe, expect, it } from "vitest";
import { hashPassword, sessionCookie, verifyPassword } from "./auth.js";
import { sharedBaseUrl, sharedModel } from "./store.js";

describe("multi-user security primitives", () => {
  it("hashes passwords with a random salt and verifies without storing plaintext", async () => {
    const first = await hashPassword("correct horse battery staple");
    const second = await hashPassword("correct horse battery staple");
    expect(first).not.toBe(second);
    expect(first).not.toContain("correct horse");
    await expect(verifyPassword("correct horse battery staple", first)).resolves.toBe(true);
    await expect(verifyPassword("wrong password", first)).resolves.toBe(false);
  });

  it("uses an HttpOnly same-site session cookie", () => {
    const cookie = sessionCookie("opaque-token");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
  });

  it("locks the shared test provider to DeepSeek Flash", () => {
    expect(sharedBaseUrl).toBe("https://api.deepseek.com");
    expect(sharedModel).toBe("deepseek-v4-flash");
  });
});
