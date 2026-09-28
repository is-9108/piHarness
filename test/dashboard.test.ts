import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeActivity, formatCost, formatTokens, renderDashboard, stepsLine } from "../extensions/harness/dashboard.ts";
import {
	applyApproval,
	beginApproval,
	DEFAULT_LIMITS as L,
	escalate,
	initialState,
	recordReview,
	recordTestRun,
	startBugfix,
	startImplement,
	startRequirements,
	transition,
	type HarnessState,
} from "../extensions/harness/state.ts";

const session = { input: 12_345, output: 1_200, cost: 0.0421 };

function tdd(): HarnessState {
	let s = startImplement(initialState(), { number: 12, title: "ログイン API" }, L, ".pi/harness/issue-12");
	s = transition(s, "impl_plan");
	s = beginApproval(s, "plan", ["p.md"]);
	return applyApproval(s, "plan", "approved", undefined, ["p.md"]);
}

describe("ダッシュボード", () => {
	it("フロー外: 待機中・ブランチ・話しかけ方・このセッションのトークン", () => {
		const lines = renderDashboard({ state: initialState(), branch: "main", session, model: "anthropic/claude-sonnet-5", thinking: "medium" });
		assert.equal(lines.length, 2);
		assert.match(lines[0], /待機中 │ ⎇ main │ 話しかけて開始/);
		assert.match(lines[1], /このセッション 入 12\.3k \/ 出 1\.2k \$0\.042 │ anthropic\/claude-sonnet-5 · medium/);
	});

	it("実装フロー: 工程の現在位置・いまの作業・次にやること・ループ・作業合計・コンテキスト", () => {
		let s = recordTestRun(tdd(), "green", false).state;
		s = { ...s, git: { base: "abc", branch: "issue-12-login", baseBranch: "main" } };
		const lines = renderDashboard({
			state: s,
			activity: describeActivity("harness_run_tests", { expect: "green" }),
			branch: "issue-12-login",
			session,
			item: { tokens: 158_000, cost: 0.52, sessions: 3 },
			context: { percent: 51.4, tokens: 102_000, window: 200_000 },
			compactAt: 60,
		});
		assert.match(lines[0], /🧭 TDD 実装 │ #12 ログイン API │ ⎇ issue-12-login/);
		assert.equal(lines[1], "✓ 読込 › ✓ プラン › ✓ 承認 › ▶ TDD 実装 › ○ レビュー › ○ 完了");
		assert.match(lines[2], /▶ いま 🧪 テスト実行中（Green: 全体 \+ チェック） │ 次: Red → Green → Refactor/);
		assert.match(lines[3], /テスト修正 1\/3 │ レビュー 0\/3（次: フル） │ 直近のテスト FAIL/);
		assert.match(lines[4], /作業合計 158\.0k \$0\.520（3 セッション） │ コンテキスト 51%（圧縮 60%）/);
	});

	it("レビューの周回と修正中を工程に出す", () => {
		let s = recordTestRun(tdd(), "green", true).state;
		s = transition(s, "impl_review");
		assert.match(stepsLine(s), /▶ レビュー 1\/3/);
		s = recordReview(s, [{ severity: "major", perspective: "tests", title: "t", detail: "d" }], "x").state;
		assert.match(stepsLine(s), /✓ TDD 実装 › ▶ レビュー 1\/3（修正中） › ○ 完了/);
	});

	it("エスカレーション・承認待ち・要件定義・バグ修正の表示", () => {
		const esc = escalate(tdd(), "test_loop", "3 回失敗");
		const lines = renderDashboard({ state: esc, session });
		assert.match(lines[1], /⚠ TDD 実装/);
		assert.match(lines[2], /⚠ エスカレーション中: 3 回失敗 │ 「ループを続けて」/);

		let r = transition(startRequirements(initialState(), "温度ロガー", L, "d"), "req_document");
		r = beginApproval(r, "requirements", ["x.md"]);
		assert.equal(stepsLine(r), "✓ ヒアリング › ✓ 要件定義書 › ▶ 承認 › ○ Issue 登録 › ○ 完了");
		assert.match(renderDashboard({ state: r, session })[2], /次: あなたの承認待ち/);

		const b = startBugfix(esc, "境界値で落ちる", L, "b");
		assert.match(stepsLine(b), /▶ 再現 › ○ 分析 › ○ 修正 › ○ 完了 → 合流: #12 ログイン API/);
	});

	it("色付けはテーマの関数に任せる", () => {
		const painted = stepsLine(tdd(), (c, t) => `<${c}>${t}</${c}>`);
		assert.match(painted, /<success>✓ 読込<\/success>/);
		assert.match(painted, /<accent>▶ TDD 実装<\/accent>/);
		assert.match(painted, /<dim>○ レビュー<\/dim>/);
	});

	it("いまの作業の説明と数値の整形", () => {
		assert.equal(describeActivity("edit", { path: "src/a.ts" }), "✏️ 編集: src/a.ts");
		assert.equal(describeActivity("bash", { command: "npm run lint" }), "$ npm run lint");
		assert.equal(describeActivity("harness_request_approval", {}), "⏸ あなたの承認待ち");
		assert.equal(describeActivity("my_tool", undefined), "🔧 my_tool");
		assert.equal(formatTokens(999), "999");
		assert.equal(formatTokens(1_234_567), "1.2M");
		assert.equal(formatCost(1.5), "$1.50");
	});
});
