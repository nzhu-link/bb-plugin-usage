import { describe, expect, it } from "vitest";
import { cursorUsageCommand, extractCursorJson, parseCursorUsageEvents } from "./cursor-usage";

// Aggregate shape: what the collector script emits after bucketing live
// `GetFilteredUsageEvents.usageEventsDisplay` rows by day+model. Amounts below
// mirror one real 2026-09-21 bucket (identifiers redacted).
const aggregate = (overrides: Record<string, unknown> = {}) => ({
  day: "2026-09-21",
  model: "muse-spark-1.3-high",
  uncachedInputTokens: 85123,
  cachedInputTokens: 405685,
  cacheWriteTokens: 0,
  outputTokens: 2129,
  chargedCents: 29.9539,
  eventCount: 1,
  ...overrides,
});

const context = { machineId: "m1", machineName: "box" };

describe("parseCursorUsageEvents", () => {
  it("maps tokens and the authoritative charged figure", () => {
    const [record] = parseCursorUsageEvents({ teamId: "87654321", fetchedAt: "2026-09-21T20:30:00.000Z", aggregates: [aggregate()] }, context);
    expect(record.agentId).toBe("cursor");
    expect(record.model).toBe("muse-spark-1.3-high");
    expect(record.uncachedInputTokens).toBe(85123);
    expect(record.outputTokens).toBe(2129);
    expect(record.cachedInputTokens).toBe(405685);
    expect(record.cacheWriteTokens).toBe(0);
    expect(record.processedTokens).toBe(85123 + 2129 + 405685);
    // chargedCents 29.9539, not requestsCosts (a request count, not dollars).
    expect(record.loggedCostUsd).toBeCloseTo(0.299539, 6);
    expect(record.costUsd).toBeCloseTo(0.299539, 6);
    expect(record.pricingStatus).toBe("logged");
    expect(record.day).toBe("2026-09-21");
  });

  it("keys aggregates deterministically per team/day/model", () => {
    const payload = { teamId: "87654321", aggregates: [aggregate(), aggregate({ model: "other" })] };
    const [first, second] = parseCursorUsageEvents(payload, context);
    expect(first.eventKey).toBe("cursor:87654321:2026-09-21:muse-spark-1.3-high");
    expect(second.eventKey).not.toBe(first.eventKey);
    const again = parseCursorUsageEvents(payload, context);
    expect(again[0].eventKey).toBe(first.eventKey);
  });

  it("refuses malformed payloads instead of recording guesses", () => {
    expect(() => parseCursorUsageEvents(null, context)).toThrow("unexpected shape");
    expect(() => parseCursorUsageEvents({ teamId: "t", aggregates: [aggregate({ day: "nope" })] }, context)).toThrow("invalid day");
  });
});

describe("extractCursorJson", () => {  it("round-trips the collector envelope and surfaces error markers", () => {
    const payload = { teamId: "t", aggregates: [] };
    const parsed = extractCursorJson(`noise\n__BB_USAGE_BEGIN__\n${JSON.stringify(payload)}\n__BB_USAGE_END__:0\n`);
    expect(parsed).toEqual(payload);
    expect(() => extractCursorJson("__BB_USAGE_ERROR__:no-cursor-credential\n")).toThrow("no-cursor-credential");
    expect(() => extractCursorJson("truncated")).toThrow("incomplete output");
  });
});

describe("cursorUsageCommand", () => {
  it("reads the CLI login and pages the dashboard service", () => {
    const command = cursorUsageCommand(30);
    expect(command).toContain("auth.json");
    expect(command).toContain("GetFilteredUsageEvents");
    expect(command).toContain("GetTeams");
    expect(command).toContain("CURSOR_API_BASE_URL");
  });
});

describe("parseCursorConversations", () => {
  it("maps per-conversation spend", async () => {
    const { parseCursorConversations } = await import("./cursor-usage");
    const [row] = parseCursorConversations({ teamId: "87654321", conversations: [{
      day: "2026-09-21", conversationId: "30c572dc-96b3-4056-bfd8-bfd9425c4f23",
      model: "muse-spark-1.3-high", uncachedInputTokens: 2405, cachedInputTokens: 804563,
      cacheWriteTokens: 0, outputTokens: 875, chargedCents: 32.937, eventCount: 3,
    }] });
    expect(row.conversationId).toBe("30c572dc-96b3-4056-bfd8-bfd9425c4f23");
    expect(row.costUsd).toBeCloseTo(0.32937, 6);
    expect(row.eventCount).toBe(3);
  });
});
