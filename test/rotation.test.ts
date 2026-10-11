import { test } from "node:test";
import assert from "node:assert/strict";
import { addKey, createEmptyConfig, type Config } from "../src/config-store.ts";
import {
	applyRuntimeKey,
	clearRestrictions,
	isCooling,
	isQuotaBlocked,
	isRateLimitError,
	markCooldown,
	markQuotaBlocked,
	resolveRuntimeKeyStore,
	rotateAwayFromActive,
	selectNextKey,
} from "../src/rotation.ts";

const NOW = 1_000_000;
const MINUTE = 60_000;

function configWith(...names: string[]): Config {
	const config = createEmptyConfig();
	for (const name of names) {
		addKey(config, name, `sk-${name}`);
	}
	return config;
}

function fakeRegistry() {
	const applied: Array<{ provider: string; key: string }> = [];
	const removed: string[] = [];
	return {
		applied,
		removed,
		registry: {
			authStorage: {
				setRuntimeApiKey(provider: string, key: string) {
					applied.push({ provider, key });
				},
				removeRuntimeApiKey(provider: string) {
					removed.push(provider);
				},
			},
		},
	};
}

test("isRateLimitError recognises rate-limit and quota messages", () => {
	assert.equal(isRateLimitError("HTTP 429: Too Many Requests"), true);
	assert.equal(isRateLimitError("You have hit the rate limit for this model"), true);
	assert.equal(isRateLimitError("5-hour usage quota exceeded; will reset at 12:00"), true);
	assert.equal(isRateLimitError("401 Unauthorized"), false);
	assert.equal(isRateLimitError(""), false);
});

test("markCooldown and isCooling respect the configured cooldown window", () => {
	const config = configWith("heimdall");
	config.cooldownMinutes = 10;
	markCooldown(config, "heimdall", NOW);
	assert.equal(isCooling(config, "heimdall", NOW), true);
	assert.equal(isCooling(config, "heimdall", NOW + 9 * MINUTE), true);
	assert.equal(isCooling(config, "heimdall", NOW + 10 * MINUTE), false);
	clearRestrictions(config, "heimdall");
	assert.equal(isCooling(config, "heimdall", NOW), false);
});

test("markQuotaBlocked and isQuotaBlocked expire at the reset deadline", () => {
	const config = configWith("heimdall");
	markQuotaBlocked(config, "heimdall", NOW + 5 * MINUTE);
	assert.equal(isQuotaBlocked(config, "heimdall", NOW), true);
	assert.equal(isQuotaBlocked(config, "heimdall", NOW + 5 * MINUTE), false);
});

test("selectNextKey skips quota-blocked keys in circular order", () => {
	const config = configWith("heimdall", "baldur", "vidar");
	config.activeKey = "heimdall";
	markQuotaBlocked(config, "baldur", NOW + MINUTE);

	const selection = selectNextKey(config, "heimdall", NOW);
	assert.equal(selection.name, "vidar");
	assert.equal(selection.reason, "rotated");
});

test("selectNextKey prefers non-cooling keys over cooling ones", () => {
	const config = configWith("heimdall", "baldur", "vidar");
	config.activeKey = "heimdall";
	markCooldown(config, "baldur", NOW);

	const selection = selectNextKey(config, "heimdall", NOW);
	assert.equal(selection.name, "vidar");
	assert.equal(selection.clearedCooldown, undefined);
});

test("selectNextKey clears the next cooldown when every alternative is cooling", () => {
	const config = configWith("heimdall", "baldur", "vidar");
	config.activeKey = "heimdall";
	markCooldown(config, "baldur", NOW);
	markCooldown(config, "vidar", NOW);

	const selection = selectNextKey(config, "heimdall", NOW);
	assert.equal(selection.name, "baldur");
	assert.equal(selection.clearedCooldown, "baldur");
});

test("selectNextKey reports every key quota-blocked with the earliest reset", () => {
	const config = configWith("heimdall", "baldur", "vidar");
	config.activeKey = "heimdall";
	markQuotaBlocked(config, "heimdall", NOW + 3 * MINUTE);
	markQuotaBlocked(config, "baldur", NOW + MINUTE);
	markQuotaBlocked(config, "vidar", NOW + 2 * MINUTE);

	const selection = selectNextKey(config, "heimdall", NOW);
	assert.equal(selection.name, null);
	assert.equal(selection.reason, "all-blocked");
	assert.equal(selection.earliestResetAt, NOW + MINUTE);
});

test("selectNextKey wraps around from the last key to the first", () => {
	const config = configWith("heimdall", "baldur", "vidar");
	config.activeKey = "vidar";

	const selection = selectNextKey(config, "vidar", NOW);
	assert.equal(selection.name, "heimdall");
});

test("selectNextKey treats an expired quota block as eligible again", () => {
	const config = configWith("heimdall", "baldur");
	config.activeKey = "heimdall";
	markQuotaBlocked(config, "baldur", NOW - 1);

	const selection = selectNextKey(config, "heimdall", NOW);
	assert.equal(selection.name, "baldur");
});

test("selectNextKey reports no keys and no alternative", () => {
	const empty = createEmptyConfig();
	assert.equal(selectNextKey(empty, null, NOW).reason, "no-keys");

	const single = configWith("heimdall");
	single.activeKey = "heimdall";
	assert.equal(selectNextKey(single, "heimdall", NOW).reason, "no-alternative");
});

test("rotateAwayFromActive applies the runtime key through authStorage", async () => {
	const config = configWith("heimdall", "baldur");
	config.activeKey = "heimdall";
	markCooldown(config, "heimdall", NOW);
	const fake = fakeRegistry();

	const outcome = await rotateAwayFromActive(config, NOW, fake.registry, "opencode-go");

	assert.equal(outcome.rotated, true);
	assert.equal(outcome.from, "heimdall");
	assert.equal(outcome.to, "baldur");
	assert.equal(config.activeKey, "baldur");
	assert.deepEqual(fake.applied, [{ provider: "opencode-go", key: "sk-baldur" }]);
});

test("rotateAwayFromActive falls back to registry.runtime when authStorage is absent", async () => {
	const config = configWith("heimdall", "baldur");
	config.activeKey = "heimdall";
	const applied: Array<{ provider: string; key: string }> = [];
	const registry = {
		runtime: {
			setRuntimeApiKey(provider: string, key: string) {
				applied.push({ provider, key });
			},
		},
	};

	const outcome = await rotateAwayFromActive(config, NOW, registry, "opencode-go");
	assert.equal(outcome.rotated, true);
	assert.deepEqual(applied, [{ provider: "opencode-go", key: "sk-baldur" }]);
});

test("rotateAwayFromActive stops when every key is quota-blocked", async () => {
	const config = configWith("heimdall", "baldur");
	config.activeKey = "heimdall";
	markQuotaBlocked(config, "heimdall", NOW + MINUTE);
	markQuotaBlocked(config, "baldur", NOW + 2 * MINUTE);
	const fake = fakeRegistry();

	const outcome = await rotateAwayFromActive(config, NOW, fake.registry, "opencode-go");
	assert.equal(outcome.rotated, false);
	assert.equal(outcome.reason, "all-blocked");
	assert.equal(outcome.earliestResetAt, NOW + MINUTE);
	assert.equal(config.activeKey, "heimdall");
	assert.deepEqual(fake.applied, []);
});

test("resolveRuntimeKeyStore returns undefined for unusable registries", () => {
	assert.equal(resolveRuntimeKeyStore(undefined), undefined);
	assert.equal(resolveRuntimeKeyStore({}), undefined);
	assert.equal(resolveRuntimeKeyStore({ authStorage: {} }), undefined);
	assert.equal(typeof resolveRuntimeKeyStore({ authStorage: { setRuntimeApiKey() {} } })?.setRuntimeApiKey, "function");
});

test("applyRuntimeKey reports whether a runtime key store was available", async () => {
	const fake = fakeRegistry();
	assert.equal(await applyRuntimeKey(fake.registry, "opencode-go", "sk-x"), true);
	assert.equal(await applyRuntimeKey({}, "opencode-go", "sk-x"), false);
});
