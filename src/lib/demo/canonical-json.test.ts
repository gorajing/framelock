import { describe, expect, it } from "vitest";

import { canonicalJsonSha256 } from "./canonical-json";

describe("Python-compatible canonical JSON hashing", () => {
  it("sorts object keys and ASCII-escapes unicode", () => {
    expect(
      canonicalJsonSha256({ z: [3, true, null], a: "FrameLock — \\n" }),
    ).toBe("2640d2d66c7d59d9f98f1b1b797018bef1b9a757e818a924329410b0974d8fe9");
  });
});
