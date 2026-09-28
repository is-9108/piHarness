import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkWrite } from "../extensions/harness/guard.ts";
import {
	artifactPaths,
	escalationMarkdown,
	kickoffMessage,
	processIO,
	requiredArtifact,
} from "../extensions/harness/handoff.ts";
import {
	applyApproval,
	beginApproval,
	clearHandoff,
	DEFAULT_LIMITS as L,
	finishFlow,
	type HarnessState,
	initialState,
	processOf,
	recordReview,
	recordTestRun,
	rejoinImplement,
	resumeAfterEscalation,
	startBugfix,
	startImplement,
	startRequirements,
	transition,
	withHandoff,
	type ReviewFinding,
} from "../extensions/harness/state.ts";

const DIR = ".pi/harness/issue-7";
const P = artifactPaths(DIR);
const blocker: ReviewFinding = { severity: "blocker", perspective: "correctness", title: "bug", detail: "d" };

/** 拡張の setState と同じく、毎回 withHandoff を通して状態を進める */
function step(prev: HarnessState, next: HarnessState): HarnessState {
	return clearHandoff(withHandoff(prev, next));
}
function handoffTo(prev: HarnessState, next: HarnessState) {
	return withHandoff(prev, next).pendingHandoff?.to;
}

function planApproved(): HarnessState {
	let s = step(initialState(), startImplement(initialState(), { number: 7, title: "t" }, L, DIR));
	s = step(s, transition(s, "impl_plan"));
	s = step(s, beginApproval(s, "plan", [P.plan]));
	return step(s, applyApproval(s, "plan", "approved", "OK", [P.plan]));
}

describe("プロセス（セッション）境界", () => {
	it("フロー開始で新しいセッションを要求する", () => {
		assert.equal(handoffTo(initialState(), startRequirements(initialState(), "t", L, ".pi/harness/req")), "hearing");
		assert.equal(handoffTo(initialState(), startImplement(initialState(), { title: "t" }, L, DIR)), "plan");
	});

	it("同じプロセス内の遷移では切り替えない", () => {
		const s = step(initialState(), startImplement(initialState(), { title: "t" }, L, DIR));
		assert.equal(handoffTo(s, transition(s, "impl_plan")), undefined);
		let r = step(initialState(), startRequirements(initialState(), "t", L, ".pi/harness/req"));
		r = step(r, transition(r, "req_document"));
		r = step(r, beginApproval(r, "requirements", ["docs/r.md"]));
		assert.equal(handoffTo(r, applyApproval(r, "requirements", "revise", "x", ["docs/r.md"])), undefined, "修正依頼は同じ要件定義書作成セッションで対応");
	});

	it("ヒアリングと要件定義書作成は別セッション（往復もそれぞれ新しいセッション）", () => {
		const h = step(initialState(), startRequirements(initialState(), "t", L, ".pi/harness/req"));
		assert.equal(processOf(h), "hearing");
		assert.equal(handoffTo(h, transition(h, "req_document")), "requirements");
		const d = step(h, transition(h, "req_document"));
		assert.equal(handoffTo(d, transition(d, "req_clarify")), "hearing");
	});

	it("承認で 要件定義→Issue 登録、プラン→実装 に切り替わる", () => {
		let r = step(initialState(), startRequirements(initialState(), "t", L, ".pi/harness/req"));
		r = step(r, transition(r, "req_document"));
		r = step(r, beginApproval(r, "requirements", ["docs/r.md"]));
		assert.equal(handoffTo(r, applyApproval(r, "requirements", "approved", undefined, ["docs/r.md"])), "issues");
		assert.equal(handoffTo(r, applyApproval(r, "requirements", "revise", "x", ["docs/r.md"])), undefined);
		assert.equal(processOf(planApproved()), "implement");
	});

	it("実装→レビュー→指摘修正→レビュー の各周回が別セッションになり、完了では切り替えない", () => {
		let s = planApproved();
		s = step(s, recordTestRun(s, "green", true).state);
		assert.equal(handoffTo(s, transition(s, "impl_review")), "review");
		s = step(s, transition(s, "impl_review"));
		const fix = recordReview(s, [blocker], "x").state;
		assert.equal(handoffTo(s, fix), "fix");
		s = step(s, fix);
		s = step(s, recordTestRun(s, "green", true).state);
		assert.equal(handoffTo(s, transition(s, "impl_review")), "review");
		s = step(s, transition(s, "impl_review"));
		assert.equal(handoffTo(s, recordReview(s, [], "LGTM").state), undefined);
	});

	it("エスカレーションは同じセッションに留まり、ループ継続でも切り替えない。バグ修正選択で切り替える", () => {
		let s = planApproved();
		for (let i = 0; i < 3; i++) s = step(s, recordTestRun(s, "green", false).state);
		assert.equal(s.phase, "escalated");
		assert.equal(processOf(s), "implement");
		assert.equal(handoffTo(s, resumeAfterEscalation(s, L)), undefined);
		assert.equal(handoffTo(s, startBugfix(s, "b", L, ".pi/harness/bug-x")), "bugfix");
	});

	it("バグ修正完了 → 合流で新しいレビューセッション。中止では切り替えない", () => {
		let s = planApproved();
		for (let i = 0; i < 3; i++) s = step(s, recordTestRun(s, "green", false).state);
		s = step(s, startBugfix(s, "b", L, ".pi/harness/bug-x"));
		assert.equal(s.itemDir, DIR, "実装フローからの起動では同じ作業ディレクトリを使う");
		assert.equal(s.counters.bugs, 1);
		s = step(s, transition(s, "bug_analyze"));
		s = step(s, transition(s, "bug_fix"));
		s = step(s, recordTestRun(s, "green", true).state);
		s = step(s, transition(s, "bug_done"));
		assert.equal(handoffTo(s, rejoinImplement(s, L)), "review");
		assert.equal(handoffTo(s, finishFlow(s, "x")), undefined);
	});

	it("単独のバグ修正は専用の作業ディレクトリを使う", () => {
		const s = startBugfix(initialState(), "b", L, ".pi/harness/bug-1");
		assert.equal(s.itemDir, ".pi/harness/bug-1");
	});
});

describe("成果物による引き継ぎ", () => {
	const all = () => true;

	it("ヒアリング → 要件定義書作成には hearing.md、戻るには open-questions.md が必要", () => {
		const R = artifactPaths(".pi/harness/req");
		const h = startRequirements(initialState(), "t", L, ".pi/harness/req");
		assert.equal(requiredArtifact(h, "req_document")?.path, R.hearing);
		assert.equal(requiredArtifact(transition(h, "req_document"), "req_clarify")?.path, R.openQuestions);
	});

	it("ヒアリングは未確定論点を最優先で読み、要件定義書作成は hearing.md を読む", () => {
		const R = artifactPaths(".pi/harness/req");
		const h = startRequirements(initialState(), "t", L, ".pi/harness/req");
		const hio = processIO(h, all);
		assert.equal(hio?.inputs[0].path, R.openQuestions);
		assert.equal(hio?.outputs[0].path, R.hearing);
		const dio = processIO(transition(h, "req_document"), all);
		assert.equal(dio?.process, "requirements");
		assert.equal(dio?.inputs[0].path, R.hearing);
		assert.match(kickoffMessage(h, all), /「1\. ヒアリング」から/);
		assert.match(kickoffMessage(transition(h, "req_document"), all), /「2\. ドキュメント作成」から/);
	});

	it("各プロセスの出力が無ければ次へ進めない", () => {
		let s = planApproved();
		assert.equal(requiredArtifact(s, "impl_review")?.path, P.implementation);
		s = recordTestRun(s, "green", true).state;
		s = recordReview(transition(s, "impl_review"), [blocker], "x").state;
		assert.equal(requiredArtifact(s, "impl_review")?.path, P.fix(1));
		const b = transition(transition(startBugfix(s, "b", L, "x"), "bug_analyze"), "bug_fix");
		assert.equal(requiredArtifact(b, "bug_done")?.path, P.bug(1));
		assert.equal(requiredArtifact(b, "bug_analyze"), undefined);
	});

	it("プロセスごとの入力成果物（存在するものだけ）", () => {
		let s = planApproved();
		const exists = (p: string) => [P.issue, P.plan].includes(p);
		assert.deepEqual(
			processIO(s, exists)?.inputs.map((i) => i.path),
			[P.issue, P.plan],
		);
		s = recordTestRun(s, "green", true).state;
		s = recordReview(transition(s, "impl_review"), [blocker], "x").state;
		s = recordTestRun(s, "green", true).state;
		s = transition(s, "impl_review");
		const review = processIO(s, all);
		assert.equal(review?.process, "review");
		assert.ok(review?.inputs.some((i) => i.path === P.review(1)));
		assert.ok(review?.inputs.some((i) => i.path === P.fix(1)));
		assert.equal(review?.outputs[0].path, P.review(2));
	});

	it("バグ修正セッションはエスカレーション記録とテストログを入力にする", () => {
		let s = planApproved();
		for (let i = 0; i < 3; i++) s = recordTestRun(s, "green", false, `${P.logs}/t${i}.log`).state;
		s = startBugfix(s, "b", L, "x");
		const inputs = processIO(s, all)?.inputs.map((i) => i.path) ?? [];
		assert.equal(inputs[0], P.escalation(1));
		assert.ok(inputs.includes(`${P.logs}/t2.log`));
	});

	it("開始メッセージはスキルを展開し、会話を引き継がないことと入出力を明示する", () => {
		const s = planApproved();
		const msg = kickoffMessage(s, all);
		assert.match(msg, /^\/skill:harness-tdd \[piHarness\]/);
		assert.match(msg, /3\. TDD 実装/);
		assert.match(msg, /会話は引き継がれていません/);
		assert.match(msg, new RegExp(`- ${P.plan.replace(/\./g, "\\.")} — 承認済み`));
		assert.match(msg, /承認時のユーザーコメント: OK/);
	});

	it("エスカレーション記録に状況・参照・経緯を含める", () => {
		let s = planApproved();
		for (let i = 0; i < 3; i++) s = recordTestRun(s, "green", false, "log.txt").state;
		const md = escalationMarkdown(s, 1);
		assert.match(md, /# エスカレーション #1/);
		assert.match(md, /直近のテストログ: log\.txt/);
		assert.match(md, /テスト失敗 \(2\/3\)/);
	});

	it("状態ファイルはフロー外でも直接編集できない", () => {
		const paths = { cwd: "/r", docsDir: "docs", workDir: ".pi/harness" };
		assert.equal(checkWrite(initialState(), ".pi/harness/state.json", paths).block, true);
		assert.equal(checkWrite(planApproved(), ".pi/harness/state.json", paths).block, true);
	});
});
