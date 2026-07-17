import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const distFile = (name: string) =>
  fileURLToPath(new URL(`../dist/${name}`, import.meta.url));

// Only meaningful against built output; `pnpm test` on a fresh clone has no dist yet.
const built = existsSync(distFile("index.js"));

describe.skipIf(!built)("use client banner", () => {
  it.each(["index.js", "index.cjs"])(
    "is the first directive in dist/%s, exactly once",
    (name) => {
      const out = readFileSync(distFile(name), "utf8");

      expect(out.split("\n")[0]).toBe('"use client";');
      expect(out.match(/["']use client["']/g)).toHaveLength(1);
    },
  );
});
