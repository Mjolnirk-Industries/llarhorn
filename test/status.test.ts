import { test } from "node:test";
import assert from "node:assert/strict";
import { addKey, createEmptyConfig, type Config } from "../src/config-store.ts";
import { markCooldown, markQuotaBlocked } from "../src/rotation.ts";
import { formatDuration, renderStatusReport, renderStatusText, renderWidgetLines } from "../src/status.ts";

const NOW = 1_000_000;
const MINUTE = 60_000;

function configWith(...names: string[]): Config {
	const config = createEmptyConfig();
	for (const name of names) {
		addKey(config, name, `sk-${name}-value`);
	}
	return config;
}

test("formatDuration renders minutes and hours", () => {
	assert.equal(formatDuration(30_000), "1m");
	assert.equal(formatDuration(90_000), "2m");
	assert.equal(formatDuration(60 * MINUTE), "1h");
	assert.equal(formatDuration(65 * MINUTE), "1h5m");
});

test("renderStatusText shows the active account name", () => {
	const config = configWith("heimdall", "baldur");
	config.activeKey = "heimdall";
	assert.equal(renderStatusText(config, NOW), "llarhorn: heimdall");

	config.activeKey = "baldur";
	assert.equal(renderStatusText(config, NOW), "llarhorn: baldur");
});

test("renderStatusText annotates quota blocks and cooldowns", () => {
	const config = configWith("heimdall", "baldur");
	config.activeKey = "heimdall";
	markQuotaBlocked(config, "heimdall", NOW + 5 * MINUTE);
	assert.equal(renderStatusText(config, NOW), "llarhorn: heimdall (quota-blocked 5m)");

	const cooling = configWith("baldur");
	cooling.activeKey = "baldur";
	markCooldown(cooling, "baldur", NOW);
	assert.equal(renderStatusText(cooling, NOW), "llarhorn: baldur (cooldown 1h)");
});

test("renderStatusText handles an empty config", () => {
	assert.equal(renderStatusText(createEmptyConfig(), NOW), "llarhorn: no keys");
});

test("renderStatusReport marks the active key and never prints full key material", () => {
	const config = configWith("heimdall", "baldur");
	config.activeKey = "baldur";
	const report = renderStatusReport(config, NOW);
	assert.match(report, /\* baldur/);
	assert.match(report, /heimdall/);
	assert.match(report, /\u2022\u2022\u2022\u2022alue/);
	assert.ok(!report.includes("sk-heimdall-value"));
	assert.ok(!report.includes("sk-baldur-value"));
});

test("renderWidgetLines lists the active account first, then the rest", () => {
	const config = configWith("heimdall", "baldur");
	config.activeKey = "heimdall";
	assert.deepEqual(renderWidgetLines(config, NOW), ["llarhorn: heimdall", "  baldur"]);
});
