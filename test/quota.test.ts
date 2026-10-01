import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	classifyProviderError,
	earliestReset,
	emptyStatus,
	formatUntil,
	limitedUntil,
	parseResetAt,
	pruneStatus,
	recordLimit,
} from "../extensions/harness/quota.ts";

const now = new Date("2026-10-01T10:00:00Z");
const cooldown = { quotaCooldownMinutes: 60, transientCooldownMinutes: 10 };

describe("利用上限のエラーの判定", () => {
	it("利用枠・課金の上限は quota、混雑・レート制限は transient、それ以外は対象外", () => {
		for (const m of [
			"GoUsageLimitError: Monthly usage limit reached",
			"insufficient_quota: You exceeded your current quota",
			"subscription_sharing_usage_limit_exceeded",
			"Your credit balance is too low. Please go to Plans & Billing",
		]) {
			assert.equal(classifyProviderError(m), "quota", m);
		}
		for (const m of ["529 overloaded", "Too Many Requests", "503 Service Unavailable"]) assert.equal(classifyProviderError(m), "transient", m);
		for (const m of ["401 Unauthorized", "invalid_request_error: messages: field required", "", undefined]) {
			assert.equal(classifyProviderError(m), undefined, String(m));
		}
	});

	it("エラーの本文から解除の時刻を読む", () => {
		assert.equal(parseResetAt("Try again in 2 hours.", now)?.toISOString(), "2026-10-01T12:00:00.000Z");
		assert.equal(parseResetAt("Please try again in 3h 20m", now)?.toISOString(), "2026-10-01T13:20:00.000Z");
		assert.equal(parseResetAt("retry after 90 seconds", now)?.toISOString(), "2026-10-01T10:01:30.000Z");
		assert.equal(parseResetAt("limit resets at 2026-10-02T00:00:00Z", now)?.toISOString(), "2026-10-02T00:00:00.000Z");
		assert.equal(parseResetAt("resets at 2026-09-01T00:00:00Z", now), undefined, "過去の時刻は使わない");
		assert.equal(parseResetAt("quota exceeded after 3 retries", now), undefined);
	});
});

describe("上限の記録", () => {
	it("解除の時刻が読めなければ種類ごとの既定の時間だけ避け、解除後は使える", () => {
		let s = recordLimit(emptyStatus(), "opencode-go", "quota", "Monthly usage limit reached", now, cooldown, "kimi-k3");
		s = recordLimit(s, "openai", "transient", "overloaded", now, cooldown);
		assert.equal(limitedUntil(s, "opencode-go", now)?.toISOString(), "2026-10-01T11:00:00.000Z");
		assert.equal(limitedUntil(s, "openai", now)?.toISOString(), "2026-10-01T10:10:00.000Z");
		assert.equal(limitedUntil(s, "anthropic", now), undefined);
		assert.equal(earliestReset(s, ["opencode-go", "openai"], now)?.toISOString(), "2026-10-01T10:10:00.000Z");
		const later = new Date("2026-10-01T10:30:00Z");
		assert.equal(limitedUntil(s, "openai", later), undefined);
		assert.deepEqual(Object.keys(pruneStatus(s, later).providers), ["opencode-go"]);
		assert.equal(s.providers["opencode-go"].model, "kimi-k3");
	});

	it("解除の時刻の表示（日付が変わるときは日付も）", () => {
		const local = new Date(2026, 9, 1, 10, 0);
		assert.equal(formatUntil(new Date(2026, 9, 1, 13, 5), local), "13:05");
		assert.equal(formatUntil(new Date(2026, 9, 2, 1, 0), local), "10/2 01:00");
	});
});
