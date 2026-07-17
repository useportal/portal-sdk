import { describe, expect, it } from "vitest";

import { VERSION } from "./index.js";

describe("@portalsdk/core", () => {
  it("exports a VERSION string", () => {
    expect(VERSION).toBe("0.0.0");
  });
});
