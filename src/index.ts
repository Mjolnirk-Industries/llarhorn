import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { findKey, getConfigPath, loadConfig, saveConfig, type Config } from "./config-store.ts";
import { registerLlarhornCommand } from "./commands.ts";
import {
	applyRuntimeKey,
	isRateLimitError,
	markCooldown,
	markQuotaBlocked,
	rotateAwayFromActive,
} from "./rotation.ts";
import { formatDuration, updateStatusIndicator } from "./status.ts";
import { checkUsageForKey, type UsageFetch } from "./usage.ts";

/** Provider this extension balances. */
export const PROVIDER = "opencode-go";

/** Window in which an after-response rotation suppresses the matching message-end rotation. */
const DEDUP_WINDOW_MS = 15_000;

export interface LlarhornExtensionOptions {
	/** Override the config file location. */
	configPath?: string;
	/** Injected clock for tests. */
	now?(): number;
	/** Injected usage fetcher for tests. */
	fetchUsage?: UsageFetch;
}

/**
 * Wire the llarhorn extension: session restore, reactive 429 rotation with
 * usage verification, and the `/llarhorn` command family.
 */
export function registerLlarhorn(pi: ExtensionAPI, options: LlarhornExtensionOptions = {}): void {
	const now = options.now ?? (() => Date.now());
	const configPath = options.configPath ?? getConfigPath();

	/** Set by an after-response rotation; consumes the matching message-end error once. */
	let suppressMessageEndRotation = false;
	let suppressSince = 0;

	const refresh = (ctx: ExtensionContext, config: Config): void => {
		updateStatusIndicator(ctx, config, now());
	};

	const activateActiveKey = async (ctx: ExtensionContext, config: Config): Promise<void> => {
		const entry = config.activeKey ? findKey(config, config.activeKey) : undefined;
		if (entry) {
			await applyRuntimeKey(ctx.modelRegistry, PROVIDER, entry.key);
		}
	};

	/**
	 * Mark the active key (quota block when the usage endpoint confirms it,
	 * transient cooldown otherwise), then rotate to the next eligible key.
	 * Returns true when a rotation happened.
	 */
	const handleRateLimit = async (ctx: ExtensionContext): Promise<boolean> => {
		const config = loadConfig(configPath);
		if (config.keys.length === 0) {
			ctx.ui.notify("No keys configured. Use /llarhorn add <name> <key>", "warning");
			return false;
		}

		const nowMs = now();
		const activeName = config.activeKey;
		if (activeName) {
			const entry = findKey(config, activeName);
			let blockedUntil: number | undefined;
			if (entry) {
				const check = await checkUsageForKey({
					key: entry.key,
					now: nowMs,
					fetch: options.fetchUsage,
					fallbackMs: config.cooldownMinutes * 60_000,
				});
				if (check.ok && check.blocked) {
					blockedUntil = check.blockUntil ?? nowMs + config.cooldownMinutes * 60_000;
				}
			}
			if (blockedUntil !== undefined) {
				markQuotaBlocked(config, activeName, blockedUntil);
			} else {
				markCooldown(config, activeName, nowMs);
			}
		}

		const outcome = await rotateAwayFromActive(config, nowMs, ctx.modelRegistry, PROVIDER);
		saveConfig(config, configPath);
		refresh(ctx, config);

		if (outcome.rotated) {
			ctx.ui.notify(`llarhorn: rate limited on "${outcome.from}"; switched to "${outcome.to}".`, "warning");
			return true;
		}
		if (outcome.reason === "all-blocked") {
			const reset = outcome.earliestResetAt !== undefined ? ` Earliest reset in ${formatDuration(outcome.earliestResetAt - nowMs)}.` : "";
			ctx.ui.notify(`llarhorn: every key is quota-blocked; automatic rotation stopped.${reset}`, "error");
			return false;
		}
		if (outcome.reason === "no-alternative") {
			ctx.ui.notify(`llarhorn: rate limited on "${activeName ?? "active key"}" and no alternative key is available.`, "warning");
		}
		return false;
	};

	pi.on("session_start", async (_event, ctx) => {
		const config = loadConfig(configPath);
		if (config.keys.length === 0) {
			ctx.ui.notify("No keys configured. Use /llarhorn add <name> <key>", "warning");
			refresh(ctx, config);
			return;
		}
		await activateActiveKey(ctx, config);
		refresh(ctx, config);
	});

	pi.on("after_provider_response", async (event, ctx) => {
		if (event.status !== 429 || ctx.model?.provider !== PROVIDER) return;
		const rotated = await handleRateLimit(ctx);
		if (rotated) {
			suppressMessageEndRotation = true;
			suppressSince = now();
		}
	});

	pi.on("message_end", async (event, ctx) => {
		const message = event.message;
		if (message.role !== "assistant" || message.stopReason !== "error") return;
		if (message.provider !== PROVIDER) return;
		if (!isRateLimitError(message.errorMessage ?? "")) return;
		if (suppressMessageEndRotation && now() - suppressSince < DEDUP_WINDOW_MS) {
			suppressMessageEndRotation = false;
			return;
		}
		await handleRateLimit(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		suppressMessageEndRotation = false;
		refresh(ctx, loadConfig(configPath));
	});

	registerLlarhornCommand(pi, {
		provider: PROVIDER,
		now,
		fetchUsage: options.fetchUsage,
		configPath,
	});
}

export default function llarhornExtension(pi: ExtensionAPI): void {
	registerLlarhorn(pi);
}
