import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { stepsLine } from "../extensions/harness/dashboard.ts";
import { checkWrite, isDocFile } from "../extensions/harness/guard.ts";
import { artifactPaths, processIO, requiredArtifact, skillFor } from "../extensions/harness/handoff.ts";
import {
	applyApproval,
	approvalKindFor,
	beginApproval,
	clearHandoff,
	DEFAULT_LIMITS as L,
	escalate,
	type HarnessState,
	initialState,
	processOf,
	recordReview,
	recordTestRun,
	resumeAfterEscalation,
	type ReviewFinding,
	startDocs,
	statusLine,
	transition,
	TransitionError,
	withHandoff,
} from "../extensions/harness/state.ts";
import { DOC_REVIEW_PERSPECTIVES, docPrVars, renderTemplate, reviewVars } from "../extensions/harness/templates.ts";
import { toolsForProcess } from "../extensions/harness/tools.ts";

const DIR = ".pi/harness/docs-1";
const P = artifactPaths(DIR);
const major: ReviewFinding = { severity: "major", perspective: "accuracy", title: "コマンドが違う", detail: "d" };
const step = (prev: HarnessState, next: HarnessState) => clearHandoff(withHandoff(prev, next));
const all = () => true;

function writing(): HarnessState {
	let s = step(initialState(), startDocs(initialState(), "導入手順", undefined, L, DIR));
	s = step(s, beginApproval(s, "outline", [P.outline]));
	return step(s, applyApproval(s, "outline", "approved", "初心者向けに", [P.outline]));
}

describe("ドキュメント作成フロー: 状態機械", () => {
	it("構成案 → 承認 → 執筆 → レビュー。各工程は別のプロセス（セッション）", () => {
		const start = startDocs(initialState(), "導入手順", undefined, L, DIR);
		assert.equal(start.flow, "docs");
		assert.equal(start.phase, "doc_outline");
		assert.equal(withHandoff(initialState(), start).pendingHandoff?.to, "doc_plan");
		assert.equal(approvalKindFor("doc_outline"), "outline");
		const s = writing();
		assert.equal(s.phase, "doc_write");
		assert.equal(processOf(s), "doc_write");
		assert.equal(s.artifacts.plan, P.outline);
		const review = transition(s, "doc_review");
		assert.equal(withHandoff(s, review).pendingHandoff?.to, "doc_review", "テスト無しで（成果物だけを条件に）レビューへ進める");
	});

	it("修正依頼・却下は構成案の工程に戻る / 終わる", () => {
		let s = step(initialState(), startDocs(initialState(), "t", undefined, L, DIR));
		s = beginApproval(s, "outline", [P.outline]);
		assert.equal(applyApproval(s, "outline", "revise", "x", [P.outline]).phase, "doc_outline");
		assert.equal(applyApproval(s, "outline", "rejected", undefined, [P.outline]).flow, null);
		assert.throws(() => beginApproval(writing(), "outline", [P.outline]), TransitionError);
	});

	it("テストは実行できない", () => {
		assert.throws(() => recordTestRun(writing(), "green", true), TransitionError);
	});

	it("レビュー: 指摘あり → 修正 → 再レビュー、指摘なし → 完了。仕様の確認は使わない", () => {
		let s = transition(writing(), "doc_review");
		const r1 = recordReview(s, [major], "x", ["blocker", "major"], [{ criterion: "AC-1", question: "q", interpretations: ["a", "b"] }]);
		assert.equal(r1.outcome.kind, "fix");
		assert.equal(r1.state.phase, "doc_fix");
		assert.equal((r1.state.specGaps ?? []).length, 0, "ドキュメントのレビューでは spec_gap を作らない");
		s = transition(r1.state, "doc_review");
		const r2 = recordReview(s, [], "ok");
		assert.equal(r2.outcome.kind, "clean");
		assert.equal(r2.state.phase, "doc_done");
		assert.equal(withHandoff(s, r2.state).pendingHandoff, undefined, "完了では新しいセッションを作らない");
	});

	it("レビューループの上限でエスカレーションし、継続すると指摘修正から再開する", () => {
		let s = transition(writing(), "doc_review");
		for (let i = 0; i < L.maxReviewLoops; i++) {
			const r = recordReview(s, [major], "x");
			s = r.outcome.kind === "fix" ? transition(r.state, "doc_review") : r.state;
		}
		assert.equal(s.phase, "escalated");
		assert.equal(s.escalation?.flow, "docs");
		assert.equal(resumeAfterEscalation(s, L).phase, "doc_fix");
		assert.equal(processOf(escalate(writing(), "manual", "x")), "doc_write");
	});

	it("状態表示にテストのループは出さない", () => {
		assert.doesNotMatch(statusLine(writing()), /test/);
		assert.match(statusLine(writing()), /review 0\/3/);
		assert.match(stepsLine(writing()), /✓ 構成案 › ✓ 承認 › ▶ 執筆 › ○ レビュー › ○ 完了/);
	});
});

describe("ドキュメント作成フロー: 引き継ぎ・ツール・ガード", () => {
	it("各工程の入力と必須の成果物・スキル", () => {
		const s = writing();
		const write = processIO(s, all, { adrIndex: "docs/adr/README.md" })!;
		assert.deepEqual(write.inputs.map((i) => i.path), [P.outline, P.issue]);
		assert.ok(write.outputs.some((o) => o.path === P.docReport));
		assert.equal(requiredArtifact(s, "doc_review")?.path, P.docReport);
		assert.equal(skillFor(s, "doc_write"), "harness-doc-write");
		const review = transition(s, "doc_review");
		assert.deepEqual(processIO(review, all)!.inputs.map((i) => i.path), [P.outline, P.docReport]);
		const fix = recordReview(review, [major], "x").state;
		assert.equal(requiredArtifact(fix, "doc_review")?.path, P.fix(1));
		const light = transition(fix, "doc_review");
		assert.deepEqual(processIO(light, all)!.inputs.map((i) => i.path), [P.review(1), P.fix(1), P.delta(2)], "2 周目は差分だけを見る");
		assert.equal(skillFor(light, "doc_review"), "harness-doc-review");
	});

	it("テストのツールは出さず、レビューは読み取り専用", () => {
		const registered = ["harness_run_tests", "harness_record_review", "harness_request_approval", "harness_phase", "harness_record_decision"];
		for (const proc of ["doc_plan", "doc_write", "doc_review", "doc_fix"] as const) {
			assert.ok(!toolsForProcess([], registered, proc).includes("harness_run_tests"), proc);
		}
		assert.ok(!toolsForProcess(["write", "edit", "read"], registered, "doc_review").includes("write"));
		assert.ok(toolsForProcess(["write"], registered, "doc_write").includes("write"));
	});

	it("執筆・修正で書けるのはドキュメントだけ（拡張子か docs/ 配下）", () => {
		const paths = { cwd: "/r", docsDir: "docs", workDir: ".pi/harness", adrDir: "docs/adr" };
		const s = writing();
		assert.equal(checkWrite(s, "README.md", paths).block, false);
		assert.equal(checkWrite(s, "guide/setup.mdx", paths).block, false);
		assert.equal(checkWrite(s, "docs/images/a.png", paths).block, false);
		assert.equal(checkWrite(s, `${DIR}/doc-report.md`, paths).block, false);
		assert.match(checkWrite(s, "src/app.js", paths).reason ?? "", /ドキュメント（.*）以外は変更できません/);
		assert.equal(checkWrite(s, "docs/adr/0001-x.md", paths).block, true, "ADR はツールで記録する");
		assert.equal(checkWrite(transition(s, "doc_review"), "README.md", paths).block, true, "レビュー中は書けない");
		assert.ok(isDocFile("CHANGELOG.MD", paths) && !isDocFile("package.json", paths));
	});
});

describe("ドキュメント作成フロー: テンプレート", () => {
	const tpl = (name: string) => readFileSync(join(resolve(import.meta.dirname, "../templates"), `${name}.md`), "utf8");

	it("レビュー記録はドキュメントの観点で集計する", () => {
		const md = renderTemplate(
			tpl("review"),
			reviewVars({ round: 1, mode: "full", target: "ドキュメント: 導入手順", at: "t", summary: "s", findings: [major], blocking: ["blocker", "major"], perspectives: DOC_REVIEW_PERSPECTIVES }),
		);
		assert.match(md, /\| 正確さ（accuracy） \| 1 件 \|/);
		assert.match(md, /\| リンク・参照（links） \| 指摘なし \|/);
		assert.doesNotMatch(md, /テスト（tests）/);
		assert.match(md, /- 観点: 正確さ（accuracy）/);
	});

	it("PR 本文は執筆レポートと git の差分から作り、テストの節は無い", () => {
		const report = "# 執筆レポート\n\n## 概要\n\n導入手順を書いた。\n\n## 作成・更新したファイル\n\n- docs/setup.md\n\n## 確認した情報源\n\n- src/app.js:1\n\n## 未確定事項・試せなかったこと\n\nなし\n";
		const body = renderTemplate(
			tpl("pr-docs"),
			docPrVars({
				report,
				issue: { number: 4, title: "導入手順を書く" },
				changedFiles: ["docs/setup.md", "README.md"],
				history: [{ round: 1, mode: "full", blocking: 0, total: 1, summary: "", at: "" }],
				remaining: [{ severity: "nit", perspective: "consistency", title: "表記揺れ", detail: "" }],
			}),
		);
		assert.deepEqual(
			body.split("\n").filter((l) => l.startsWith("## ")),
			["## 概要", "## 対象", "## 作成・更新したドキュメント", "## 確認した情報源", "## レビュー（piHarness）", "## レビューで特に見てほしい点", "## 未確定事項・既知の制約"],
		);
		assert.match(body, /## 概要\n\n導入手順を書いた。/);
		assert.match(body, /\*\*変更したファイル（git）\*\*\n\n- `docs\/setup\.md`\n- `README\.md`/);
		assert.match(body, /- \[nit\] 表記揺れ/);
		assert.match(body, /## レビューで特に見てほしい点\n\nなし/);
		assert.match(body, /Closes #4\n$/);
		assert.doesNotMatch(body, /\{\{|<!--/);
	});
});
