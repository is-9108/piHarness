/**
 * 各フェーズでエージェントに注入する指示文（純粋関数）。
 * 詳細な手順は SKILL.md 側に置き、ここでは「今どこにいて次に何をすべきか」だけを短く伝える。
 */
import type { HarnessConfig } from "./config.ts";
import { diffInstruction, PROCESS_LABELS, type ProcessIO } from "./handoff.ts";
import { allowedTransitions, describeIssue, type HarnessState, PHASE_LABELS, type Phase, reviewMode } from "./state.ts";

const NEXT: Record<Phase, string> = {
	idle: "",
	req_clarify:
		"仕様が明確になるまで harness_ask で質問を繰り返す（1 回の質問は 1 論点）。不明点が無くなったら確定事項を hearing.md にまとめ、harness_phase で req_document へ（ドキュメント作成は別セッション）。",
	req_document:
		"hearing.md をもとに skill harness-requirements のテンプレートで要件定義書・関連ドキュメント・Issue 分割案を作成し、harness_request_approval (kind: requirements) で承認を得る。大きな未確定事項があれば open-questions.md に書いて harness_phase で req_clarify へ戻る。",
	req_approval: "人間の承認待ち。承認ダイアログの結果を待つ。/harness approve または /harness revise でも応答できる。",
	req_issues:
		"承認済み。Issue 分割案に従い harness_create_issues で機能ごとの小さな Issue を登録する（1 Issue = 1 機能・レビュー可能な大きさ・受け入れ条件必須）。",
	req_done: "要件定義フローは完了。登録した Issue 一覧をユーザーに報告し、/impl <番号> で実装フローを開始できることを伝える。",
	impl_context:
		"Issue の内容と関連コード・既存テスト・規約を読み込む。読み終えたら harness_phase で impl_plan へ。まだコードは変更しない。",
	impl_plan:
		"skill harness-plan のテンプレートでテストプランと実装プランを作業ディレクトリの plan.md に作成し、harness_request_approval (kind: plan) で承認を得る。",
	impl_plan_approval: "プランの承認待ち。承認されるまでコードを変更しない。",
	impl_tdd:
		"承認済みプランに従い TDD（Red → Green → Refactor）で実装する。Red は harness_run_tests (expect: red)、Green は (expect: green)。全体が green になり未テスト変更が無くなったら、実装レポート implementation.md を書いて harness_phase で impl_review へ。",
	impl_review:
		"開始時のスキル（フル / 軽量レビュー）に従ってコードレビューを行い、harness_record_review で結果を記録する。受け入れ条件の解釈が分かれる点は指摘ではなく specGaps に書く。レビュー中はコードを変更しない。",
	impl_spec_gap:
		"仕様の確認（spec_gap）へのユーザーの回答待ち。自分で解釈を決めず、作業を止めて質問と解釈の候補をユーザーに示す。ユーザーが回答したら harness_control (action: answer_spec_gap) で回答ダイアログを出して確定する（/harness answer <回答> でも可）。",
	impl_fix_review:
		"ブロッキング指摘を修正し harness_run_tests (expect: green) で全テストを合格させ、指摘ごとの対応を fix-<周回>.md に書いてから harness_phase で impl_review へ戻る。",
	impl_done: "実装フロー完了。変更内容・テスト結果・残った軽微な指摘をユーザーに報告する。",
	bug_reproduce:
		"skill harness-bugfix に従い、バグを再現するテストを先に書き harness_run_tests (expect: red) で再現を確認する。確認後 harness_phase で bug_analyze へ。",
	bug_analyze: "根本原因を分析してバグレポートに記録する（コード変更は不可）。分析後 harness_phase で bug_fix へ。",
	bug_fix:
		"根本原因に対する最小限の修正を行い harness_run_tests (expect: green) で全テストを合格させる。バグレポート bug-<番号>.md を完成させて harness_phase で bug_done へ。",
	bug_done: "バグ修正フロー完了。合流先の実装フローがあればそこへ戻る。",
	doc_outline:
		"skill harness-doc-plan に従い、情報源（コード・既存ドキュメント・Issue）を読んで構成案 outline.md を作り、harness_request_approval (kind: outline) で承認を得る。まだドキュメントは書かない。",
	doc_outline_approval: "構成案の承認待ち。承認されるまでドキュメントを書かない。",
	doc_write:
		"承認済みの構成案どおりにドキュメントを書く（ドキュメント以外のファイルは変更できない。テストは無い）。書き終えたら執筆レポート doc-report.md を書いて harness_phase で doc_review へ。",
	doc_review:
		"開始時のスキルに従ってドキュメントをレビューし（正確さはコードや情報源で確かめる）、harness_record_review で結果を記録する。レビュー中はファイルを変更しない。",
	doc_fix: "ブロッキング指摘を修正し、指摘ごとの対応を fix-<周回>.md に書いてから harness_phase で doc_review へ戻る。",
	doc_done: "ドキュメント作成フロー完了。作成・更新したドキュメント・レビュー結果・コミット/PR をユーザーに報告する。",
	escalated: "ユーザーへエスカレーション中。自分で作業を続けず、状況と選択肢を報告してユーザーの判断を待つ。",
};

export function buildContext(s: HarnessState, cfg: HarnessConfig, io?: ProcessIO): string {
	const lines: string[] = [];
	lines.push("[piHarness ワークフロー制御中]（最新の状態。以前の状態表示より優先する）");
	lines.push(`フロー: ${s.flow} / フェーズ: ${s.phase}（${PHASE_LABELS[s.phase]}）`);
	if (io) {
		lines.push(`プロセス: ${PROCESS_LABELS[io.process]}（このセッションの担当範囲。前のプロセスとの連携は成果物ファイルのみ）`);
		lines.push(`作業ディレクトリ: ${s.itemDir}/`);
		if (io.inputs.length) lines.push(`入力成果物: ${io.inputs.map((i) => i.path).join(", ")}`);
		lines.push(`出力成果物: ${io.outputs.map((o) => o.path).join(", ")}`);
	}
	const diff = diffInstruction(s);
	if (diff) lines.push(diff);
	if (s.pendingHandoff) {
		lines.push(`このプロセスは完了済み。次の「${PROCESS_LABELS[s.pendingHandoff.to]}」は新しいセッションで開始される。これ以上作業しないこと。`);
	}
	if (s.topic) lines.push(`テーマ: ${s.topic}`);
	if (s.issue) lines.push(`対象 Issue: ${describeIssue(s.issue)}${s.issue.url ? ` ${s.issue.url}` : ""}`);
	if (s.flow === "implement" || s.flow === "bugfix") {
		lines.push(
			`テストループ: 連続失敗 ${s.test.failures}/${s.test.max}${s.test.dirty ? "（最後のテスト以降に未テストの変更あり）" : ""}`,
		);
		lines.push(`テストコマンド: ${cfg.testCommand ?? "(未設定: harness_run_tests 実行時にユーザーへ確認)"}`);
		if (cfg.checkCommands.length) lines.push(`green 判定で合格が必要なチェック: ${cfg.checkCommands.join(" / ")}`);
		const history = s.test.failureHistory ?? [];
		const same = history.length && history.every((h) => h === history[history.length - 1]) ? history.length : 0;
		if (same >= 1 && cfg.sameFailureLimit >= 2) {
			lines.push(`同じ失敗: ${same}/${cfg.sameFailureLimit} 回（同じ失敗が続くと上限を待たずにエスカレーション。前回と違うアプローチで直す）`);
		}
		if (s.baseline?.failures.length) {
			lines.push(`ベースライン（開始時点ですでに失敗。同じ失敗だけなら判定から除外）: ${s.baseline.failures.map((f) => f.command).join(" / ")}`);
		}
		if (s.testLock) {
			lines.push(
				s.testLock.mode === "green"
					? `テストのロック: Red で確かめたテスト（${Object.keys(s.testLock.files).length} ファイル）は Green の合格まで変更・追加できない`
					: `テストのロック: レビュー時点のテスト（${Object.keys(s.testLock.files).length} ファイル）は変更できない（新しいテストファイルの追加は可）`,
			);
			if (s.testLock.allowed.length) lines.push(`変更を承認されたテスト: ${s.testLock.allowed.join(", ")}`);
		}
	}
	if (s.flow === "docs") lines.push("ドキュメント作成フロー: 変更できるのはドキュメント（.md など）だけ。テストは実行しない。");
	if (s.flow === "implement" || s.flow === "docs") {
		lines.push(`レビューループ: ${s.review.round}/${s.review.max} 周実施済み（次回: ${reviewMode(s) === "full" ? "フルレビュー" : "軽量レビュー"}）`);
	}
	if (s.bug) lines.push(`バグ: ${s.bug.description}`);
	if (s.suspended) lines.push(`合流予定の実装フロー: ${describeIssue(s.suspended.issue)}（退避フェーズ ${s.suspended.phase}）`);
	if (s.escalation) lines.push(`エスカレーション理由: ${s.escalation.detail}`);
	const pending = (s.specGaps ?? []).filter((g) => !g.answer);
	if (s.phase === "impl_spec_gap" && pending.length) {
		lines.push("ユーザーの回答待ちの仕様の確認:");
		for (const g of pending) lines.push(`- ${g.id} [${g.criterion}] ${g.question}（解釈: ${g.interpretations.join(" / ")}）`);
	}
	if ((s.phase === "impl_fix_review" || s.phase === "doc_fix") && s.review.lastFindings.length) {
		lines.push("修正すべき前回のレビュー指摘:");
		for (const f of s.review.lastFindings.filter((f) => cfg.blockingSeverities.includes(f.severity))) {
			lines.push(`- [${f.severity}/${f.perspective}] ${f.title}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : ""}`);
		}
	}
	const allowed = allowedTransitions(s);
	if (allowed.length) lines.push(`harness_phase で遷移可能: ${allowed.join(", ")}`);
	lines.push(`次にやること: ${NEXT[s.phase]}`);
	lines.push(`ドキュメント出力先: ${cfg.docsDir}/ 、ハーネス作業ファイル: ${cfg.workDir}/`);
	lines.push("ルール: 承認ゲートやループ上限を迂回しない。フェーズ遷移は harness_* ツールで行う。");
	return lines.join("\n");
}
