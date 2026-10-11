import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { findKey, maskKey, type Config } from "./config-store.ts";
import { isCooling, isQuotaBlocked } from "./rotation.ts";

/** Status-bar key used for the persistent active-account indicator. */
export const STATUS_KEY = "llarhorn";
/** Widget key used for the account list shown near the editor. */
export const WIDGET_KEY = "llarhorn-accounts";

const MINUTE_MS = 60_000;

/** Compact duration such as `42m` or `1h5m`. */
export function formatDuration(ms: number): string {
	const minutes = Math.max(1, Math.ceil(ms / MINUTE_MS));
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest === 0 ? `${hours}h` : `${hours}h${rest}m`;
}

function stateSuffix(config: Config, name: string, now: number): string {
	const blockedUntil = config.quotaBlockedUntil[name];
	if (typeof blockedUntil === "number" && blockedUntil > now) {
		return ` (quota-blocked ${formatDuration(blockedUntil - now)})`;
	}
	if (isCooling(config, name, now)) {
		const startedAt = config.cooldowns[name];
		if (typeof startedAt === "number") {
			return ` (cooldown ${formatDuration(startedAt + config.cooldownMinutes * MINUTE_MS - now)})`;
		}
	}
	return "";
}

/** One-line indicator text for the status bar. */
export function renderStatusText(config: Config, now: number): string {
	const active = config.activeKey ? findKey(config, config.activeKey) : undefined;
	if (!active) {
		return config.keys.length === 0 ? "llarhorn: no keys" : "llarhorn: no active key";
	}
	return `llarhorn: ${active.name}${stateSuffix(config, active.name, now)}`;
}

/** Multi-line report for `/llarhorn status`. */
export function renderStatusReport(config: Config, now: number): string {
	const count = config.keys.length;
	const lines = [`llarhorn \u2014 ${count} key${count === 1 ? "" : "s"} (cooldown ${config.cooldownMinutes}m)`];
	if (count === 0) {
		lines.push("  no keys configured. Use /llarhorn add <name> <key>");
		return lines.join("\n");
	}
	for (const entry of config.keys) {
		const marker = entry.name === config.activeKey ? "*" : " ";
		lines.push(`${marker} ${entry.name} (${maskKey(entry.key)})${stateSuffix(config, entry.name, now)}`);
	}
	return lines.join("\n");
}

/** Widget lines listing the active account and the remaining accounts. */
export function renderWidgetLines(config: Config, now: number): string[] {
	const lines = [renderStatusText(config, now)];
	for (const entry of config.keys) {
		if (entry.name === config.activeKey) continue;
		lines.push(`  ${entry.name}${stateSuffix(config, entry.name, now)}`);
	}
	return lines;
}

/** Refresh the persistent indicator. Terminal-only, so other modes are left untouched. */
export function updateStatusIndicator(ctx: ExtensionContext, config: Config, now: number): void {
	if (ctx.mode !== "tui") return;
	ctx.ui.setStatus(STATUS_KEY, renderStatusText(config, now));
	ctx.ui.setWidget(WIDGET_KEY, renderWidgetLines(config, now), { placement: "belowEditor" });
}
