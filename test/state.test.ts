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
	allowTestChange,
	answerSpecGap,
	lockTests,
	pendingSpecGaps,
	processOf,
	recordFlaky,
	withHandoff,
} from "../extensions/harness/state.ts";

const L = DEFAULT_LIMITS;
const blocker: ReviewFinding = { severity: "blocker", perspective: "correctness", title: "null deref", detail: "..." };
const nit: ReviewFinding = { severity: "nit", perspective: "style", title: "naming", detail: "..." };

function toTdd(): HarnessState {
	let s = startImplement(initialState(), { number: 1, title: "x" }, L, ".pi/harness/issue-1");
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
		let s = startRequirements(initialState(), "在庫管理", L, ".pi/harness/req-x");
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
		let s = transition(startRequirements(initialState(), "t", L, ".pi/harness/req-x"), "req_document");
		s = beginApproval(s, "requirements", ["d.md"]);
		s = applyApproval(s, "requirements", "revise", "スコープ見直し", ["d.md"]);
		assert.equal(s.phase, "req_document");
		s = beginApproval(s, "requirements", ["d.md"]);
		s = applyApproval(s, "requirements", "rejected", undefined, ["d.md"]);
		assert.equal(s.phase, "idle");
		assert.equal(s.flow, null);
	});

	it("ヒアリング中に承認依頼はできない", () => {
		const s = startRequirements(initialState(), "t", L, ".pi/harness/req-x");
		assert.throws(() => beginApproval(s, "requirements", ["d.md"]), TransitionError);
	});
});

describe("実装フロー: 承認ゲート", () => {
	it("プラン承認前に TDD フェーズへは進めない", () => {
		const s = transition(startImplement(initialState(), { title: "x" }, L, ".pi/harness/issue-1"), "impl_plan");
		assert.throws(() => transition(s, "impl_tdd"), TransitionError);
		assert.throws(() => recordTestRun(s, "green", true), TransitionError);
	});

	it("承認でTDDへ、修正依頼でプラン作成へ戻る", () => {
		assert.equal(toTdd().phase, "impl_tdd");
		let s = transition(startImplement(initialState(), { title: "x" }, L, ".pi/harness/issue-1"), "impl_plan");
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
		assert.deepEqual(r.outcome, { kind: "fail", failures: 1, remaining: 2, same: 1 });
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
		let s = startBugfix(escalatedImpl(), "境界値で落ちる", L, ".pi/harness/bug-x");
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
		let s = startBugfix(escalatedImpl(), "bug", L, ".pi/harness/bug-x");
		s = transition(transition(s, "bug_analyze"), "bug_fix");
		for (let i = 0; i < 3; i++) s = recordTestRun(s, "green", false).state;
		assert.equal(s.phase, "escalated");
		assert.equal(s.escalation?.reason, "bugfix_loop");
		s = startBugfix(s, "bug 再挑戦", L, ".pi/harness/bug-x");
		assert.equal(s.suspended?.issue?.number, 1);
		s = resumeAfterEscalation(escalate(transition(s, "bug_analyze"), "manual", "x"), L);
		assert.equal(s.phase, "bug_analyze");
	});

	it("単独起動のバグ修正フローには合流先がない", () => {
		let s = startBugfix(initialState(), "単独バグ", L, ".pi/harness/bug-x");
		assert.equal(s.suspended, undefined);
		s = transition(transition(s, "bug_analyze"), "bug_fix");
		s = transition(recordTestRun(s, "green", true).state, "bug_done");
		assert.throws(() => rejoinImplement(s, L), /合流先/);
	});

	it("原因分析フェーズからコード修正を飛ばして完了できない", () => {
		const s = transition(startBugfix(initialState(), "b", L, ".pi/harness/bug-x"), "bug_analyze");
		assert.throws(() => transition(s, "bug_done"), TransitionError);
	});
});

describe("同じ失敗での早期エスカレーション", () => {
	const same = { fingerprint: "fp-a", sameFailureLimit: 2 };

	it("同じ失敗が 2 回続いたら、上限（3 回）を待たずに no_progress でエスカレーション", () => {
		let r = recordTestRun(toTdd(), "green", false, undefined, undefined, same);
		assert.equal(r.outcome.kind, "fail");
		r = recordTestRun(r.state, "green", false, undefined, undefined, same);
		assert.deepEqual(r.outcome, { kind: "escalate", failures: 2, reason: "no_progress" });
		assert.equal(r.state.escalation?.reason, "no_progress");
		assert.equal(r.state.escalation?.phase, "impl_tdd");
	});

	it("失敗の内容が変わっていれば続けられる。合格・継続で履歴をリセットする", () => {
		let r = recordTestRun(toTdd(), "green", false, undefined, undefined, same);
		r = recordTestRun(r.state, "green", false, undefined, undefined, { ...same, fingerprint: "fp-b" });
		assert.deepEqual(r.outcome, { kind: "fail", failures: 2, remaining: 1, same: 1 });
		const passed = recordTestRun(r.state, "green", true).state;
		assert.deepEqual(passed.test.failureHistory, []);
		r = recordTestRun(passed, "green", false, undefined, undefined, same);
		r = recordTestRun(r.state, "green", false, undefined, undefined, same);
		const resumed = resumeAfterEscalation(r.state, L);
		assert.equal(resumed.phase, "impl_tdd");
		assert.deepEqual(resumed.test.failureHistory, []);
	});

	it("sameFailureLimit が 0 なら判定しない。3 回目は通常の上限で test_loop", () => {
		let s = toTdd();
		for (let i = 0; i < 2; i++) s = recordTestRun(s, "green", false, undefined, undefined, { ...same, sameFailureLimit: 0 }).state;
		assert.equal(s.phase, "impl_tdd");
		const r = recordTestRun(s, "green", false, undefined, undefined, { ...same, sameFailureLimit: 0 });
		assert.deepEqual(r.outcome, { kind: "escalate", failures: 3, reason: "test_loop" });
	});

	it("flaky の記録はループの回数に影響しない", () => {
		const s = recordFlaky(toTdd(), [{ command: "npm test", killed: false, lines: ["✖ x"] }]);
		assert.equal(s.flaky?.length, 1);
		assert.equal(s.flaky?.[0].phase, "impl_tdd");
		assert.equal(s.test.failures, 0);
	});
});

describe("テストのロックの状態", () => {
	it("Green のロックは合格で外れ、レビューのロックは残る", () => {
		let s = lockTests(toTdd(), "green", { "a.test.ts": "h" });
		s = recordTestRun(s, "green", false).state;
		assert.equal(s.testLock?.mode, "green", "失敗では外れない");
		s = recordTestRun(s, "green", true).state;
		assert.equal(s.testLock, undefined);
		s = lockTests(transition(s, "impl_review"), "review", { "a.test.ts": "h" });
		assert.equal(s.testLock?.mode, "review");
	});

	it("バグ修正の開始と、再現テストへ戻るときはロックを外す", () => {
		let s = lockTests(toReview(), "review", { "a.test.ts": "h" });
		s = startBugfix(escalate(s, "manual", "x"), "bug", L, ".pi/harness/bug-x");
		assert.equal(s.testLock, undefined);
		s = lockTests(transition(s, "bug_analyze"), "green", { "bug.test.ts": "h" });
		s = transition(s, "bug_reproduce");
		assert.equal(s.testLock, undefined);
	});

	it("ユーザーが承認したテストは、ロックし直すまで変更できる（理由は PR に載る）", () => {
		assert.throws(() => allowTestChange(toTdd(), ["a.test.ts"], "r"), /ロックされていません/);
		let s = lockTests(toTdd(), "green", { "a.test.ts": "h" });
		s = allowTestChange(s, ["a.test.ts"], "[AC-2] 期待値が受け入れ条件と逆");
		assert.deepEqual(s.testLock?.allowed, ["a.test.ts"]);
		assert.equal(s.testChangeAcks.at(-1)?.reason, "[AC-2] 期待値が受け入れ条件と逆");
		s = lockTests(s, "green", { "a.test.ts": "h2" });
		assert.deepEqual(s.testLock?.allowed, []);
	});
});

describe("仕様の確認（spec_gap）", () => {
	const gap = { criterion: "AC-2", question: "空白だけの入力はどう扱いますか？", interpretations: ["空文字として扱う", "エラーにする"] };

	it("ブロッキング指摘が無ければ、回答後に決まった解釈でもう一度フルレビューする（周回に数えない）", () => {
		let r = recordReview(toReview(), [nit], "s", undefined, [gap]);
		assert.deepEqual(r.outcome, { kind: "spec_gap", round: 1, blocking: 0, questions: 1 });
		assert.equal(r.state.phase, "impl_spec_gap");
		assert.equal(processOf(r.state), "review");
		assert.deepEqual(pendingSpecGaps(r.state).map((g) => g.id), ["Q1"]);
		const a = answerSpecGap(r.state, "Q1", "空文字として扱う");
		assert.deepEqual(a.outcome, { kind: "rereview", round: 1 });
		assert.equal(a.state.phase, "impl_review");
		assert.equal(a.state.review.max, L.maxReviewLoops + 1);
		assert.equal(reviewMode(a.state), "full", "差分の全体をフルレビュー");
		assert.deepEqual(a.state.pendingHandoff?.to, "review", "新しいセッションでレビューし直す");
		assert.equal(withHandoff(r.state, a.state).pendingHandoff?.to, "review");
		// 同じ質問は二度聞かない
		r = recordReview({ ...a.state, pendingHandoff: undefined }, [], "s", undefined, [{ ...gap, question: " 空白だけの入力は どう扱いますか？" }]);
		assert.equal(r.outcome.kind, "clean");
		assert.equal(r.state.review.fullNext, undefined);
	});

	it("ブロッキング指摘があれば、回答後に指摘修正へ進む（周回に数える）", () => {
		const r = recordReview(toReview(), [blocker], "s", undefined, [gap, { ...gap, criterion: "AC-3", question: "上限は？" }]);
		let a = answerSpecGap(r.state, "Q1", "エラーにする");
		assert.equal(a.outcome, undefined, "未回答が残っている間は進まない");
		assert.equal(a.state.phase, "impl_spec_gap");
		assert.throws(() => answerSpecGap(a.state, "Q1", "x"), /回答済み/);
		a = answerSpecGap(a.state, "Q2", "100 件");
		assert.equal(a.outcome?.kind, "fix");
		assert.equal(a.state.phase, "impl_fix_review");
		assert.equal(a.state.review.max, L.maxReviewLoops);
	});

	it("最後の周回でブロッキング指摘が残れば、回答後にエスカレーション", () => {
		let s = toReview();
		for (let i = 0; i < 2; i++) {
			s = recordReview(s, [blocker], "s").state;
			s = transition(recordTestRun(s, "green", true).state, "impl_review");
		}
		const r = recordReview(s, [blocker], "s", undefined, [gap]);
		assert.equal(r.state.phase, "impl_spec_gap");
		const a = answerSpecGap(r.state, "Q1", "x");
		assert.equal(a.outcome?.kind, "escalate");
		assert.equal(a.state.escalation?.reason, "review_loop");
	});

	it("解釈が 1 つしかないものは質問にしない", () => {
		const r = recordReview(toReview(), [], "s", undefined, [{ ...gap, interpretations: ["一つだけ"] }]);
		assert.equal(r.outcome.kind, "clean");
	});
});
