/**
 * Issue・PR・レビュー記録を、テンプレートから組み立てる。
 * エージェントには構造化した項目だけを渡させ、見出しや並びはテンプレートで固定して毎回のブレをなくす。
 * テンプレートはプロジェクトの `<workDir>/templates/<名前>.md` があればそれを、無ければ piHarness 同梱の `templates/` を使う。
 * 読み込み以外は純粋関数。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { IssueDraft } from "./issues.ts";
import type { Baseline, FlakyRecord, ReviewFinding, ReviewRound, SpecGap } from "./state.ts";

export type TemplateName = "issue" | "pr" | "review" | "adr" | "pr-docs";
export const TEMPLATE_NAMES: TemplateName[] = ["issue", "pr", "review", "adr", "pr-docs"];

const NONE = "なし";

/** 使うテンプレートの場所（プロジェクトの上書きが優先） */
export function templatePath(cwd: string, workDir: string, builtinDir: string, name: TemplateName): { path: string; source: "project" | "builtin" } {
	const project = join(cwd, workDir, "templates", `${name}.md`);
	if (existsSync(project)) return { path: project, source: "project" };
	return { path: join(builtinDir, `${name}.md`), source: "builtin" };
}

export function loadTemplate(cwd: string, workDir: string, builtinDir: string, name: TemplateName): string {
	return readFileSync(templatePath(cwd, workDir, builtinDir, name).path, "utf8");
}

/**
 * `{{名前}}` を値で置き換える。テンプレート内の HTML コメントは説明用なので取り除く。
 * 値が無い・空のプレースホルダーは「なし」にする（見出しの並びを毎回同じにするため）。
 * `{{名前?}}` と書いたものだけは、空なら何も出さない（末尾の Closes 行など）。
 */
export function renderTemplate(template: string, vars: Record<string, string | undefined>): string {
	return (
		template
			.replace(/<!--[\s\S]*?-->\n?/g, "")
			.replace(/\{\{\s*(\w+)(\?)?\s*\}\}/g, (_m, key: string, optional?: string) => vars[key]?.trim() || (optional ? "" : NONE))
			.replace(/\n{3,}/g, "\n\n")
			.trim() + "\n"
	);
}

function bullets(items: string[] | undefined, prefix = "- "): string {
	const list = (items ?? []).map((s) => s.trim()).filter(Boolean);
	return list.length ? list.map((s) => `${prefix}${s}`).join("\n") : NONE;
}

// ---------------------------------------------------------------------------
// Issue
// ---------------------------------------------------------------------------

/** Issue 本文の値。依存 Issue は作成済みの番号（無ければタイトル）で示す */
export function issueVars(draft: IssueDraft, dependencies: { number?: number; title: string }[]): Record<string, string> {
	return {
		title: draft.title,
		background: draft.background,
		inScope: bullets(draft.inScope),
		outOfScope: bullets(draft.outOfScope),
		acceptanceCriteria: draft.acceptanceCriteria.map((c, i) => `- [ ] AC-${i + 1}: ${c.trim()}`).join("\n"),
		testNormal: bullets(draft.testNormal),
		testEdge: bullets(draft.testEdge),
		dependencies: dependencies.length
			? `以下の Issue の完了後に着手してください。\n\n${dependencies.map((d) => `- ${d.number ? `#${d.number}` : d.title}`).join("\n")}`
			: NONE,
		references: bullets(draft.references),
		notes: draft.notes ?? "",
		size: draft.size ?? "",
	};
}

// ---------------------------------------------------------------------------
// レビュー記録
// ---------------------------------------------------------------------------

/** フルレビューで必ず確認する観点（skills/harness-review と同じ並び） */
export const REVIEW_PERSPECTIVES: [string, string][] = [
	["requirements", "要件"],
	["correctness", "正しさ"],
	["tests", "テスト"],
	["security", "セキュリティ"],
	["performance", "性能"],
	["maintainability", "保守性"],
	["operability", "運用性"],
];

/** ドキュメントのフルレビューで必ず確認する観点（skills/harness-doc-review と同じ並び） */
export const DOC_REVIEW_PERSPECTIVES: [string, string][] = [
	["accuracy", "正確さ"],
	["completeness", "網羅性"],
	["clarity", "分かりやすさ"],
	["structure", "構成"],
	["consistency", "一貫性"],
	["examples", "手順・例"],
	["links", "リンク・参照"],
];

type Perspectives = [string, string][];

const SEVERITIES = ["blocker", "major", "minor", "nit"] as const;

function perspectiveLabel(p: string, list: Perspectives = REVIEW_PERSPECTIVES): string {
	const hit = list.find(([k]) => k === p);
	return hit ? `${hit[1]}（${hit[0]}）` : p;
}

export function severityCounts(findings: ReviewFinding[], blocking: string[]): string {
	const counts = SEVERITIES.map((s) => `${s} ${findings.filter((f) => f.severity === s).length}`).join(" / ");
	const must = findings.filter((f) => blocking.includes(f.severity)).length;
	return `${counts}（修正必須 ${must} 件）`;
}

function perspectiveTable(findings: ReviewFinding[], mode: "full" | "light", list: Perspectives): string {
	if (mode === "light") {
		const touched = [...new Set(findings.map((f) => f.perspective))];
		const note = "軽量レビューのため、前回の指摘の解消と前回レビュー以降の差分だけを確認しました。";
		if (touched.length === 0) return note;
		return `${note}\n\n| 観点 | 指摘 |\n|---|---|\n${touched.map((p) => `| ${perspectiveLabel(p, list)} | ${findings.filter((f) => f.perspective === p).length} 件 |`).join("\n")}`;
	}
	const keys = [...list.map(([k]) => k), ...new Set(findings.map((f) => f.perspective).filter((p) => !list.some(([k]) => k === p)))];
	const rows = keys.map((k) => {
		const n = findings.filter((f) => f.perspective === k).length;
		return `| ${perspectiveLabel(k, list)} | ${n ? `${n} 件` : "指摘なし"} |`;
	});
	return `| 観点 | 結果 |\n|---|---|\n${rows.join("\n")}`;
}

export function findingsMarkdown(findings: ReviewFinding[], blocking: string[], list: Perspectives = REVIEW_PERSPECTIVES): string {
	if (findings.length === 0) return NONE;
	return findings
		.map((f, i) => {
			const must = blocking.includes(f.severity);
			const where = f.file ? `\`${f.file}${f.line ? `:${f.line}` : ""}\`` : "（特定の場所なし）";
			return [
				`### ${i + 1}. [${f.severity}${must ? " 🔴" : ""}] ${f.title}`,
				"",
				`- 観点: ${perspectiveLabel(f.perspective, list)}`,
				`- 場所: ${where}`,
				`- 修正必須: ${must ? "はい" : "いいえ"}`,
				"",
				`**内容:** ${f.detail.trim()}`,
				"",
				`**修正案:** ${f.suggestion?.trim() || NONE}`,
			].join("\n");
		})
		.join("\n\n");
}

/** 仕様の確認（spec_gap）の一覧。回答があれば一緒に載せる */
export function specGapsMarkdown(gaps: SpecGap[]): string {
	if (gaps.length === 0) return NONE;
	return gaps
		.map((g) =>
			[
				`### ${g.id}. [${g.criterion}] ${g.question}`,
				"",
				...g.interpretations.map((x, i) => `- 解釈 ${i + 1}: ${x}`),
				...(g.evidence ? [`- 箇所: \`${g.evidence}\``] : []),
				`- 回答: ${g.answer ?? "（ユーザーの回答待ち）"}`,
			].join("\n"),
		)
		.join("\n\n");
}

export function reviewVars(args: {
	round: number;
	mode: "full" | "light";
	target: string;
	at: string;
	summary: string;
	findings: ReviewFinding[];
	blocking: string[];
	specGaps?: SpecGap[];
	/** フルレビューで必ず確認する観点（既定はコードの観点） */
	perspectives?: Perspectives;
}): Record<string, string> {
	const list = args.perspectives ?? REVIEW_PERSPECTIVES;
	const must = args.findings.filter((f) => args.blocking.includes(f.severity)).length;
	return {
		round: String(args.round),
		mode: args.mode === "full" ? "フルレビュー" : "軽量レビュー",
		target: args.target,
		date: args.at,
		verdict: args.specGaps?.length
			? `❓ 仕様の確認が必要（${args.specGaps.length} 件）${must ? `・🔴 修正必須 ${must} 件` : ""}`
			: must
				? `🔴 修正が必要（修正必須 ${must} 件）`
				: "✅ 修正必須の指摘なし",
		counts: severityCounts(args.findings, args.blocking),
		summary: args.summary,
		perspectives: perspectiveTable(args.findings, args.mode, list),
		findings: findingsMarkdown(args.findings, args.blocking, list),
		specGaps: specGapsMarkdown(args.specGaps ?? []),
	};
}

// ---------------------------------------------------------------------------
// PR
// ---------------------------------------------------------------------------

/**
 * Markdown から見出し（`## 概要` など、前方一致）の本文を取り出す。
 * 同じか上のレベルの次の見出しまで。説明用のコメントは除く。空なら undefined。
 */
export function extractSection(markdown: string, heading: string): string | undefined {
	const lines = markdown.split("\n");
	const start = lines.findIndex((l) => {
		const m = l.match(/^(#{1,6})\s+(.*)$/);
		return !!m && m[2].trim().startsWith(heading);
	});
	if (start < 0) return undefined;
	const level = lines[start].match(/^#+/)![0].length;
	const body: string[] = [];
	for (const line of lines.slice(start + 1)) {
		const m = line.match(/^(#{1,6})\s/);
		if (m && m[1].length <= level) break;
		body.push(line);
	}
	const text = body.join("\n").replace(/<!--[\s\S]*?-->/g, "").trim();
	// テンプレートのままの空の表・空の箇条書きは未記入として扱う
	const meaningful = text
		.split("\n")
		.filter((l) => l.trim() && !/^\|?[\s|:-]*\|?$/.test(l.trim()) && !/^[-*]\s*$/.test(l.trim()));
	const headerOnlyTable = meaningful.length === 1 && meaningful[0].trim().startsWith("|");
	return meaningful.length && !headerOnlyTable ? text : undefined;
}

export function prVars(args: {
	implementation: string;
	issue?: { number?: number; title: string; url?: string };
	test: { runs: number; lastResult?: "pass" | "fail" };
	checkCommands: string[];
	testCommand?: string;
	testChangeReasons: string[];
	history: ReviewRound[];
	remaining: ReviewFinding[];
	usage?: string;
	baseline?: Baseline;
	flaky?: FlakyRecord[];
	specGaps?: SpecGap[];
	/** この作業で記録した ADR（cwd からの相対パス） */
	adrs?: string[];
}): Record<string, string> {
	const impl = args.implementation;
	const section = (h: string) => extractSection(impl, h) ?? "（実装レポートに記載なし）";
	const issue = issueLine(args.issue);
	const head = [
		`- 最終結果: ${args.test.lastResult === "pass" ? "✅ 合格" : args.test.lastResult === "fail" ? "❌ 不合格" : "未実行"}（piHarness が実行。テスト実行 ${args.test.runs} 回）`,
		args.testCommand ? `- テストコマンド: \`${args.testCommand}\`` : "",
		args.checkCommands.length ? `- チェック: ${args.checkCommands.map((c) => `\`${c}\``).join(", ")}` : "",
	].filter(Boolean);
	if (args.baseline?.failures.length) {
		head.push(`- ベースライン: 開始時点ですでに失敗していたため判定から除外 — ${args.baseline.failures.map((f) => `\`${f.command}\``).join(", ")}`);
	}
	const flaky = [...new Set((args.flaky ?? []).map((f) => f.command))];
	if (flaky.length) head.push(`- ⚠ 不安定（再実行で合格。修正ループに数えていない）: ${flaky.map((c) => `\`${c}\``).join(", ")}`);
	const detail = extractSection(impl, "テスト結果");
	const tests = detail ? `${head.join("\n")}\n\n${detail}` : head.join("\n");
	const answered = (args.specGaps ?? []).filter((g) => g.answer);
	return {
		summary: section("概要"),
		issue,
		acceptance: section("受け入れ条件の充足"),
		changes: section("変更ファイル"),
		tests,
		testChanges: bullets(args.testChangeReasons),
		reviews: reviewHistoryMarkdown(args.history, args.remaining),
		deviations: extractSection(impl, "プランからの逸脱") ?? NONE,
		reviewFocus: extractSection(impl, "レビューで特に見てほしい点") ?? NONE,
		limitations: extractSection(impl, "既知の制約") ?? NONE,
		specDecisions: answered.length ? answered.map((g) => `- [${g.criterion}] ${g.question} → **${g.answer}**`).join("\n") : NONE,
		adrs: adrList(args.adrs),
		usage: args.usage ?? "",
		closes: args.issue?.number ? `Closes #${args.issue.number}` : "",
	};
}

function issueLine(issue?: { number?: number; title: string; url?: string }): string {
	return issue ? `${issue.number ? `#${issue.number} ` : ""}${issue.title}${issue.url && !issue.number ? `（${issue.url}）` : ""}` : NONE;
}

/** レビューの周回の表と、残した軽微な指摘 */
function reviewHistoryMarkdown(history: ReviewRound[], remaining: ReviewFinding[]): string {
	const rounds = history.length
		? `| 周回 | 種別 | 修正必須 | 全指摘 |\n|---|---|---|---|\n${history
				.map((h) => `| ${h.round} | ${h.mode === "full" ? "フル" : "軽量"} | ${h.blocking} 件 | ${h.total} 件 |`)
				.join("\n")}`
		: NONE;
	const rest = remaining.length
		? `\n\n**残した軽微な指摘**\n\n${remaining.map((f) => `- [${f.severity}] ${f.title}${f.file ? `（\`${f.file}${f.line ? `:${f.line}` : ""}\`）` : ""}`).join("\n")}`
		: "";
	return rounds + rest;
}

function adrList(adrs: string[] | undefined): string {
	return bullets(
		(adrs ?? []).map((path) => {
			const n = path.split("/").pop()?.match(/^(\d{4})-/)?.[1];
			return n ? `ADR-${n}（\`${path}\`）` : `\`${path}\``;
		}),
	);
}

/**
 * ドキュメント作成フローの PR 本文（templates/pr-docs.md）の値。
 * 概要・ファイル・情報源などは執筆レポート（doc-report.md）の同名の見出しから取る。
 */
export function docPrVars(args: {
	report: string;
	issue?: { number?: number; title: string; url?: string };
	topic?: string;
	changedFiles: string[];
	history: ReviewRound[];
	remaining: ReviewFinding[];
	usage?: string;
}): Record<string, string> {
	const section = (h: string) => extractSection(args.report, h) ?? "（執筆レポートに記載なし）";
	return {
		summary: section("概要"),
		issue: args.issue ? issueLine(args.issue) : (args.topic ?? NONE),
		files: section("作成・更新したファイル"),
		changedFiles: bullets(args.changedFiles.map((f) => `\`${f}\``)),
		sources: section("確認した情報源"),
		reviews: reviewHistoryMarkdown(args.history, args.remaining),
		reviewFocus: extractSection(args.report, "レビューで特に見てほしい点") ?? NONE,
		limitations: extractSection(args.report, "未確定") ?? NONE,
		usage: args.usage ?? "",
		closes: args.issue?.number ? `Closes #${args.issue.number}` : "",
	};
}
