import { test } from "node:test";
import assert from "node:assert/strict";
import {
	checkUsageForKey,
	parseUsage,
	quotaBlockUntil,
	type UsageFetch,
} from "../src/usage.ts";

const NOW = 1_000_000;
const MINUTE = 60_000;

function jsonResponse(body: unknown, status = 200): Awaited<ReturnType<UsageFetch>> {
	return {
		ok: status >= 200 && status < 300,
		status,
		async json() {
			return body;
		},
	};
}

test("parseUsage reads the array form and the record form", () => {
	const fromArray = parseUsage({
		windows: [
			{ name: "5-hour", status: "rate-limited", resetInSec: 120 },
			{ name: "weekly", status: "active" },
		],
	});
	assert.deepEqual(fromArray?.windows.map((window) => window.status), ["rate-limited", "active"]);

	const fromRecord = parseUsage({
		usage: {
			"5-hour": { status: "ok", reset_in_sec: 60 },
			weekly: { status: "rate-limited", resetAt: "2025-01-01T01:00:00.000Z" },
		},
	});
	assert.equal(fromRecord?.windows.length, 2);
	assert.equal(fromRecord?.windows[0]?.name, "5-hour");
	assert.equal(fromRecord?.windows[0]?.status, "active");
	assert.equal(fromRecord?.windows[0]?.resetInSec, 60);
	assert.equal(fromRecord?.windows[1]?.name, "weekly");
});

test("parseUsage rejects payloads that do not match the expected shape", () => {
	assert.equal(parseUsage(null), undefined);
	assert.equal(parseUsage("nope"), undefined);
	assert.equal(parseUsage({ windows: "nope" }), undefined);
	assert.equal(parseUsage({ windows: [42] }), undefined);
	assert.equal(parseUsage({ nope: true }), undefined);
});

test("quotaBlockUntil returns the latest reported reset for rate-limited windows", () => {
	const usage = parseUsage({
		windows: [
			{ status: "rate-limited", resetInSec: 120 },
			{ status: "rate-limited", resetAt: new Date(NOW + 5 * MINUTE).toISOString() },
			{ status: "active" },
		],
	});
	assert.ok(usage);
	assert.equal(quotaBlockUntil(usage, NOW), NOW + 5 * MINUTE);
});

test("quotaBlockUntil applies the fallback when no reset is reported", () => {
	const usage = parseUsage({ windows: [{ status: "rate-limited" }] });
	assert.ok(usage);
	assert.equal(quotaBlockUntil(usage, NOW, 10 * MINUTE), NOW + 10 * MINUTE);
});

test("quotaBlockUntil returns undefined without a rate-limited window", () => {
	const usage = parseUsage({ windows: [{ status: "active" }, { status: "unknown" }] });
	assert.ok(usage);
	assert.equal(quotaBlockUntil(usage, NOW), undefined);
});

test("checkUsageForKey marks a key blocked when a window is rate-limited", async () => {
	let seenAuth: string | undefined;
	const fetchUsage: UsageFetch = async (_url, init) => {
		seenAuth = init.headers.Authorization;
		return jsonResponse({ windows: [{ status: "rate-limited", resetInSec: 300 }] });
	};

	const result = await checkUsageForKey({ key: "sk-secret", now: NOW, fetch: fetchUsage });
	assert.equal(result.ok, true);
	assert.equal(result.blocked, true);
	assert.equal(result.blockUntil, NOW + 300_000);
	assert.equal(seenAuth, "Bearer sk-secret");
});

test("checkUsageForKey reports a clean reading without a block", async () => {
	const result = await checkUsageForKey({
		key: "sk-secret",
		now: NOW,
		fetch: async () => jsonResponse({ windows: [{ status: "active" }] }),
	});
	assert.equal(result.ok, true);
	assert.equal(result.blocked, false);
	assert.equal(result.blockUntil, undefined);
});

test("checkUsageForKey reports HTTP failures without blocking", async () => {
	const result = await checkUsageForKey({
		key: "sk-secret",
		now: NOW,
		fetch: async () => jsonResponse({}, 503),
	});
	assert.equal(result.ok, false);
	assert.equal(result.blocked, false);
	assert.match(result.message, /HTTP 503/);
});

test("checkUsageForKey reports unparseable payloads without blocking", async () => {
	const result = await checkUsageForKey({
		key: "sk-secret",
		now: NOW,
		fetch: async () => jsonResponse({ unexpected: true }),
	});
	assert.equal(result.ok, false);
	assert.equal(result.blocked, false);
	assert.match(result.message, /shape/i);
});

test("checkUsageForKey aborts a hanging request and reports a timeout", async () => {
	const hanging: UsageFetch = (_url, init) =>
		new Promise((_resolve, reject) => {
			init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
		});

	const result = await checkUsageForKey({ key: "sk-secret", now: NOW, fetch: hanging, timeoutMs: 5 });
	assert.equal(result.ok, false);
	assert.equal(result.blocked, false);
	assert.match(result.message, /timed out/i);
});
