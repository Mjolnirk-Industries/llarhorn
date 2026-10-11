import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	ConfigError,
	addKey,
	findKey,
	getConfigPath,
	loadConfig,
	mutateConfig,
	removeKey,
	saveConfig,
	setActiveKey,
	type Config,
} from "./config-store.ts";
import { applyRuntimeKey, clearRestrictions, rotateAwayFromActive } from "./rotation.ts";
import { formatDuration, renderStatusReport, updateStatusIndicator } from "./status.ts";
import { checkUsageForKey, type UsageCheckResult, type UsageFetch } from "./usage.ts";

export interface LlarhornCommandDeps {
	provider: string;
	now(): number;
	fetchUsage?: UsageFetch;
	configPath?: string;
}

const SUBCOMMANDS = ["status", "add", "use", "next", "rm", "reset", "usage", "cooldown"] as const;
const USAGE_HELP =
	"Usage: /llarhorn [status | add <name> <key> | use <name> | next | rm <name> | reset | usage | cooldown [min]]";

/** Format one usage check result for `/llarhorn usage`. */
export function formatUsageReport(name: string, result: UsageCheckResult): string {
	if (!result.ok) {
		return `llarhorn usage (${name}): ${result.message}`;
	}
	const windows = result.usage?.windows ?? [];
	if (windows.length === 0) {
		return `llarhorn usage (${name}): no usage windows returned.`;
	}
	const lines = [`llarhorn usage (${name}):`];
	for (const window of windows) {
		const parts: string[] = [window.status];
		if (window.usagePercent !== undefined) {
			parts.push(`${window.usagePercent}%`);
		}
		if (window.resetInSec !== undefined) {
			parts.push(`resets in ${formatDuration(window.resetInSec * 1000)}`);
		} else if (window.resetAt) {
			parts.push(`resets at ${window.resetAt}`);
		}
		lines.push(`  ${window.name ?? "window"}: ${parts.join(", ")}`);
	}
	return lines.join("\n");
}

/** Register the `/llarhorn` command and its subcommands. */
export function registerLlarhornCommand(pi: ExtensionAPI, deps: LlarhornCommandDeps): void {
	const configPath = deps.configPath ?? getConfigPath();

	const refresh = (ctx: ExtensionCommandContext, config: Config): void => {
		updateStatusIndicator(ctx, config, deps.now());
	};

	const applyActive = async (ctx: ExtensionCommandContext, config: Config): Promise<void> => {
		const entry = config.activeKey ? findKey(config, config.activeKey) : undefined;
		if (entry) {
			await applyRuntimeKey(ctx.modelRegistry, deps.provider, entry.key);
		}
	};

	const handleStatus = (ctx: ExtensionCommandContext): void => {
		const config = loadConfig(configPath);
		refresh(ctx, config);
		ctx.ui.notify(renderStatusReport(config, deps.now()), "info");
	};

	const handleAdd = async (ctx: ExtensionCommandContext, tokens: string[]): Promise<void> => {
		const name = tokens[1];
		const key = tokens.slice(2).join(" ");
		if (!name || !key) {
			ctx.ui.notify(USAGE_HELP, "warning");
			return;
		}
		const { config } = mutateConfig((draft) => addKey(draft, name, key), configPath);
		if (config.activeKey === name) {
			await applyActive(ctx, config);
		}
		refresh(ctx, config);
		const activated = config.activeKey === name ? " and activated it" : "";
		ctx.ui.notify(`llarhorn: added "${name}"${activated}.`, "info");
	};

	const handleUse = async (ctx: ExtensionCommandContext, tokens: string[]): Promise<void> => {
		const name = tokens[1];
		if (!name) {
			ctx.ui.notify(USAGE_HELP, "warning");
			return;
		}
		const { config } = mutateConfig((draft) => {
			setActiveKey(draft, name);
			clearRestrictions(draft, name);
		}, configPath);
		await applyActive(ctx, config);
		refresh(ctx, config);
		ctx.ui.notify(`llarhorn: switched to "${name}".`, "info");
	};

	const handleNext = async (ctx: ExtensionCommandContext): Promise<void> => {
		const config = loadConfig(configPath);
		if (config.keys.length === 0) {
			ctx.ui.notify("No keys configured. Use /llarhorn add <name> <key>", "warning");
			return;
		}
		const nowMs = deps.now();
		const outcome = await rotateAwayFromActive(config, nowMs, ctx.modelRegistry, deps.provider);
		saveConfig(config, configPath);
		refresh(ctx, config);
		if (outcome.rotated) {
			ctx.ui.notify(`llarhorn: switched "${outcome.from}" \u2192 "${outcome.to}".`, "info");
			return;
		}
		if (outcome.reason === "all-blocked") {
			const reset =
				outcome.earliestResetAt !== undefined ? ` Earliest reset in ${formatDuration(outcome.earliestResetAt - nowMs)}.` : "";
			ctx.ui.notify(`llarhorn: every key is quota-blocked; no rotation possible.${reset}`, "warning");
			return;
		}
		ctx.ui.notify("llarhorn: no other eligible key to switch to.", "warning");
	};

	const handleRemove = async (ctx: ExtensionCommandContext, tokens: string[]): Promise<void> => {
		const name = tokens[1];
		if (!name) {
			ctx.ui.notify(USAGE_HELP, "warning");
			return;
		}
		const { config } = mutateConfig((draft) => removeKey(draft, name), configPath);
		await applyActive(ctx, config);
		refresh(ctx, config);
		ctx.ui.notify(`llarhorn: removed "${name}".`, "info");
	};

	const handleReset = (ctx: ExtensionCommandContext): void => {
		const { config } = mutateConfig((draft) => {
			draft.cooldowns = {};
			draft.quotaBlockedUntil = {};
		}, configPath);
		refresh(ctx, config);
		ctx.ui.notify("llarhorn: cleared all cooldowns and quota blocks.", "info");
	};

	const handleUsage = async (ctx: ExtensionCommandContext): Promise<void> => {
		const config = loadConfig(configPath);
		const entry = config.activeKey ? findKey(config, config.activeKey) : undefined;
		if (!entry) {
			ctx.ui.notify("llarhorn: no active key to check.", "warning");
			return;
		}
		const result = await checkUsageForKey({
			key: entry.key,
			now: deps.now(),
			fetch: deps.fetchUsage,
			fallbackMs: config.cooldownMinutes * 60_000,
		});
		ctx.ui.notify(formatUsageReport(entry.name, result), result.ok ? "info" : "warning");
	};

	const handleCooldown = (ctx: ExtensionCommandContext, tokens: string[]): void => {
		const raw = tokens[1];
		if (raw === undefined) {
			const config = loadConfig(configPath);
			ctx.ui.notify(`llarhorn: cooldown is ${config.cooldownMinutes} minutes.`, "info");
			return;
		}
		const minutes = Number(raw);
		if (!Number.isFinite(minutes) || minutes < 1) {
			ctx.ui.notify("llarhorn: cooldown must be a positive number of minutes.", "warning");
			return;
		}
		const { config } = mutateConfig((draft) => {
			draft.cooldownMinutes = Math.floor(minutes);
		}, configPath);
		refresh(ctx, config);
		ctx.ui.notify(`llarhorn: cooldown set to ${config.cooldownMinutes} minutes.`, "info");
	};

	pi.registerCommand("llarhorn", {
		description: "Manage and rotate named OpenCode Go API keys",
		getArgumentCompletions: (prefix) => {
			const trimmed = prefix.trimStart();
			if (trimmed.includes(" ")) {
				const [sub, partial = ""] = trimmed.split(/\s+/);
				if (sub === "use" || sub === "rm") {
					const matches = loadConfig(configPath)
						.keys.map((entry) => entry.name)
						.filter((name) => name.startsWith(partial));
					return matches.length > 0 ? matches.map((value) => ({ value: `${sub} ${value}`, label: value })) : null;
				}
				return null;
			}
			const matches = SUBCOMMANDS.filter((sub) => sub.startsWith(trimmed));
			return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const sub = tokens[0] ?? "status";
			try {
				switch (sub) {
					case "status":
						handleStatus(ctx);
						return;
					case "add":
						await handleAdd(ctx, tokens);
						return;
					case "use":
						await handleUse(ctx, tokens);
						return;
					case "next":
						await handleNext(ctx);
						return;
					case "rm":
						await handleRemove(ctx, tokens);
						return;
					case "reset":
						handleReset(ctx);
						return;
					case "usage":
						await handleUsage(ctx);
						return;
					case "cooldown":
						handleCooldown(ctx, tokens);
						return;
					default:
						ctx.ui.notify(USAGE_HELP, "warning");
						return;
				}
			} catch (error) {
				const message = error instanceof ConfigError ? error.message : error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`llarhorn: ${message}`, "error");
			}
		},
	});
}
