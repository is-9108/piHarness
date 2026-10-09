import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import {
	extractSection,
	issueVars,
	loadTemplate,
	prVars,
	renderTemplate,
	reviewVars,
	TEMPLATE_NAMES,
	type TemplateName,
	templatePath,
} from "../extensions/harness/templates.ts";
import type { ReviewFinding } from "../extensions/harness/state.ts";

const builtin = resolve(import.meta.dirname, "../templates");
const tpl = (name: TemplateName) => readFileSync(join(builtin, `${name}.md`), "utf8");

describe("テンプレートの展開", () => {
	it("値を埋め、コメントを除き、空の値は「なし」、{{x?}} は空にする", () => {
		const out = renderTemplate("<!-- 説明 -->\n# {{a}}\n\n{{b}}\n\n\n\n{{c?}}\n末尾", { a: "見出し", b: " " });
		assert.equal(out, "# 見出し\n\nなし\n\n末尾\n");
	});

	it("プロジェクトの <workDir>/templates が同梱より優先される", () => {
		const cwd = mkdtempSync(join(tmpdir(), "tpl-"));
		assert.equal(templatePath(cwd, ".pi/harness", builtin, "pr").source, "builtin");
		mkdirSync(join(cwd, ".pi/harness/templates"), { recursive: true });
		writeFileSync(join(cwd, ".pi/harness/templates/pr.md"), "独自 {{summary}}");
		assert.equal(templatePath(cwd, ".pi/harness", builtin, "pr").source, "project");
		assert.equal(loadTemplate(cwd, ".pi/harness", builtin, "pr"), "独自 {{summary}}");
	});

	it("同梱テンプレートがすべて存在する", () => {
		for (const n of TEMPLATE_NAMES) assert.ok(tpl(n).length > 0);
	});
});

describe("Issue 本文", () => {
	it("見出しの並びが固定され、受け入れ条件に番号が付く", () => {
		const body = renderTemplate(
			tpl("issue"),
			issueVars(
				{ title: "t", background: "理由", inScope: ["A"], acceptanceCriteria: ["x を返す", "y を拒否する"], size: "S" },
				[{ number: 3, title: "前提" }],
			),
		);
		const headings = body.split("\n").filter((l) => l.startsWith("## "));
		assert.deepEqual(headings, ["## 背景・目的", "## スコープ", "## 受け入れ条件", "## テスト観点", "## 依存関係", "## 参照", "## 補足"]);
		assert.match(body, /- \[ \] AC-1: x を返す\n- \[ \] AC-2: y を拒否する/);
		assert.match(body, /## 依存関係\n\n以下の Issue の完了後[\s\S]*- #3/);
		assert.match(body, /\*\*やらないこと\*\*\n\nなし/);
		assert.doesNotMatch(body, /\{\{|<!--/);
	});
});

describe("レビュー記録", () => {
	const findings: ReviewFinding[] = [
		{ severity: "major", perspective: "tests", title: "異常系が無い", detail: "未接続時のテストが無い", file: "src/a.ts", line: 3, suggestion: "テストを足す" },
		{ severity: "nit", perspective: "style", title: "命名", detail: "x は曖昧" },
	];
	const base = { round: 1, target: "#1 t", at: "2026-01-01T00:00:00.000Z", summary: "概ね良い", blocking: ["blocker", "major"] };

	it("フルレビューは全観点と指摘数・判定を固定の形で出す", () => {
		const md = renderTemplate(tpl("review"), reviewVars({ ...base, mode: "full", findings }));
		assert.match(md, /# レビュー 1 周目（フルレビュー）/);
		assert.match(md, /判定 \| 🔴 修正が必要（修正必須 1 件）/);
		assert.match(md, /blocker 0 \/ major 1 \/ minor 0 \/ nit 1（修正必須 1 件）/);
		assert.match(md, /\| 要件（requirements） \| 指摘なし \|/);
		assert.match(md, /\| テスト（tests） \| 1 件 \|/);
		assert.match(md, /\| style \| 1 件 \|/);
		assert.match(md, /### 1\. \[major 🔴\] 異常系が無い\n\n- 観点: テスト（tests）\n- 場所: `src\/a\.ts:3`\n- 修正必須: はい/);
		assert.match(md, /### 2\. \[nit\] 命名[\s\S]*\*\*修正案:\*\* なし/);
	});

	it("指摘なし・軽量レビュー", () => {
		const md = renderTemplate(tpl("review"), reviewVars({ ...base, round: 2, mode: "light", findings: [] }));
		assert.match(md, /軽量レビュー）/);
		assert.match(md, /✅ 修正必須の指摘なし/);
		assert.match(md, /前回の指摘の解消と前回レビュー以降の差分だけ/);
		assert.match(md, /## 指摘\n\nなし/);
		assert.match(md, /## 仕様の確認（ユーザーに確認する曖昧な点）\n\nなし/);
	});

	it("仕様の確認は解釈の候補と回答（または回答待ち）を載せる", () => {
		const gap = { id: "Q1", criterion: "AC-2", question: "空白は？", interpretations: ["空文字", "エラー"], evidence: "src/a.ts:3", round: 1 };
		const md = renderTemplate(tpl("review"), reviewVars({ ...base, mode: "full", findings: [], specGaps: [gap] }));
		assert.match(md, /判定 \| ❓ 仕様の確認が必要（1 件）/);
		assert.match(md, /### Q1\. \[AC-2\] 空白は？\n\n- 解釈 1: 空文字\n- 解釈 2: エラー\n- 箇所: `src\/a\.ts:3`\n- 回答: （ユーザーの回答待ち）/);
	});
});

describe("PR 本文", () => {
	const impl = [
		"# 実装レポート: #12 ログイン",
		"## 概要",
		"<!-- 何をどう実装したか -->",
		"ログイン API を追加した。",
		"## 受け入れ条件の充足",
		"| 受け入れ条件 | 対応テスト | 状態 |",
		"|---|---|---|",
		"| AC-1 | `a.test.ts::ok` | ✅ |",
		"## 変更ファイル",
		"| ファイル | 変更内容 |",
		"|---------|---------|",
		"## テスト結果",
		"- 追加したテスト数: 3",
		"## プランからの逸脱",
		"なし",
		"## 既知の制約・スコープ外で気づいたこと",
		"- ",
	].join("\n");

	it("実装レポートの見出しを取り出す（空の表・箇条書きは未記入）", () => {
		assert.equal(extractSection(impl, "概要"), "ログイン API を追加した。");
		assert.equal(extractSection(impl, "変更ファイル"), undefined);
		assert.equal(extractSection(impl, "既知の制約"), undefined);
		assert.equal(extractSection(impl, "無い見出し"), undefined);
	});

	it("日本語の固定の構成で、Closes と利用量を末尾に付ける", () => {
		const body = renderTemplate(
			tpl("pr"),
			prVars({
				implementation: impl,
				issue: { number: 12, title: "ログイン" },
				test: { runs: 4, lastResult: "pass" },
				testCommand: "npm test",
				checkCommands: ["npm run lint"],
				testChangeReasons: [],
				history: [
					{ round: 1, mode: "full", blocking: 1, total: 2, summary: "", at: "" },
					{ round: 2, mode: "light", blocking: 0, total: 1, summary: "", at: "" },
				],
				remaining: [{ severity: "minor", perspective: "maintainability", title: "重複", detail: "", file: "a.ts" }],
				usage: "モデル利用量: 3 セッション",
			}),
		);
		const headings = body.split("\n").filter((l) => l.startsWith("## "));
		assert.deepEqual(headings, [
			"## 概要",
			"## 関連 Issue",
			"## 受け入れ条件の充足",
			"## 変更内容",
			"## テスト",
			"## テストの変更（削除・スキップなど）",
			"## レビュー（piHarness）",
			"## 仕様の確認（レビュー中にユーザーが決めたこと）",
			"## 設計判断（ADR）",
			"## プランからの逸脱",
			"## レビューで特に見てほしい点",
			"## 既知の制約",
		]);
		assert.match(body, /## 概要\n\nログイン API を追加した。/);
		assert.match(body, /## 関連 Issue\n\n#12 ログイン/);
		assert.match(body, /## 変更内容\n\n（実装レポートに記載なし）/);
		assert.match(body, /✅ 合格（piHarness が実行。テスト実行 4 回）\n- テストコマンド: `npm test`\n- チェック: `npm run lint`\n\n- 追加したテスト数: 3/);
		assert.match(body, /\| 2 \| 軽量 \| 0 件 \| 1 件 \|/);
		assert.match(body, /\*\*残した軽微な指摘\*\*\n\n- \[minor\] 重複（`a\.ts`）/);
		assert.match(body, /## 既知の制約\n\nなし/);
		assert.match(body, /モデル利用量: 3 セッション\n\nCloses #12\n$/);
		assert.doesNotMatch(body, /\{\{|<!--/);
	});

	it("Issue 番号が無ければ Closes 行を出さない", () => {
		const body = renderTemplate(tpl("pr"), prVars({ implementation: "", test: { runs: 0 }, checkCommands: [], testChangeReasons: ["仕様変更"], history: [], remaining: [] }));
		assert.doesNotMatch(body, /Closes/);
		assert.match(body, /## テストの変更（削除・スキップなど）\n\n- 仕様変更/);
		assert.match(body, /---\n$/);
		assert.match(body, /## 仕様の確認（レビュー中にユーザーが決めたこと）\n\nなし/);
	});

	it("ベースラインの除外・不安定なテスト・仕様の確認の回答を載せる", () => {
		const body = renderTemplate(
			tpl("pr"),
			prVars({
				implementation: "",
				test: { runs: 5, lastResult: "pass" },
				checkCommands: [],
				testChangeReasons: [],
				history: [],
				remaining: [],
				baseline: { at: "", commands: ["npm test", "npm run lint"], failures: [{ command: "npm run lint", killed: false, lines: ["x"], recognized: true }] },
				flaky: [
					{ command: "npm test", killed: false, lines: [], at: "", phase: "impl_tdd" },
					{ command: "npm test", killed: false, lines: [], at: "", phase: "impl_fix_review" },
				],
				specGaps: [
					{ id: "Q1", criterion: "AC-2", question: "空白は？", interpretations: ["a", "b"], round: 1, answer: "空文字" },
					{ id: "Q2", criterion: "AC-3", question: "未回答", interpretations: ["a", "b"], round: 1 },
				],
			}),
		);
		assert.match(body, /- ベースライン: 開始時点ですでに失敗していたため判定から除外 — `npm run lint`/);
		assert.match(body, /- ⚠ 不安定（再実行で合格。修正ループに数えていない）: `npm test`\n/);
		assert.match(body, /## 仕様の確認（レビュー中にユーザーが決めたこと）\n\n- \[AC-2\] 空白は？ → \*\*空文字\*\*\n\n## /);
	});
});
