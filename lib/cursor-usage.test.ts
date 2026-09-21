import { describe, expect, it } from "vitest";
import { cursorUsageCommand, extractCursorJson, parseCursorUsageEvents } from "./cursor-usage";

// Fixture shape: live `GetFilteredUsageEvents.usageEventsDisplay` row,
// 2026-09-21 (user/team identifiers redacted, amounts intact).
const event = (overrides: Record<string, unknown> = {}) => ({
  timestamp: "1790022672560",
  model: "muse-spark-1.3-high",
  kind: "USAGE_EVENT_KIND_USAGE_BASED",
  requestsCosts: 4.4,
  usageBasedCosts: "$0.18",
  isTokenBasedCall: true,
  tokenUsage: { inputTokens: 85123, outputTokens: 2129, cacheReadTokens: 405685, totalCents: 17.630475 },
  owningUser: "<redacted>",
  owningTeam: "<redacted>",
  cursorTokenFee: 12.323425,
  isChargeable: true,
  serviceAccountId: "<redacted>",
  isHeadless: false,
  chargedCents: 29.9539,
  conversationId: "<redacted>",
  ...overrides,
});

const context = { machineId: "m1", machineName: "box" };

describe("parseCursorUsageEvents", () => {
  it("maps tokens and the authoritative charged figure", () => {
    const [record] = parseCursorUsageEvents({ teamId: "31409137", fetchedAt: "2026-09-21T20:30:00.000Z", events: [event()] }, context);
    expect(record.agentId).toBe("cursor");
    expect(record.model).toBe("muse-spark-1.3-high");
    expect(record.uncachedInputTokens).toBe(85123);
    expect(record.outputTokens).toBe(2129);
    expect(record.cachedInputTokens).toBe(405685);
    expect(record.cacheWriteTokens).toBe(0);
    expect(record.processedTokens).toBe(85123 + 2129 + 405685);
    // chargedCents 29.9539, not tokenUsage.totalCents and not requestsCosts.
    expect(record.loggedCostUsd).toBeCloseTo(0.299539, 6);
    expect(record.costUsd).toBeCloseTo(0.299539, 6);
    expect(record.pricingStatus).toBe("logged");
    expect(record.day).toBe("2026-09-21");
  });

  it("keys events deterministically without page indexes shifting history", () => {
    const payload = { teamId: "31409137", events: [event(), event()] };
    const [first, second] = parseCursorUsageEvents(payload, context);
    expect(first.eventKey).not.toBe(second.eventKey);
    expect(first.eventKey.startsWith("cursor:31409137:")).toBe(true);
    const again = parseCursorUsageEvents(payload, context);
    expect(again[0].eventKey).toBe(first.eventKey);
    expect(again[1].eventKey).toBe(second.eventKey);
  });

  it("records zero-token rows instead of dropping spend", () => {
    const [record] = parseCursorUsageEvents({ teamId: "t", events: [event({ tokenUsage: undefined, chargedCents: 5 })] }, context);
    expect(record.processedTokens).toBe(0);
    expect(record.costUsd).toBeCloseTo(0.05, 6);
  });

  it("refuses malformed payloads instead of recording guesses", () => {
    expect(() => parseCursorUsageEvents(null, context)).toThrow("unexpected shape");
    expect(() => parseCursorUsageEvents({ teamId: "t", events: [event({ timestamp: "nope" })] }, context)).toThrow("invalid timestamp");
  });
});

describe("extractCursorJson", () => {
  it("round-trips the collector envelope and surfaces error markers", () => {
    const payload = { teamId: "t", events: [] };
    const parsed = extractCursorJson(`noise\n__BB_USAGE_BEGIN__\n${JSON.stringify(payload)}\n__BB_USAGE_END__:0\n`);
    expect(parsed).toEqual(payload);
    expect(() => extractCursorJson("__BB_USAGE_ERROR__:no-cursor-credential\n")).toThrow("no-cursor-credential");
    expect(() => extractCursorJson("truncated")).toThrow("incomplete output");
  });
});

describe("cursorUsageCommand", () => {
  it("reads the CLI login and pages the dashboard service", () => {
    const command = cursorUsageCommand(7);
    expect(command).toContain("auth.json");
    expect(command).toContain("GetFilteredUsageEvents");
    expect(command).toContain("GetTeams");
    expect(command).toContain("CURSOR_API_BASE_URL");
  });
});
