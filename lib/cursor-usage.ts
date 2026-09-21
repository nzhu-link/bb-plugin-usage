import type { UsageRecord } from "../collectors";

// Contract: cursor-agent bundle 2026.09.18-9a7762b, Connect RPC
// `aiserver.v1.DashboardService/GetFilteredUsageEvents` (same service the
// Cursor dashboard website reads). Auth is the CLI's own login:
// `$XDG_CONFIG_HOME/cursor/auth.json` (or `~/.config/cursor/auth.json`)
// `accessToken`, sent as `Authorization: Bearer`. Read-only calls only.
//
// Why server-side instead of local files: cursor-agent never reports usage
// over ACP (zero `thread/tokenUsage/updated` events for acp-cursor threads),
// and the 274 local `store.db` chat stores carry messages but no token
// counts. The numbers live on api2.cursor.sh. MEASURED 2026-09-21: live
// `GetTeams` + `GetAggregatedUsageEvents` calls against this box's login
// returned HTTP 200 with per-model tokens and cents.

export const CURSOR_API_BASE_URL = "https://api2.cursor.sh";
const CURSOR_DASHBOARD_SERVICE = "aiserver.v1.DashboardService";
const CURSOR_HISTORY_DAYS = 7;
const CURSOR_PAGE_SIZE = 100;
const CURSOR_MAX_PAGES = 200;

export type CursorParseContext = { machineId: string; machineName: string };

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function count(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value)
    ? value
    : typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))
      ? Number(value)
      : 0;
  return Math.max(0, Math.round(n));
}

function money(value: unknown): number | null {
  const n = typeof value === "number" && Number.isFinite(value)
    ? value
    : typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))
      ? Number(value)
      : null;
  return n === null ? null : n / 100;
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function isoFromMs(value: unknown): string | null {
  const ms = typeof value === "number" && Number.isFinite(value)
    ? value
    : typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))
      ? Number(value)
      : null;
  if (ms === null) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function localDayOf(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime())
    ? iso.slice(0, 10)
    : `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}-${String(parsed.getDate()).padStart(2, "0")}`;
}

function slug(value: string): string {
  return encodeURIComponent(value).slice(0, 120);
}

// Deterministic key: the API exposes no per-event id, so the key is the full
// tuple. Two genuinely identical agent calls in the same millisecond would
// share a key; that collision is preferred over page-index keys, which shift
// on every resync as new events arrive.
function eventKey(teamId: string, timestampMs: string, model: string, conversation: string, parts: Array<string | number>): string {
  return ["cursor", slug(teamId), slug(timestampMs), slug(model), slug(conversation), ...parts.map((part) => slug(String(part)))].join(":");
}

export function parseCursorUsageEvents(payload: unknown, context: CursorParseContext): UsageRecord[] {
  const data = object(payload);
  if (!data || typeof data.teamId !== "string" || !data.teamId || !Array.isArray(data.events)) {
    throw new Error("Cursor usage response had an unexpected shape.");
  }
  const records: UsageRecord[] = [];
  data.events.forEach((entry, index) => {
    const event = object(entry);
    if (!event) throw new Error(`Cursor usage event at index ${index} had an unexpected shape.`);
    const timestamp = isoFromMs(event.timestamp);
    if (!timestamp) throw new Error(`Cursor usage event at index ${index} had an invalid timestamp.`);
    const model = text(event.model, "unknown");
    const tokenUsage = object(event.tokenUsage) ?? {};
    const uncached = count(tokenUsage.inputTokens);
    const cached = count(tokenUsage.cacheReadTokens);
    const writes = count(tokenUsage.cacheWriteTokens);
    const output = count(tokenUsage.outputTokens);
    // chargedCents is the authoritative vendor figure (token cost +
    // cursorTokenFee). requestsCosts is a request count, not dollars.
    const logged = money(event.chargedCents);
    const costUsd = logged !== null ? Number(Math.max(0, logged).toFixed(6)) : 0;
    const conversation = text(event.conversationId, "-");
    records.push({
      eventKey: eventKey(data.teamId as string, String(event.timestamp), model, conversation, [uncached, cached, writes, output, costUsd, index]),
      timestamp,
      day: localDayOf(timestamp),
      agentId: "cursor",
      agentName: "Cursor",
      modelProviderId: "cursor",
      modelProviderName: "Cursor",
      machineId: context.machineId,
      machineName: context.machineName,
      model,
      project: "Unknown",
      costUsd,
      loggedCostUsd: logged !== null ? costUsd : null,
      pricingStatus: logged !== null && logged > 0 ? "logged" : "unknown",
      cacheSavingsUsd: 0,
      processedTokens: uncached + cached + writes + output,
      cachedInputTokens: cached,
      cacheWriteTokens: writes,
      uncachedInputTokens: uncached,
      outputTokens: output,
    });
  });
  return records;
}

export function extractCursorJson(output: string): unknown {
  const json = output.match(/__BB_USAGE_BEGIN__\s*([\s\S]*?)\s*__BB_USAGE_END__:0/)?.[1];
  if (!json) {
    const diagnostic = output.match(/__BB_USAGE_ERROR__:([^\r\n]+)/)?.[1]?.trim();
    throw new Error(diagnostic ? diagnostic : "Cursor usage query returned incomplete output.");
  }
  try {
    return JSON.parse(json);
  } catch {
    throw new Error("Cursor usage query returned invalid JSON.");
  }
}

export function cursorUsageCommand(days = CURSOR_HISTORY_DAYS): string {
  const script = `
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
(async () => {
  const days = ${JSON.stringify(days)};
  const baseUrl = process.env.CURSOR_API_BASE_URL || '${CURSOR_API_BASE_URL}';
  const configDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const authPath = path.join(configDir, 'cursor', 'auth.json');
  let store;
  try { store = JSON.parse(fs.readFileSync(authPath, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') { console.log('__BB_USAGE_ERROR__:no-cursor-credential'); return; } throw new Error('Cursor auth file could not be read or was invalid JSON.'); }
  const token = store && typeof store.accessToken === 'string' ? store.accessToken : null;
  if (!token) { console.log('__BB_USAGE_ERROR__:no-cursor-credential'); return; }
  const call = async (service, method, body) => {
    let response;
    try { response = await fetch(baseUrl + '/' + service + '/' + method, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, 'Connect-Protocol-Version': '1' },
      body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15000),
    }); } catch { throw new Error('Cursor usage request failed.'); }
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'cursor-login-expired' : 'Cursor usage request returned HTTP ' + response.status + '.');
    let text = ''; const reader = response.body.getReader();
    while (true) { const part = await reader.read(); if (part.done) break; text += Buffer.from(part.value).toString('utf8'); if (text.length > 16777216) { await reader.cancel(); throw new Error('Cursor usage response was too large.'); } }
    try { return JSON.parse(text); } catch { throw new Error('Cursor usage response was not valid JSON.'); }
  };
  const teams = await call('${CURSOR_DASHBOARD_SERVICE}', 'GetTeams', {});
  const teamId = process.env.CURSOR_TEAM_ID || String((teams.teams && teams.teams[0] && teams.teams[0].id) || '');
  if (!teamId) throw new Error('Cursor account has no team.');
  const endMs = Date.now();
  const startMs = endMs - Math.max(1, days) * 24 * 3600 * 1000;
  const events = [];
  for (let page = 1; page <= ${CURSOR_MAX_PAGES}; page++) {
    const res = await call('${CURSOR_DASHBOARD_SERVICE}', 'GetFilteredUsageEvents', {
      teamId, startDate: String(startMs), endDate: String(endMs), page, pageSize: ${CURSOR_PAGE_SIZE},
    });
    const rows = res.usageEventsDisplay || [];
    events.push(...rows);
    if (rows.length < ${CURSOR_PAGE_SIZE}) break;
    if (typeof res.totalUsageEventsCount === 'number' && events.length >= res.totalUsageEventsCount) break;
  }
  console.log('__BB_USAGE_BEGIN__');
  console.log(JSON.stringify({ teamId, fetchedAt: new Date().toISOString(), events }));
  console.log('__BB_USAGE_END__:0');
})().catch(e => { console.log('__BB_USAGE_ERROR__:' + e.message); process.exitCode = 1; });`;
  return `set +x; if ! command -v node >/dev/null 2>&1; then printf '%s\\n' '__BB_USAGE_ERROR__:Node.js is required to collect Cursor usage.'; exit 127; fi; node -e '${script.replace(/'/g, `'\\''`)}'`;
}
