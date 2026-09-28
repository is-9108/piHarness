import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compactionInstructions, shouldCompact } from "../extensions/harness/compaction.ts";
import { mergeConfig } from "../extensions/harness/config.ts";
import { countAcceptanceCriteria, validateDrafts } from "../extensions/harness/issues.ts";
import { DEFAULT_LIMITS, initialState, startImplement, transition, withHandoff, type HarnessState } from "../extensions/harness/state.ts";

const cfg = { enabled: true, thresholdPercent: 60 };
const working = (): HarnessState => transition(startImplement(initialState(), { number: 1, title: "t" }, DEFAULT_LIMITS, ".pi/harness/issue-1"), "impl_plan");

describe("しきい値による自動圧縮", () => {
	it("作業中のフェーズでしきい値以上なら圧縮する", () => {
		assert.equal(shouldCompact(working(), { percent: 59.9 }, cfg, false), false);
		assert.equal(shouldCompact(working(), { percent: 60 }, cfg, false), true);
	});

	it("無効・圧縮中・使用率不明・フロー外・承認待ち・次セッション待ちでは圧縮しない", () => {
		assert.equal(shouldCompact(working(), { percent: 90 }, { ...cfg, enabled: false }, false), false);
		assert.equal(shouldCompact(working(), { percent: 90 }, cfg, true), false);
		assert.equal(shouldCompact(working(), { percent: null }, cfg, false), false);
		assert.equal(shouldCompact(working(), undefined, cfg, false), false);
		assert.equal(shouldCompact(initialState(), { percent: 90 }, cfg, false), false);
		assert.equal(shouldCompact({ ...working(), phase: "impl_plan_approval" }, { percent: 90 }, cfg, false), false);
		const pending = withHandoff(working(), { ...working(), phase: "impl_tdd" });
		assert.ok(pending.pendingHandoff);
		assert.equal(shouldCompact(pending, { percent: 90 }, cfg, false), false);
	});

	it("要約の指示に作業状態を残すよう書く", () => {
		const text = compactionInstructions(working());
		assert.match(text, /impl_plan/);
		assert.match(text, /\.pi\/harness\/issue-1/);
		assert.match(text, /同じ修正を繰り返さない/);
	});

	it("設定の検証", () => {
		const w: string[] = [];
		assert.deepEqual(mergeConfig({}).compaction, { enabled: true, thresholdPercent: 60 });
		assert.deepEqual(mergeConfig({ compaction: { enabled: true, thresholdPercent: 99 } } as never, w).compaction.thresholdPercent, 60);
		assert.equal(w.length, 1);
	});
});

describe("Issue の大きさ", () => {
	const body = (n: number) => `## 背景\nx\n## 受け入れ条件\n${Array.from({ length: n }, (_, i) => `- [ ] AC-${i}`).join("\n")}\n## テスト観点\n- [ ] これは数えない\n`;
	const limits = mergeConfig({}).issueLimits;

	it("受け入れ条件のチェック項目だけを数える", () => {
		assert.equal(countAcceptanceCriteria(body(3)), 3);
		assert.equal(countAcceptanceCriteria("本文のみ"), 0);
	});

	it("L 規模・受け入れ条件が多すぎる Issue は分割を求める", () => {
		assert.deepEqual(validateDrafts([{ title: "a", body: body(5), size: "M" }], limits), []);
		const errs = validateDrafts(
			[
				{ title: "big", body: body(2), size: "L" },
				{ title: "many", body: body(6), size: "S" },
			],
			limits,
		);
		assert.equal(errs.length, 2);
		assert.match(errs[0], /規模 L は大きすぎます/);
		assert.match(errs[1], /受け入れ条件が 6 個/);
	});

	it("上限は設定で変えられる", () => {
		const w: string[] = [];
		const c = mergeConfig({ issueLimits: { maxAcceptanceCriteria: 8, allowedSizes: ["S", "M", "L"], maxPlanTestCases: 20 } } as never, w);
		assert.deepEqual(w, []);
		assert.deepEqual(validateDrafts([{ title: "big", body: body(8), size: "L" }], c.issueLimits), []);
		mergeConfig({ issueLimits: { allowedSizes: ["XL"] } } as never, w);
		assert.equal(w.length, 1);
	});
});
