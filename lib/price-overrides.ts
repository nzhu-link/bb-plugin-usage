export type OverridePrice = {
  input: number;
  output: number;
  cached?: number;
  cacheWrite?: number;
};

export type PriceOverrideEntry = OverridePrice | null;

export type PriceOverrides = Record<string, PriceOverrideEntry>;

let activeOverrides: PriceOverrides = {};

export function setActivePriceOverrides(overrides: PriceOverrides) {
  activeOverrides = overrides;
}

export function resetActivePriceOverrides() {
  activeOverrides = {};
}

export function activePriceOverrides() {
  return activeOverrides;
}

export function parsePriceOverrides(
  raw: string | null | undefined,
): { overrides: PriceOverrides; problems: string[] } {
  const problems: string[] = [];
  const overrides: PriceOverrides = {};
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { overrides, problems };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { overrides, problems: ["priceOverrides is not valid JSON"] };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      overrides,
      problems: ["priceOverrides must be a JSON object of model -> rates or null"],
    };
  }
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!key.includes("/")) {
      problems.push(`priceOverrides key "${key}" must look like provider/model`);
      continue;
    }
    if (value === null) {
      overrides[key.toLowerCase()] = null;
      continue;
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      problems.push(`priceOverrides["${key}"] must be a rates object or null`);
      continue;
    }
    const rates = value as Record<string, unknown>;
    const input = Number(rates.input);
    const output = Number(rates.output);
    if (!Number.isFinite(input) || input < 0 || !Number.isFinite(output) || output < 0) {
      problems.push(`priceOverrides["${key}"] needs non-negative input and output rates`);
      continue;
    }
    const cached = rates.cached === undefined ? input : Number(rates.cached);
    const cacheWrite = rates.cacheWrite === undefined ? input : Number(rates.cacheWrite);
    if (!Number.isFinite(cached) || cached < 0 || !Number.isFinite(cacheWrite) || cacheWrite < 0) {
      problems.push(`priceOverrides["${key}"] has negative or non-numeric cache rates`);
      continue;
    }
    overrides[key.toLowerCase()] = { input, output, cached, cacheWrite };
  }
  return { overrides, problems };
}

export type ResolvedPriceOverride = {
  key: string;
  price: OverridePrice | null;
};

export function lookupPriceOverride(
  overrides: PriceOverrides,
  providerId: string,
  model: string,
): ResolvedPriceOverride | undefined {
  const provider = providerId.trim().toLowerCase();
  const normalizedModel = model.trim().toLowerCase();
  // A provider-specific key names more than a wildcard does, so it wins when
  // both are present: `*/glm-5.3` can price the public model while
  // `opencode/glm-5.3` forces our private one to unknown.
  const keys = [`${provider}/${normalizedModel}`, `*/${normalizedModel}`];
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(overrides, key)) {
      return { key, price: overrides[key] ?? null };
    }
  }
  return undefined;
}
