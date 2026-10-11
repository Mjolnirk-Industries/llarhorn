import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

/** Environment override for the config file location. */
export const CONFIG_PATH_ENV = "LLARHORN_CONFIG";
/** Default transient cooldown applied to a key after a rate limit. */
export const DEFAULT_COOLDOWN_MINUTES = 60;
/** POSIX permissions used for the config file. */
export const CONFIG_FILE_MODE = 0o600;

/** A named API key entry. */
export interface KeyEntry {
	name: string;
	key: string;
}

/** Persisted llarhorn state. `activeKey` is a key name, not an index. */
export interface Config {
	keys: KeyEntry[];
	activeKey: string | null;
	cooldownMinutes: number;
	/** Key name -> epoch ms when the transient cooldown started. */
	cooldowns: Record<string, number>;
	/** Key name -> epoch ms when a quota block expires. */
	quotaBlockedUntil: Record<string, number>;
}

/** Raised for rejected key mutations. */
export class ConfigError extends Error {
	override readonly name = "ConfigError";
}

const KEY_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Create an empty, valid config. */
export function createEmptyConfig(): Config {
	return {
		keys: [],
		activeKey: null,
		cooldownMinutes: DEFAULT_COOLDOWN_MINUTES,
		cooldowns: {},
		quotaBlockedUntil: {},
	};
}

/** Resolve the config file path, honouring `LLARHORN_CONFIG`. */
export function getConfigPath(): string {
	return process.env[CONFIG_PATH_ENV] ?? join(homedir(), ".pi", "agent", "llarhorn-keys.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readFiniteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeKeys(value: unknown): KeyEntry[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const keys: KeyEntry[] = [];
	const seen = new Set<string>();
	for (const entry of value) {
		if (!isRecord(entry)) continue;
		const name = typeof entry.name === "string" ? entry.name : "";
		const key = typeof entry.key === "string" ? entry.key : "";
		if (!KEY_NAME_PATTERN.test(name) || key.length === 0 || seen.has(name)) continue;
		seen.add(name);
		keys.push({ name, key });
	}
	return keys;
}

function normalizeRestrictions(value: unknown, knownNames: Set<string>): Record<string, number> {
	if (!isRecord(value)) {
		return {};
	}
	const result: Record<string, number> = {};
	for (const [name, raw] of Object.entries(value)) {
		const timestamp = readFiniteNumber(raw);
		if (timestamp === undefined || !knownNames.has(name)) continue;
		result[name] = timestamp;
	}
	return result;
}

/** Coerce an unknown parsed value into a valid config, dropping unusable state. */
export function normalizeConfig(value: unknown): Config {
	if (!isRecord(value)) {
		return createEmptyConfig();
	}
	const keys = normalizeKeys(value.keys);
	const knownNames = new Set(keys.map((entry) => entry.name));
	const cooldownMinutes = readFiniteNumber(value.cooldownMinutes);
	const activeKey = typeof value.activeKey === "string" && knownNames.has(value.activeKey) ? value.activeKey : (keys[0]?.name ?? null);
	return {
		keys,
		activeKey,
		cooldownMinutes: cooldownMinutes !== undefined && cooldownMinutes >= 1 ? cooldownMinutes : DEFAULT_COOLDOWN_MINUTES,
		cooldowns: normalizeRestrictions(value.cooldowns, knownNames),
		quotaBlockedUntil: normalizeRestrictions(value.quotaBlockedUntil, knownNames),
	};
}

/** Load the config tolerantly: a missing or malformed file yields an empty config. */
export function loadConfig(path: string = getConfigPath()): Config {
	if (!existsSync(path)) {
		return createEmptyConfig();
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return createEmptyConfig();
	}
	return normalizeConfig(parsed);
}

function writeConfigFile(path: string, config: Config): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	const serialized = `${JSON.stringify(config, null, 2)}\n`;
	let descriptor: number | undefined;
	try {
		descriptor = openSync(temporaryPath, "wx", CONFIG_FILE_MODE);
		writeSync(descriptor, serialized, undefined, "utf-8");
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = undefined;
		chmodSync(temporaryPath, CONFIG_FILE_MODE);
		renameSync(temporaryPath, path);
	} finally {
		if (descriptor !== undefined) {
			closeSync(descriptor);
		}
		rmSync(temporaryPath, { force: true });
	}
}

/** Atomically persist the config with 0600 permissions. */
export function saveConfig(config: Config, path: string = getConfigPath()): void {
	writeConfigFile(path, config);
}

/** Read-modify-write the config and return the updated value plus the mutator result. */
export function mutateConfig<T>(mutator: (config: Config) => T, path: string = getConfigPath()): { config: Config; result: T } {
	const config = loadConfig(path);
	const result = mutator(config);
	writeConfigFile(path, config);
	return { config, result };
}

/** Mask key material, exposing at most the last four characters. */
export function maskKey(key: string): string {
	if (key.length <= 4) {
		return "\u2022\u2022\u2022\u2022";
	}
	return `\u2022\u2022\u2022\u2022${key.slice(-4)}`;
}

/** Find a key entry by name. */
export function findKey(config: Config, name: string): KeyEntry | undefined {
	return config.keys.find((entry) => entry.name === name);
}

/** Add a named key. The first key becomes active. Throws on duplicate or invalid input. */
export function addKey(config: Config, name: string, key: string): void {
	const trimmedName = name.trim();
	const trimmedKey = key.trim();
	if (!KEY_NAME_PATTERN.test(trimmedName)) {
		throw new ConfigError(`Invalid key name "${name}". Use letters, digits, dot, dash or underscore.`);
	}
	if (trimmedKey.length === 0) {
		throw new ConfigError("API key must not be empty.");
	}
	if (findKey(config, trimmedName)) {
		throw new ConfigError(`A key named "${trimmedName}" already exists.`);
	}
	config.keys.push({ name: trimmedName, key: trimmedKey });
	if (config.activeKey === null) {
		config.activeKey = trimmedName;
	}
}

/** Remove a key by name and clear its restriction state. Throws when the name is unknown. */
export function removeKey(config: Config, name: string): void {
	const index = config.keys.findIndex((entry) => entry.name === name);
	if (index === -1) {
		throw new ConfigError(`No key named "${name}".`);
	}
	config.keys.splice(index, 1);
	delete config.cooldowns[name];
	delete config.quotaBlockedUntil[name];
	if (config.activeKey === name) {
		config.activeKey = config.keys[0]?.name ?? null;
	}
}

/** Set the active key by name. Throws when the name is unknown. */
export function setActiveKey(config: Config, name: string): void {
	if (!findKey(config, name)) {
		throw new ConfigError(`No key named "${name}".`);
	}
	config.activeKey = name;
}
