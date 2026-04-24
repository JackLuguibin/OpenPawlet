import { describe, expect, it } from "vitest";
import {
  extractNanobotStatusContext,
  outboundDataHasStatusContext,
} from "./nanobotStatusContext";

describe("nanobotStatusContext", () => {
  it("returns null when no context is present", () => {
    expect(extractNanobotStatusContext({})).toBeNull();
    expect(outboundDataHasStatusContext({})).toBe(false);
  });

  it("detects the direct `context` shape", () => {
    const ctx = { tokens_estimate: 10, window_total: 100, percent_used: 10 };
    expect(extractNanobotStatusContext({ context: ctx })).toEqual(ctx);
    expect(outboundDataHasStatusContext({ context: ctx })).toBe(true);
  });

  it("detects the wrapped `data.context` shape", () => {
    const ctx = { tokens_estimate: 8, window_total: 65, percent_used: 12 };
    const payload = { data: { context: ctx } };
    expect(extractNanobotStatusContext(payload)).toEqual(ctx);
    expect(outboundDataHasStatusContext(payload)).toBe(true);
  });

  it("ignores arrays in `data`", () => {
    expect(extractNanobotStatusContext({ data: [1, 2, 3] })).toBeNull();
    expect(outboundDataHasStatusContext({ data: [1, 2, 3] })).toBe(false);
  });

  it("ignores primitive `context` values", () => {
    // The detector is strict: only objects count as a status context.
    expect(extractNanobotStatusContext({ context: "nope" })).toBeNull();
    expect(outboundDataHasStatusContext({ context: 123 })).toBe(false);
  });
});
