/** OpenCode Go usage endpoint. */
export const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
/** Hard cap on how long a usage check may take. */
export const USAGE_TIMEOUT_MS = 10_000;

export type UsageWindowStatus = "active" | "rate-limited" | "unknown";

/** One reported usage window (for example 5-hour or weekly). */
export interface UsageWindow {
	name?: string;
	status: UsageWindowStatus;
	usagePercent?: number;
	resetInSec?: number;
	used?: number;
	limit?: number;
	remaining?: number;
	resetAt?: string;
	startAt?: string;
	endAt?: string;
}

export interface UsageResponse {
	windows: UsageWindow[];
}

export interface UsageFetchResponse {
	ok: boolean;
	status: number;
	json(): Promise<unknown>;
}

export type UsageFetch = (
	url: string,
	init: { method: "GET"; headers: Record<string, string>; signal?: AbortSignal },
) => Promise<UsageFetchResponse>;

export interface UsageCheckResult {
	/** True when a usage reading was obtained and understood. */
	ok: boolean;
	/** True when at least one window is rate-limited. */
	blocked: boolean;
	/** Epoch ms the block should last until, when the response reported a reset. */
	blockUntil?: number;
	message: string;
	usage?: UsageResponse;
}

export interface UsageCheckOptions {
	key: string;
	/** Injected clock value so results are deterministic in tests. */
	now: number;
	fetch?: UsageFetch;
	timeoutMs?: number;
	/** Block duration used when a rate-limited window reports no reset timestamp. */
	fallbackMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, keys: string[]): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

function readNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "number" && Number.isFinite(value)) return value;
	}
	return undefined;
}

function parseWindow(value: unknown): UsageWindow | undefined {
	if (!isRecord(value)) return undefined;
	const status = value.status === "ok" || value.status === "active" ? "active" : value.status === "rate-limited" ? "rate-limited" : "unknown";
	const name = readString(value, ["name", "window", "period", "label"]);
	const usagePercent = readNumber(value, ["usagePercent", "usage_percent", "percent"]);
	const resetInSec = readNumber(value, ["resetInSec", "reset_in_sec", "resetSeconds", "reset_seconds"]);
	const used = readNumber(value, ["used", "usage", "usedTokens"]);
	const limit = readNumber(value, ["limit", "quota", "total"]);
	const remaining = readNumber(value, ["remaining", "remainingTokens"]);
	const resetAt = readString(value, ["resetAt", "reset_at", "resetsAt", "resets_at"]);
	const startAt = readString(value, ["startAt", "start_at", "startsAt", "starts_at"]);
	const endAt = readString(value, ["endAt", "end_at", "endsAt", "ends_at"]);
	return {
		status,
		...(name === undefined ? {} : { name }),
		...(usagePercent === undefined ? {} : { usagePercent }),
		...(resetInSec === undefined ? {} : { resetInSec }),
		...(used === undefined ? {} : { used }),
		...(limit === undefined ? {} : { limit }),
		...(remaining === undefined ? {} : { remaining }),
		...(resetAt === undefined ? {} : { resetAt }),
		...(startAt === undefined ? {} : { startAt }),
		...(endAt === undefined ? {} : { endAt }),
	};
}

/** Parse the usage endpoint payload, accepting either the `windows` or `usage` shape. */
export function parseUsage(value: unknown): UsageResponse | undefined {
	if (!isRecord(value)) return undefined;
	const windows: UsageWindow[] = [];
	if (Array.isArray(value.windows)) {
		for (const entry of value.windows) {
			const parsed = parseWindow(entry);
			if (!parsed) return undefined;
			windows.push(parsed);
		}
		return { windows };
	}
	if (!isRecord(value.usage)) return undefined;
	for (const [name, entry] of Object.entries(value.usage)) {
		const parsed = parseWindow(entry);
		if (!parsed) return undefined;
		windows.push(parsed.name === undefined ? { ...parsed, name } : parsed);
	}
	return { windows };
}

/**
 * Latest reset deadline among rate-limited windows, or undefined when none is
 * reported or rate-limited. Uses `fallbackMs` only when a rate-limited window
 * carries no parseable reset timestamp.
 */
export function quotaBlockUntil(usage: UsageResponse, now: number, fallbackMs = 0): number | undefined {
	let best: number | undefined;
	for (const window of usage.windows) {
		if (window.status !== "rate-limited") continue;
		const candidates: number[] = [];
		if (typeof window.resetInSec === "number" && Number.isFinite(window.resetInSec)) {
			candidates.push(now + window.resetInSec * 1000);
		}
		for (const timestamp of [window.resetAt, window.endAt]) {
			if (!timestamp) continue;
			const parsed = Date.parse(timestamp);
			if (Number.isFinite(parsed)) candidates.push(parsed);
		}
		const future = candidates.filter((candidate) => candidate > now);
		const until = future.length > 0 ? Math.max(...future) : now + fallbackMs;
		if (best === undefined || until > best) best = until;
	}
	return best !== undefined && best > now ? best : undefined;
}

const defaultFetch: UsageFetch = (url, init) => globalThis.fetch(url, init) as unknown as Promise<UsageFetchResponse>;

/** Probe the usage endpoint with a single key. Never throws. */
export async function checkUsageForKey(options: UsageCheckOptions): Promise<UsageCheckResult> {
	const fetchUsage = options.fetch ?? defaultFetch;
	const timeoutMs = options.timeoutMs ?? USAGE_TIMEOUT_MS;
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	try {
		const response = await fetchUsage(USAGE_URL, {
			method: "GET",
			headers: { Accept: "application/json", Authorization: `Bearer ${options.key}` },
			signal: controller.signal,
		});
		if (!response.ok) {
			return { ok: false, blocked: false, message: `Usage request failed with HTTP ${response.status}.` };
		}
		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			return { ok: false, blocked: false, message: "Usage response could not be parsed." };
		}
		const usage = parseUsage(payload);
		if (!usage) {
			return { ok: false, blocked: false, message: "Usage response did not match the expected OpenCode Go shape." };
		}
		const blocked = usage.windows.some((window) => window.status === "rate-limited");
		return {
			ok: true,
			blocked,
			blockUntil: quotaBlockUntil(usage, options.now, options.fallbackMs ?? 0),
			message: blocked ? "Usage reports a rate-limited window." : "Usage request succeeded.",
			usage,
		};
	} catch {
		if (timedOut) {
			return { ok: false, blocked: false, message: `Usage request timed out after ${Math.round(timeoutMs / 1000)}s.` };
		}
		return { ok: false, blocked: false, message: "Usage request failed." };
	} finally {
		clearTimeout(timer);
	}
}
