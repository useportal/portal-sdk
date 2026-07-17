import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  isKnownChannelFrame,
  isKnownInboxFrame,
  parseChannelFrame,
  parseInboxFrame,
  type MemberRow,
  type ParsedChannelFrame,
  type ParsedInboxFrame,
} from "./index.js";

/**
 * Conformance against real frames captured from the platform's own gate harness.
 *
 * This is the test that stops the types being fiction: the fixture is ground truth for
 * what the wire actually carries, and it is never edited to fit. A frame that fails to
 * parse here is a finding to raise, not a type to loosen.
 */

type Fixtures = {
  channel_ready: unknown;
  channel_frames_alice: unknown[];
  inbox_ready: unknown;
  inbox_frames_alice: unknown[];
  roster: unknown[];
};

const fixtures = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../fixtures/m3-frames.json", import.meta.url)),
    "utf8",
  ),
) as Fixtures;

const channelFrames: unknown[] = [fixtures.channel_ready, ...fixtures.channel_frames_alice];
const inboxFrames: unknown[] = [fixtures.inbox_ready, ...fixtures.inbox_frames_alice];

const label = (frame: unknown, i: number): string => {
  const t = (frame as { t?: unknown })?.t;
  const mode = (frame as { mode?: unknown })?.mode;
  return `[${i}] ${String(t)}${typeof mode === "string" ? `:${mode}` : ""}`;
};

describe("channel frames", () => {
  it.each(channelFrames.map((f, i) => [label(f, i), f] as const))(
    "%s parses into a known channel frame",
    (_name, frame) => {
      const parsed = parseChannelFrame(JSON.stringify(frame));

      expect(parsed).not.toBeNull();
      // Known — not an UnknownFrame passthrough. Every fixture frame is v1 surface.
      expect(isKnownChannelFrame(parsed as ParsedChannelFrame)).toBe(true);
    },
  );

  it("parses every channel frame without losing a byte", () => {
    for (const frame of channelFrames) {
      expect(parseChannelFrame(JSON.stringify(frame))).toStrictEqual(frame);
    }
  });
});

describe("inbox frames", () => {
  it.each(inboxFrames.map((f, i) => [label(f, i), f] as const))(
    "%s parses into a known inbox frame",
    (_name, frame) => {
      const parsed = parseInboxFrame(JSON.stringify(frame));

      expect(parsed).not.toBeNull();
      expect(isKnownInboxFrame(parsed as ParsedInboxFrame)).toBe(true);
    },
  );

  it("parses every inbox frame without losing a byte", () => {
    for (const frame of inboxFrames) {
      expect(parseInboxFrame(JSON.stringify(frame))).toStrictEqual(frame);
    }
  });
});

describe("roster", () => {
  // `roster` is the one fixture entry that is NOT a frame: it is a §3.3 members
  // response body, so it is checked against MemberRow rather than pushed through a
  // frame parser. Asserted explicitly so it can never be silently skipped.
  it("is a §3.3 member directory, not a frame", () => {
    expect(parseChannelFrame(JSON.stringify(fixtures.roster))).toBeNull();

    for (const row of fixtures.roster as MemberRow[]) {
      expect(typeof row.userId).toBe("string");
      expect(typeof row.online).toBe("boolean");
      expect(typeof row.claims).toBe("object");
    }
  });
});

describe("parsed shapes", () => {
  it("pins every parsed channel frame", () => {
    expect(channelFrames.map((f) => parseChannelFrame(JSON.stringify(f)))).toMatchSnapshot();
  });

  it("pins every parsed inbox frame", () => {
    expect(inboxFrames.map((f) => parseInboxFrame(JSON.stringify(f)))).toMatchSnapshot();
  });
});
