import { describe, expect, it } from "@effect/vitest";

import { shouldPlayEntrance } from "./threadEntranceAnimation";

describe("thread entrance animation", () => {
  const openedAt = 100_000;

  it("animates a row created after the thread was opened", () => {
    const createdAt = new Date(openedAt + 500).toISOString();
    expect(shouldPlayEntrance(createdAt, openedAt, openedAt + 600)).toBe(true);
  });

  it("never animates historical rows hydrated on open, even recent ones", () => {
    // Created one second before open — recent by wall clock, but not new to us.
    const createdAt = new Date(openedAt - 1_000).toISOString();
    expect(shouldPlayEntrance(createdAt, openedAt, openedAt + 100)).toBe(false);
  });

  it("stops animating once a row ages past the freshness window", () => {
    const createdAt = new Date(openedAt + 500).toISOString();
    // Row remounts (scrolled back into view) long after it was created.
    expect(shouldPlayEntrance(createdAt, openedAt, openedAt + 10_000)).toBe(false);
  });

  it("does not animate rows with an unparseable timestamp", () => {
    expect(shouldPlayEntrance("not-a-date", openedAt, openedAt + 100)).toBe(false);
  });
});
