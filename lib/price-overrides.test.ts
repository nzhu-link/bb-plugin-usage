import { describe, expect, it } from "vitest";
import { lookupPriceOverride, parsePriceOverrides } from "./price-overrides";

describe("parsePriceOverrides", () => {
  it("reads per-1M rates and defaults the cache rates to the input rate", () => {
    const { overrides, problems } = parsePriceOverrides('{"amazon-bedrock/us.openai.gpt-6-astra":{"input":11,"output":55}}');
    expect(problems).toEqual([]);
    expect(overrides["amazon-bedrock/us.openai.gpt-6-astra"]).toEqual({ input: 11, output: 55, cached: 11, cacheWrite: 11 });
  });

  it("keeps explicit cache rates and lowercases the keys", () => {
    const { overrides } = parsePriceOverrides('{"OpenCode/GLM-5.3":{"input":3,"output":6,"cached":0.3,"cacheWrite":3.5}}');
    expect(overrides["opencode/glm-5.3"]).toEqual({ input: 3, output: 6, cached: 0.3, cacheWrite: 3.5 });
  });

  // A null entry is not an absent entry: it is the operator saying "this model's
  // real price is not knowable here", which must beat a catalog name match.
  it("keeps a null entry as a present key", () => {
    const { overrides, problems } = parsePriceOverrides('{"opencode/glm-5.3":null}');
    expect(problems).toEqual([]);
    expect(Object.prototype.hasOwnProperty.call(overrides, "opencode/glm-5.3")).toBe(true);
    expect(overrides["opencode/glm-5.3"]).toBeNull();
  });

  it("treats blank settings as no overrides", () => {
    expect(parsePriceOverrides("")).toEqual({ overrides: {}, problems: [] });
    expect(parsePriceOverrides("   ")).toEqual({ overrides: {}, problems: [] });
    expect(parsePriceOverrides(null)).toEqual({ overrides: {}, problems: [] });
    expect(parsePriceOverrides(undefined)).toEqual({ overrides: {}, problems: [] });
  });

  it("reports a malformed setting instead of pricing from it", () => {
    expect(parsePriceOverrides("{")).toEqual({ overrides: {}, problems: ["priceOverrides is not valid JSON"] });
    expect(parsePriceOverrides("[]").problems).toHaveLength(1);
    expect(parsePriceOverrides("null").problems).toHaveLength(1);
    expect(parsePriceOverrides('"glm-5.3"').problems).toHaveLength(1);
  });

  it("skips each bad entry, keeps the good ones, and says what was wrong", () => {
    const { overrides, problems } = parsePriceOverrides(JSON.stringify({
      "glm-5.3": { input: 1, output: 2 },
      "opencode/free": "free",
      "opencode/negative": { input: -1, output: 2 },
      "opencode/no-input": { output: 2 },
      "opencode/bad-cache": { input: 1, output: 2, cached: "cheap" },
      "openai/kept": { input: 1, output: 2 },
    }));
    expect(Object.keys(overrides)).toEqual(["openai/kept"]);
    expect(problems).toHaveLength(5);
    expect(problems[0]).toContain('"glm-5.3" must look like provider/model');
    expect(problems[2]).toContain("non-negative input and output rates");
    expect(problems[4]).toContain("negative or non-numeric cache rates");
  });
});

describe("lookupPriceOverride", () => {
  const { overrides } = parsePriceOverrides(JSON.stringify({
    "*/us.openai.gpt-6-astra": { input: 11, output: 55 },
    "*/glm-5.3": { input: 3, output: 6 },
    "opencode/glm-5.3": null,
  }));

  it("matches any provider through a wildcard key", () => {
    expect(lookupPriceOverride(overrides, "codex", "us.openai.gpt-6-astra")).toMatchObject({
      key: "*/us.openai.gpt-6-astra",
      price: { input: 11, output: 55 },
    });
  });

  it("prefers the provider-specific key over the wildcard", () => {
    expect(lookupPriceOverride(overrides, "opencode", "glm-5.3")).toEqual({ key: "opencode/glm-5.3", price: null });
    expect(lookupPriceOverride(overrides, "anthropic", "glm-5.3")).toMatchObject({ key: "*/glm-5.3" });
  });

  it("ignores case and stray whitespace in the row's ids", () => {
    expect(lookupPriceOverride(overrides, " OpenCode ", " GLM-5.3 ")).toEqual({ key: "opencode/glm-5.3", price: null });
  });

  it("returns undefined when no key matches", () => {
    expect(lookupPriceOverride(overrides, "anthropic", "claude-fable-5")).toBeUndefined();
    expect(lookupPriceOverride({}, "opencode", "glm-5.3")).toBeUndefined();
  });
});
