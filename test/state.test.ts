import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	applyApproval,
	beginApproval,
	canCreateIssues,
	DEFAULT_LIMITS,
	escalate,
	initialState,
	recordIssues,
	recordReview,
	recordTestRun,
	rejoinImplement,
	resumeAfterEscalation,
	type ReviewFinding,
	reviewMode,
	startBugfix,
	startImplement,
	startRequirements,
	transition,
	TransitionError,
	markDirty,
	type HarnessState,
} from "../extensions/harness/state.ts";

const L = DEFAULT_LIMITS;
const blocker: ReviewFinding = { severity: "blocker", perspective: "correctness", title: "null deref", detail: "..." };
const nit: ReviewFinding = { severity: "nit", perspective: "style", title: "naming", detail: "..." };

function toTdd(): HarnessState {
	let s = startImplement(initialState(), { number: 1, title: "x" }, L);
	s = transition(s, "impl_plan");
	s = beginApproval(s, "plan", [".pi/harness/plans/issue-1.md"]);
	return applyApproval(s, "plan", "approved", undefined, [".pi/harness/plans/issue-1.md"]);
}

function toReview(): HarnessState {
	let s = toTdd();
	s = recordTestRun(s, "green", true).state;
	return transition(s, "impl_review");
}

describe("要件定義フロー", () => {
	it("承認されるまで Issue 登録できない", () => {
		let s = startRequirements(initialState(), "在庫管理", L);
		assert.equal(s.phase, "req_clarify");
		assert.equal(canCreateIssues(s), false);
		s = transition(s, "req_document");
		assert.throws(() => recordIssues(s, [{ title: "a" }]), TransitionError);
		s = beginApproval(s, "requirements", ["docs/requirements/x.md"]);
		assert.equal(s.phase, "req_approval");
		assert.equal(canCreateIssues(s), false);
		s = applyApproval(s, "requirements", "approved", "OK", ["docs/requirements/x.md"]);
		assert.equal(s.phase, "req_issues");
		assert.equal(canCreateIssues(s), true);
		s = recordIssues(s, [{ title: "a", number: 1 }]);
		assert.equal(s.phase, "req_done");
		assert.equal(s.artifacts.issues.length, 1);
	});

	it("修正依頼で要件定義書作成へ戻り、却下で終了する", () => {
		let s = transition(startRequirements(initialState(), "t", L), "req_document");
		s = beginApproval(s, "requirements", ["d.md"]);
		s = applyApproval(s, "requirements", "revise", "スコープ見直し", ["d.md"]);
		assert.equal(s.phase, "req_document");
		s = beginApproval(s, "requirements", ["d.md"]);
		s = applyApproval(s, "requirements", "rejected", undefined, ["d.md"]);
		assert.equal(s.phase, "idle");
		assert.equal(s.flow, null);
	});

	it("ヒアリング中に承認依頼はできない", () => {
		const s = startRequirements(initialState(), "t", L);
		assert.throws(() => beginApproval(s, "requirements", ["d.md"]), TransitionError);
	});
});

describe("実装フロー: 承認ゲート", () => {
	it("プラン承認前に TDD フェーズへは進めない", () => {
		const s = transition(startImplement(initialState(), { title: "x" }, L), "impl_plan");
		assert.throws(() => transition(s, "impl_tdd"), TransitionError);
		assert.throws(() => recordTestRun(s, "green", true), TransitionError);
	});

	it("承認でTDDへ、修正依頼でプラン作成へ戻る", () => {
		assert.equal(toTdd().phase, "impl_tdd");
		let s = transition(startImplement(initialState(), { title: "x" }, L), "impl_plan");
		s = beginApproval(s, "plan", ["p.md"]);
		s = applyApproval(s, "plan", "revise", "テスト観点不足", ["p.md"]);
		assert.equal(s.phase, "impl_plan");
	});
});

describe("実装フロー: テストループ", () => {
	it("Red 期待の失敗はループ回数に数えない", () => {
		const { state, outcome } = recordTestRun(toTdd(), "red", false);
		assert.equal(outcome.kind, "red_confirmed");
		assert.equal(state.test.failures, 0);
	});

	it("Red 期待なのに合格したら警告", () => {
		assert.equal(recordTestRun(toTdd(), "red", true).outcome.kind, "red_unexpected_pass");
	});

	it("green 失敗が 3 回連続でエスカレーション", () => {
		let s = toTdd();
		let r = recordTestRun(s, "green", false);
		assert.deepEqual(r.outcome, { kind: "fail", failures: 1, remaining: 2 });
		r = recordTestRun(r.state, "green", false);
		assert.equal(r.outcome.kind, "fail");
		r = recordTestRun(r.state, "green", false);
		assert.equal(r.outcome.kind, "escalate");
		s = r.state;
		assert.equal(s.phase, "escalated");
		assert.equal(s.escalation?.reason, "test_loop");
		assert.equal(s.escalation?.phase, "impl_tdd");
	});

	it("合格で連続失敗カウンタがリセットされる", () => {
		let s = recordTestRun(toTdd(), "green", false).state;
		s = recordTestRun(s, "green", false).state;
		s = recordTestRun(s, "green", true).state;
		assert.equal(s.test.failures, 0);
		s = recordTestRun(s, "green", false).state;
		assert.equal(s.test.failures, 1);
	});

	it("テスト未合格・合格後の変更ありではレビューへ進めない", () => {
		const s = toTdd();
		assert.throws(() => transition(s, "impl_review"), /harness_run_tests/);
		const red = recordTestRun(s, "red", false).state;
		assert.throws(() => transition(red, "impl_review"), TransitionError);
		const passed = recordTestRun(s, "green", true).state;
		assert.throws(() => transition(markDirty(passed), "impl_review"), /再度テスト/);
		assert.equal(transition(passed, "impl_review").phase, "impl_review");
	});

	it("エスカレーション後の継続でカウンタをリセットして元のフェーズへ", () => {
		let s = toTdd();
		for (let i = 0; i < 3; i++) s = recordTestRun(s, "green", false).state;
		s = resumeAfterEscalation(s, L);
		assert.equal(s.phase, "impl_tdd");
		assert.equal(s.test.failures, 0);
		assert.equal(s.escalation, undefined);
	});
});

describe("実装フロー: レビューループ", () => {
	it("1 周目はフル、2 周目以降は軽量", () => {
		let s = toReview();
		assert.equal(reviewMode(s), "full");
		s = recordReview(s, [blocker], "要修正").state;
		assert.equal(s.phase, "impl_fix_review");
		s = recordTestRun(s, "green", true).state;
		s = transition(s, "impl_review");
		assert.equal(reviewMode(s), "light");
	});

	it("ブロッキング指摘なしで完了（nit のみは完了扱い）", () => {
		const { state, outcome } = recordReview(toReview(), [nit], "LGTM");
		assert.equal(state.phase, "impl_done");
		assert.deepEqual(outcome, { kind: "clean", round: 1, nonBlocking: 1 });
	});

	it("3 周してもブロッキング指摘が残るとエスカレーション", () => {
		let s = toReview();
		for (let round = 1; round <= 2; round++) {
			const r = recordReview(s, [blocker], "要修正");
			assert.equal(r.outcome.kind, "fix");
			s = transition(recordTestRun(r.state, "green", true).state, "impl_review");
		}
		const r = recordReview(s, [blocker], "まだ残る");
		assert.equal(r.outcome.kind, "escalate");
		assert.equal(r.state.escalation?.reason, "review_loop");
		assert.equal(r.state.review.history.length, 3);
	});

	it("レビュー修正中のテスト失敗もループ上限でエスカレーション", () => {
		let s = recordReview(toReview(), [blocker], "要修正").state;
		for (let i = 0; i < 3; i++) s = recordTestRun(s, "green", false).state;
		assert.equal(s.phase, "escalated");
		assert.equal(s.escalation?.phase, "impl_fix_review");
	});

	it("レビューループのエスカレーション後に継続すると修正フェーズから追加の周回が許可される", () => {
		let s = toReview();
		for (let i = 0; i < 2; i++) s = transition(recordTestRun(recordReview(s, [blocker], "x").state, "green", true).state, "impl_review");
		s = recordReview(s, [blocker], "x").state;
		s = resumeAfterEscalation(s, L);
		assert.equal(s.phase, "impl_fix_review");
		assert.equal(s.review.max, 6);
	});

	it("blockingSeverities の設定で minor もブロッキング扱いにできる", () => {
		const minor: ReviewFinding = { ...nit, severity: "minor" };
		const r = recordReview(toReview(), [minor], "x", ["blocker", "major", "minor"]);
		assert.equal(r.outcome.kind, "fix");
	});

	it("レビュー中以外は記録できない", () => {
		assert.throws(() => recordReview(toTdd(), [], "x"), TransitionError);
	});
});

describe("バグ修正フロー", () => {
	function escalatedImpl(): HarnessState {
		let s = toTdd();
		for (let i = 0; i < 3; i++) s = recordTestRun(s, "green", false).state;
		return s;
	}

	it("エスカレーションから起動すると実装フローを退避し、完了後に impl_review へ合流する", () => {
		let s = startBugfix(escalatedImpl(), "境界値で落ちる", L);
		assert.equal(s.flow, "bugfix");
		assert.equal(s.phase, "bug_reproduce");
		assert.equal(s.suspended?.phase, "impl_tdd");
		assert.equal(s.suspended?.issue?.number, 1);
		assert.equal(s.escalation, undefined);

		s = recordTestRun(s, "red", false).state; // 再現
		s = transition(s, "bug_analyze");
		s = transition(s, "bug_fix");
		assert.throws(() => transition(s, "bug_done"), TransitionError);
		s = recordTestRun(s, "green", true).state;
		s = transition(s, "bug_done");
		s = rejoinImplement(s, L);
		assert.equal(s.flow, "implement");
		assert.equal(s.phase, "impl_review");
		assert.equal(s.review.round, 0);
		assert.equal(s.test.failures, 0);
		assert.equal(s.suspended, undefined);
		assert.equal(s.issue?.number, 1);
	});

	it("バグ修正フロー内の修正ループも 3 回で再エスカレーションし、再起動しても合流先を保持する", () => {
		let s = startBugfix(escalatedImpl(), "bug", L);
		s = transition(transition(s, "bug_analyze"), "bug_fix");
		for (let i = 0; i < 3; i++) s = recordTestRun(s, "green", false).state;
		assert.equal(s.phase, "escalated");
		assert.equal(s.escalation?.reason, "bugfix_loop");
		s = startBugfix(s, "bug 再挑戦", L);
		assert.equal(s.suspended?.issue?.number, 1);
		s = resumeAfterEscalation(escalate(transition(s, "bug_analyze"), "manual", "x"), L);
		assert.equal(s.phase, "bug_analyze");
	});

	it("単独起動のバグ修正フローには合流先がない", () => {
		let s = startBugfix(initialState(), "単独バグ", L);
		assert.equal(s.suspended, undefined);
		s = transition(transition(s, "bug_analyze"), "bug_fix");
		s = transition(recordTestRun(s, "green", true).state, "bug_done");
		assert.throws(() => rejoinImplement(s, L), /合流先/);
	});

	it("原因分析フェーズからコード修正を飛ばして完了できない", () => {
		const s = transition(startBugfix(initialState(), "b", L), "bug_analyze");
		assert.throws(() => transition(s, "bug_done"), TransitionError);
	});
});
