import { describe, expect, it } from "vitest";

import { VERSION } from "./index.js";

describe("@portalsdk/react", () => {
  it("exports a VERSION string", () => {
    expect(VERSION).toBe("0.0.0");
  });
});
