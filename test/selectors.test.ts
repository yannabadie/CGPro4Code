import { describe, it, expect } from "vitest";
import { SELECTORS, joinSelectors } from "../src/browser/selectors.js";

describe("selectors", () => {
  it("provides at least one candidate for every key", () => {
    for (const [key, list] of Object.entries(SELECTORS)) {
      expect(list.length, `${key} has zero candidates`).toBeGreaterThan(0);
      for (const sel of list) {
        expect(typeof sel).toBe("string");
        expect(sel.length).toBeGreaterThan(0);
      }
    }
  });

  it("joins selectors into a comma-separated CSS list", () => {
    expect(joinSelectors(["a", "b", "c"])).toBe("a, b, c");
  });

  it("composer and sendButton are listed first in the most stable form", () => {
    expect(SELECTORS.composer[0]).toBe("#prompt-textarea");
    expect(SELECTORS.sendButton[0]).toContain('data-testid="send-button"');
  });
});
