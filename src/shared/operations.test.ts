import { describe, expect, it, vi } from "vitest";
import { normalizeAgentDebugFlag } from "./operations";

const mocks = vi.hoisted(() => ({
  exportVariable: vi.fn(),
}));

vi.mock("@actions/core", () => ({
  exportVariable: mocks.exportVariable,
}));

describe("normalizeAgentDebugFlag", () => {
  it.each([
    ["true", "true"],
    ["TRUE", "false"],
    ["", "false"],
  ])("normalizes %j to %s", (value, expected) => {
    normalizeAgentDebugFlag(value);

    expect(mocks.exportVariable).toHaveBeenCalledWith(
      "OCTESTRA_AGENT_DEBUG",
      expected,
    );
  });
});
