import { findKey, type Config } from "./config-store.ts";

const MINUTE_MS = 60_000;

/** Rate-limit detection covering HTTP 429 and OpenCode Go quota wording. */
const RATE_LIMIT_PATTERN = /\b429\b|rate.?limit|too many requests|quota|usage limit|limit reached|exceeded/i;

/** Duck-typed view of the runtime credential store used to override a provider key. */
export interface RuntimeKeyStore {
	setRuntimeApiKey(providerId: string, apiKey: string): void | Promise<void>;
	removeRuntimeApiKey?(providerId: string): void | Promise<void>;
}

export type RotationReason = "rotated" | "no-keys" | "all-blocked" | "no-alternative";

export interface Selection {
	name: string | null;
	reason: RotationReason;
	/** Name whose cooldown was cleared to make it eligible. */
	clearedCooldown?: string;
	/** Earliest quota reset when every key is blocked. */
	earliestResetAt?: number;
}

export interface RotationOutcome {
	rotated: boolean;
	reason: RotationReason;
	from: string | null;
	to: string | null;
	clearedCooldown?: string;
	earliestResetAt?: number;
}

/** True when the message looks like a provider rate limit or quota exhaustion. */
export function isRateLimitError(message: string): boolean {
	return RATE_LIMIT_PATTERN.test(message);
}

/** Resolve the runtime credential store, preferring `authStorage` over `runtime`. */
export function resolveRuntimeKeyStore(registry: unknown): RuntimeKeyStore | undefined {
	if (typeof registry !== "object" || registry === null) {
		return undefined;
	}
	const candidate = registry as { authStorage?: unknown; runtime?: unknown };
	for (const store of [candidate.authStorage, candidate.runtime]) {
		if (typeof store === "object" && store !== null && typeof (store as RuntimeKeyStore).setRuntimeApiKey === "function") {
			return store as RuntimeKeyStore;
		}
	}
	return undefined;
}

/** Apply a key as a runtime override. Returns false when no runtime store is reachable. */
export async function applyRuntimeKey(registry: unknown, provider: string, key: string): Promise<boolean> {
	const store = resolveRuntimeKeyStore(registry);
	if (!store) {
		return false;
	}
	await store.setRuntimeApiKey(provider, key);
	return true;
}

/** Start a transient cooldown for a key. */
export function markCooldown(config: Config, name: string, now: number): void {
	config.cooldowns[name] = now;
}

/** Record a quota block with an explicit expiry. */
export function markQuotaBlocked(config: Config, name: string, until: number): void {
	config.quotaBlockedUntil[name] = until;
}

/** Clear both transient cooldown and quota block for a key. */
export function clearRestrictions(config: Config, name: string): void {
	delete config.cooldowns[name];
	delete config.quotaBlockedUntil[name];
}

/** True while a key is inside its transient cooldown window. */
export function isCooling(config: Config, name: string, now: number): boolean {
	const startedAt = config.cooldowns[name];
	if (typeof startedAt !== "number") return false;
	return now - startedAt < config.cooldownMinutes * MINUTE_MS;
}

/** True while a key is quota-blocked. */
export function isQuotaBlocked(config: Config, name: string, now: number): boolean {
	const until = config.quotaBlockedUntil[name];
	return typeof until === "number" && until > now;
}

/**
 * Pick the next key to activate.
 *
 * Quota-blocked keys are never selected. Non-cooling keys are preferred. When
 * every remaining alternative is cooling, the next one's cooldown is cleared
 * instead of staying on an exhausted key. When every key is quota-blocked the
 * selection stops and reports the earliest reset.
 */
export function selectNextKey(config: Config, currentName: string | null, now: number): Selection {
	const { keys } = config;
	if (keys.length === 0) {
		return { name: null, reason: "no-keys" };
	}

	const eligible = keys.filter((entry) => !isQuotaBlocked(config, entry.name, now));
	if (eligible.length === 0) {
		const resets = keys
			.map((entry) => config.quotaBlockedUntil[entry.name])
			.filter((value): value is number => typeof value === "number");
		return { name: null, reason: "all-blocked", earliestResetAt: resets.length > 0 ? Math.min(...resets) : undefined };
	}

	const currentIndex = currentName === null ? -1 : keys.findIndex((entry) => entry.name === currentName);
	const ordered: typeof keys = [];
	for (let offset = 1; offset <= keys.length; offset += 1) {
		const entry = keys[(currentIndex + offset + keys.length) % keys.length];
		if (entry) ordered.push(entry);
	}

	const alternatives = ordered.filter((entry) => entry.name !== currentName && !isQuotaBlocked(config, entry.name, now));
	if (alternatives.length === 0) {
		return { name: null, reason: "no-alternative" };
	}

	const next = alternatives.find((entry) => !isCooling(config, entry.name, now));
	if (next) {
		return { name: next.name, reason: "rotated" };
	}

	const fallback = alternatives[0];
	if (!fallback) {
		return { name: null, reason: "no-alternative" };
	}
	return { name: fallback.name, reason: "rotated", clearedCooldown: fallback.name };
}

/** Select and activate the next eligible key, applying it as a runtime override. */
export async function rotateAwayFromActive(
	config: Config,
	now: number,
	registry: unknown,
	provider: string,
): Promise<RotationOutcome> {
	const from = config.activeKey;
	const selection = selectNextKey(config, from, now);
	if (!selection.name) {
		return { rotated: false, reason: selection.reason, from, to: null, earliestResetAt: selection.earliestResetAt };
	}
	if (selection.clearedCooldown !== undefined) {
		delete config.cooldowns[selection.clearedCooldown];
	}
	config.activeKey = selection.name;
	const entry = findKey(config, selection.name);
	if (entry) {
		await applyRuntimeKey(registry, provider, entry.key);
	}
	return {
		rotated: true,
		reason: "rotated",
		from,
		to: selection.name,
		clearedCooldown: selection.clearedCooldown,
	};
}
