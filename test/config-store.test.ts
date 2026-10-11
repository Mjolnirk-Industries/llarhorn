import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CONFIG_FILE_MODE,
	CONFIG_PATH_ENV,
	DEFAULT_COOLDOWN_MINUTES,
	ConfigError,
	addKey,
	createEmptyConfig,
	findKey,
	getConfigPath,
	loadConfig,
	maskKey,
	removeKey,
	saveConfig,
	setActiveKey,
} from "../src/config-store.ts";

function tempConfigPath(): string {
	const dir = mkdtempSync(join(tmpdir(), "llarhorn-test-"));
	return join(dir, "llarhorn-keys.json");
}

function configWith(...names: string[]) {
	const config = createEmptyConfig();
	for (const name of names) {
		addKey(config, name, `sk-${name}-secret-value`);
	}
	return config;
}

test("createEmptyConfig returns documented defaults", () => {
	const config = createEmptyConfig();
	assert.deepEqual(config.keys, []);
	assert.equal(config.activeKey, null);
	assert.equal(config.cooldownMinutes, DEFAULT_COOLDOWN_MINUTES);
	assert.deepEqual(config.cooldowns, {});
	assert.deepEqual(config.quotaBlockedUntil, {});
});

test("maskKey never exposes more than the last four characters", () => {
	const masked = maskKey("sk-1234567890abcdef");
	assert.equal(masked, "\u2022\u2022\u2022\u2022cdef");
	assert.ok(!masked.includes("1234567890"));
	assert.equal(maskKey("abc"), "\u2022\u2022\u2022\u2022");
	assert.equal(maskKey(""), "\u2022\u2022\u2022\u2022");
});

test("getConfigPath honours LLARHORN_CONFIG and defaults to the pi agent dir", () => {
	const previous = process.env[CONFIG_PATH_ENV];
	try {
		process.env[CONFIG_PATH_ENV] = "C:/custom/llarhorn.json";
		assert.equal(getConfigPath(), "C:/custom/llarhorn.json");
		delete process.env[CONFIG_PATH_ENV];
		assert.ok(getConfigPath().endsWith(join(".pi", "agent", "llarhorn-keys.json")));
	} finally {
		if (previous === undefined) {
			delete process.env[CONFIG_PATH_ENV];
		} else {
			process.env[CONFIG_PATH_ENV] = previous;
		}
	}
});

test("save and load round-trip named keys and the active key name", () => {
	const path = tempConfigPath();
	const config = configWith("heimdall", "baldur");
	config.activeKey = "baldur";
	config.cooldownMinutes = 15;
	config.cooldowns["heimdall"] = 1_000;
	config.quotaBlockedUntil["baldur"] = 2_000;

	saveConfig(config, path);
	const loaded = loadConfig(path);

	assert.deepEqual(loaded.keys, [
		{ name: "heimdall", key: "sk-heimdall-secret-value" },
		{ name: "baldur", key: "sk-baldur-secret-value" },
	]);
	assert.equal(loaded.activeKey, "baldur");
	assert.equal(loaded.cooldownMinutes, 15);
	assert.deepEqual(loaded.cooldowns, { heimdall: 1_000 });
	assert.deepEqual(loaded.quotaBlockedUntil, { baldur: 2_000 });
});

test("saved config file uses 0600 permissions", { skip: process.platform === "win32" ? "Windows does not report POSIX modes" : false }, () => {
	const path = tempConfigPath();
	saveConfig(configWith("heimdall"), path);
	assert.equal(statSync(path).mode & 0o777, CONFIG_FILE_MODE);
});

test("loadConfig returns an empty config when the file is missing", () => {
	const config = loadConfig(tempConfigPath());
	assert.deepEqual(config, createEmptyConfig());
});

test("loadConfig tolerates malformed JSON by falling back to an empty config", () => {
	const path = tempConfigPath();
	writeFileSync(path, "{ this is not json", "utf-8");
	assert.deepEqual(loadConfig(path), createEmptyConfig());
});

test("loadConfig drops invalid entries, dedupes names, and normalises activeKey", () => {
	const path = tempConfigPath();
	writeFileSync(
		path,
		JSON.stringify({
			keys: [
				{ name: "heimdall", key: "sk-a" },
				{ name: "", key: "sk-b" },
				{ name: "baldur" },
				"not-an-entry",
				{ name: "heimdall", key: "sk-duplicate" },
			],
			activeKey: "does-not-exist",
			unknownField: true,
		}),
		"utf-8",
	);

	const loaded = loadConfig(path);
	assert.deepEqual(loaded.keys, [{ name: "heimdall", key: "sk-a" }]);
	assert.equal(loaded.activeKey, "heimdall");
	assert.equal(loaded.cooldownMinutes, DEFAULT_COOLDOWN_MINUTES);
});

test("loadConfig drops restriction state for unknown keys and non-numeric values", () => {
	const path = tempConfigPath();
	writeFileSync(
		path,
		JSON.stringify({
			keys: [{ name: "heimdall", key: "sk-a" }],
			cooldowns: { heimdall: 5, ghost: 10, bad: "nope" },
			quotaBlockedUntil: { heimdall: 20, ghost: 30 },
			cooldownMinutes: 0,
		}),
		"utf-8",
	);

	const loaded = loadConfig(path);
	assert.deepEqual(loaded.cooldowns, { heimdall: 5 });
	assert.deepEqual(loaded.quotaBlockedUntil, { heimdall: 20 });
	assert.equal(loaded.cooldownMinutes, DEFAULT_COOLDOWN_MINUTES);
});

test("addKey activates the first key and rejects duplicates and invalid input", () => {
	const config = createEmptyConfig();
	addKey(config, "heimdall", "sk-a");
	assert.equal(config.activeKey, "heimdall");

	assert.throws(() => addKey(config, "heimdall", "sk-b"), ConfigError);
	assert.throws(() => addKey(config, "", "sk-b"), ConfigError);
	assert.throws(() => addKey(config, "with space", "sk-b"), ConfigError);
	assert.throws(() => addKey(config, "baldur", ""), ConfigError);
	assert.equal(config.keys.length, 1);
});

test("removeKey reassigns the active key and clears its restrictions", () => {
	const config = configWith("heimdall", "baldur");
	config.activeKey = "heimdall";
	config.cooldowns["heimdall"] = 1_000;
	config.quotaBlockedUntil["heimdall"] = 2_000;

	removeKey(config, "heimdall");

	assert.deepEqual(config.keys.map((entry) => entry.name), ["baldur"]);
	assert.equal(config.activeKey, "baldur");
	assert.deepEqual(config.cooldowns, {});
	assert.deepEqual(config.quotaBlockedUntil, {});
	assert.throws(() => removeKey(config, "heimdall"), ConfigError);
});

test("setActiveKey rejects unknown names", () => {
	const config = configWith("heimdall");
	assert.throws(() => setActiveKey(config, "baldur"), ConfigError);
	setActiveKey(config, "heimdall");
	assert.equal(config.activeKey, "heimdall");
});

test("findKey locates an entry by name", () => {
	const config = configWith("heimdall");
	assert.equal(findKey(config, "heimdall")?.key, "sk-heimdall-secret-value");
	assert.equal(findKey(config, "baldur"), undefined);
});

test("saveConfig replaces an existing config file", () => {
	const path = tempConfigPath();
	saveConfig(configWith("heimdall"), path);
	saveConfig(configWith("baldur"), path);
	const loaded = loadConfig(path);
	assert.deepEqual(loaded.keys.map((entry) => entry.name), ["baldur"]);
	assert.equal(loaded.activeKey, "baldur");
});

test("saveConfig writes atomically and leaves no temporary files", () => {
	const dir = mkdtempSync(join(tmpdir(), "llarhorn-test-"));
	const path = join(dir, "llarhorn-keys.json");
	saveConfig(configWith("heimdall"), path);
	assert.deepEqual(
		readdirSync(dir).filter((name) => name !== "llarhorn-keys.json"),
		[],
	);
	assert.ok(readFileSync(path, "utf-8").endsWith("\n"));
});
