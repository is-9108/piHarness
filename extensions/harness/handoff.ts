/**
 * プロセス間の引き継ぎ（純粋関数）。
 *
 * 各プロセスは独立したセッションで実行し、前のプロセスの会話は引き継がない。
 * 連携は作業ディレクトリ (itemDir) 配下の md ファイルだけで行う。
 * ここでは「どのファイルが入力で、何を出力すべきか」と、新セッションの最初のメッセージを組み立てる。
 */
import { join } from "node:path";
import {
	describeIssue,
	type HarnessState,
	type Phase,
	type ProcessKind,
	processOf,
	reviewMode,
} from "./state.ts";

export interface ArtifactPaths {
	dir: string;
	issue: string;
	qa: string;
	hearing: string;
	openQuestions: string;
	plan: string;
	implementation: string;
	review: (round: number) => string;
	fix: (round: number) => string;
	bug: (n: number) => string;
	escalation: (n: number) => string;
	handoff: string;
	testChanges: string;
	usage: string;
	delta: (round: number) => string;
	logs: string;
}

export function artifactPaths(itemDir: string): ArtifactPaths {
	return {
		dir: itemDir,
		issue: join(itemDir, "issue.md"),
		qa: join(itemDir, "qa.md"),
		hearing: join(itemDir, "hearing.md"),
		openQuestions: join(itemDir, "open-questions.md"),
		plan: join(itemDir, "plan.md"),
		implementation: join(itemDir, "implementation.md"),
		review: (r) => join(itemDir, `review-${r}.md`),
		fix: (r) => join(itemDir, `fix-${r}.md`),
		bug: (n) => join(itemDir, `bug-${n}.md`),
		escalation: (n) => join(itemDir, `escalation-${n}.md`),
		handoff: join(itemDir, "handoff.md"),
		testChanges: join(itemDir, "test-changes.md"),
		usage: join(itemDir, "usage.json"),
		delta: (r) => join(itemDir, `delta-${r}.diff`),
		logs: join(itemDir, "logs"),
	};
}

export function pathsOf(s: HarnessState): ArtifactPaths {
	if (!s.itemDir) throw new Error("作業ディレクトリが未設定です（フローが開始されていません）。");
	return artifactPaths(s.itemDir);
}

/**
 * プロセスを終えて次へ進む前に必要な成果物。次のセッションはこのファイルしか読めないため、無ければ遷移を拒否する。
 */
export function requiredArtifact(s: HarnessState, to: Phase): { path: string; template: string } | undefined {
	if (!s.itemDir) return undefined;
	const p = artifactPaths(s.itemDir);
	if (s.phase === "req_clarify" && to === "req_document") {
		return { path: p.hearing, template: "skill harness-hearing の templates/hearing.md" };
	}
	if (s.phase === "req_document" && to === "req_clarify") {
		return { path: p.openQuestions, template: "未確定の論点を箇条書きにした Markdown" };
	}
	if (s.phase === "impl_tdd" && to === "impl_review") {
		return { path: p.implementation, template: "skill harness-tdd の templates/implementation.md" };
	}
	if (s.phase === "impl_fix_review" && to === "impl_review") {
		return { path: p.fix(s.review.round), template: "skill harness-fix の templates/fix-report.md" };
	}
	if (s.phase === "bug_fix" && to === "bug_done") {
		return { path: p.bug(s.counters.bugs), template: "skill harness-bugfix の templates/bug-report.md" };
	}
	return undefined;
}

export const PROCESS_LABELS: Record<ProcessKind, string> = {
	hearing: "要件ヒアリング",
	requirements: "要件定義書作成",
	issues: "Issue 登録",
	plan: "テスト/実装プラン作成",
	implement: "TDD 実装",
	review: "コードレビュー",
	fix: "レビュー指摘修正",
	bugfix: "バグ修正",
};

const SKILL_OF: Record<ProcessKind, string> = {
	hearing: "harness-hearing",
	requirements: "harness-requirements",
	issues: "harness-issues",
	plan: "harness-plan",
	implement: "harness-tdd",
	review: "harness-review",
	fix: "harness-fix",
	bugfix: "harness-bugfix",
};

/** プロセスに対応するスキル。レビューは 1 周目（フル）と 2 周目以降（軽量）で別のスキルにして読み込み量を減らす */
export function skillFor(s: HarnessState, proc: ProcessKind): string {
	if (proc === "review" && reviewMode(s) === "light") return "harness-review-light";
	return SKILL_OF[proc];
}

export interface ProcessIO {
	process: ProcessKind;
	/** 最初に読むべき成果物（存在するもののみ） */
	inputs: { path: string; why: string }[];
	/** 必要なときだけ参照する成果物（存在するもののみ）。読み込み量を抑えるため必読から分けている */
	references: { path: string; why: string }[];
	/** このプロセスで作る成果物 */
	outputs: { path: string; why: string }[];
}

/** 現在のプロセスの入出力。exists はファイルの存在確認（テストでは差し替える） */
export function processIO(s: HarnessState, exists: (path: string) => boolean): ProcessIO | undefined {
	const proc = processOf(s);
	if (!proc || !s.itemDir) return undefined;
	const p = artifactPaths(s.itemDir);
	const inputs: ProcessIO["inputs"] = [];
	const references: ProcessIO["references"] = [];
	const outputs: ProcessIO["outputs"] = [];
	const seen = new Set<string>();
	const push = (list: ProcessIO["inputs"], path: string | undefined, why: string) => {
		if (path && exists(path) && !seen.has(path)) {
			seen.add(path);
			list.push({ path, why });
		}
	};
	const add = (path: string | undefined, why: string) => push(inputs, path, why);
	const ref = (path: string | undefined, why: string) => push(references, path, why);
	const bugs = (to: typeof add) => {
		for (let n = 1; n <= s.counters.bugs; n++) to(p.bug(n), `バグレポート #${n}`);
	};

	switch (proc) {
		case "hearing":
			add(p.openQuestions, "要件定義書作成で見つかった未確定の論点（最優先で確認する）");
			add(p.hearing, "これまでに確定した仕様のまとめ");
			ref(p.qa, "これまでの質問と回答の生ログ");
			for (const d of s.artifacts.docs) ref(d, "作成中の要件ドキュメント");
			outputs.push({ path: p.hearing, why: "確定した仕様のまとめ（要件定義書作成へ進む前に必須）" });
			break;
		case "requirements":
			add(p.hearing, "ヒアリングで確定した仕様のまとめ");
			for (const d of s.artifacts.docs) add(d, "作成中の要件ドキュメント");
			ref(p.qa, "質問と回答の生ログ（根拠の確認用）");
			outputs.push({ path: "docs/requirements/<slug>.md ほか", why: "要件定義書・設計概要・Issue 分割案（承認対象）" });
			outputs.push({ path: p.openQuestions, why: "大きな未確定事項が見つかった場合のみ。ヒアリングへ戻る前に必須" });
			break;
		case "issues":
			for (const d of s.artifacts.docs) add(d, "承認済みの要件ドキュメント（Issue 分割案を含む）");
			ref(p.hearing, "ヒアリングで確定した仕様のまとめ");
			outputs.push({ path: "GitHub Issue（または docs/issues/*.md）", why: "機能単位の Issue" });
			break;
		case "plan":
			add(p.issue, "対象 Issue の本文");
			outputs.push({ path: p.plan, why: "テストプラン + 実装プラン（承認対象）" });
			break;
		case "implement":
			add(p.issue, "対象 Issue の本文");
			add(p.plan, "承認済みのテスト/実装プラン");
			outputs.push({ path: p.implementation, why: "実装レポート（レビュー担当への引き継ぎ。レビューへ進む前に必須）" });
			break;
		case "review":
			if (reviewMode(s) === "light" && exists(p.review(s.review.round))) {
				// 軽量レビュー: 前回の指摘・対応記録・前回レビュー以降の差分だけを読む
				add(p.review(s.review.round), `前回（${s.review.round} 周目）のレビュー記録`);
				add(p.fix(s.review.round), `前回の指摘への対応記録`);
				add(p.delta(s.review.round + 1), "前回レビュー以降の差分（これを中心に確認する）");
				add(p.testChanges, "テストの削除・スキップ等とその理由（新しい記録があれば検証する）");
				ref(p.implementation, "実装レポート");
				ref(p.plan, "承認済みのテスト/実装プラン");
				ref(p.issue, "対象 Issue の本文");
			} else {
				add(p.issue, "対象 Issue の本文");
				add(p.plan, "承認済みのテスト/実装プラン");
				add(p.implementation, "実装レポート");
				bugs(add);
				add(p.testChanges, "テストの削除・スキップ・アサーション減少と、その理由（妥当か必ず検証する）");
				for (let r = 1; r <= s.review.round; r++) {
					ref(p.review(r), `レビュー ${r} 周目の記録`);
					ref(p.fix(r), `レビュー ${r} 周目の指摘への対応記録`);
				}
			}
			outputs.push({ path: p.review(s.review.round + 1), why: "レビュー記録（harness_record_review が書き出す）" });
			break;
		case "fix":
			add(p.review(s.review.round), "修正対象のレビュー記録");
			ref(p.implementation, "実装レポート");
			ref(p.plan, "承認済みのテスト/実装プラン");
			ref(p.issue, "対象 Issue の本文");
			for (let r = 1; r < s.review.round; r++) ref(p.fix(r), `レビュー ${r} 周目の対応記録`);
			outputs.push({ path: p.fix(s.review.round), why: "指摘ごとの対応記録（レビューへ戻る前に必須）" });
			break;
		case "bugfix":
			add(p.escalation(s.counters.escalations), `エスカレーション記録 #${s.counters.escalations}`);
			add(s.test.lastLog, "直近のテストログ");
			add(p.bug(s.counters.bugs), "作成中のバグレポート");
			for (let n = s.counters.escalations - 1; n >= 1; n--) ref(p.escalation(n), `エスカレーション記録 #${n}`);
			ref(p.issue, "実装中の Issue の本文");
			ref(p.plan, "承認済みのテスト/実装プラン");
			ref(p.implementation, "実装レポート");
			if (s.review.round > 0) ref(p.review(s.review.round), "直近のレビュー記録");
			outputs.push({ path: p.bug(s.counters.bugs), why: "バグレポート（完了前に必須）" });
			break;
	}
	return { process: proc, inputs, references, outputs };
}

/** セッション開始メッセージの目印（拡張が状態表示の重複注入を避けるために使う） */
export const KICKOFF_MARKER = "[piHarness] プロセス「";

/** 新しいセッションの最初のメッセージ（スキルを展開し、入力/出力の成果物を明示する） */
export function kickoffMessage(s: HarnessState, exists: (path: string) => boolean, userNote?: string): string {
	const io = processIO(s, exists);
	if (!io) throw new Error("アクティブなプロセスがありません。");
	const skill = skillFor(s, io.process);
	const lines: string[] = [];
	// Pi は "/skill:<name> <引数>" の最初の空白でスキル名を区切るため、改行ではなく空白で続ける
	lines.push(`/skill:${skill} ${KICKOFF_MARKER}${PROCESS_LABELS[io.process]}」をこの新しいセッションで開始します。`);
	lines.push("前のプロセスの会話は引き継がれていません。以下の成果物だけを入力として作業してください（推測で補わない）。");
	lines.push("");
	if (s.topic) lines.push(`テーマ: ${s.topic}`);
	if (s.issue) lines.push(`対象 Issue: ${describeIssue(s.issue)}${s.issue.url ? ` ${s.issue.url}` : ""}`);
	if (s.bug) lines.push(`バグ: ${s.bug.description}`);
	lines.push(`作業ディレクトリ: ${s.itemDir}/`);
	const diff = diffInstruction(s);
	if (diff) lines.push(diff);
	lines.push("");
	lines.push("## 入力（最初にすべて読むこと）");
	lines.push(...(io.inputs.length ? io.inputs.map((i) => `- ${i.path} — ${i.why}`) : ["- （なし）"]));
	if (io.references.length) {
		lines.push("");
		lines.push("## 参照（必要なときだけ読む）");
		lines.push(...io.references.map((i) => `- ${i.path} — ${i.why}`));
	}
	lines.push("");
	lines.push("## このプロセスの成果物");
	lines.push(...io.outputs.map((o) => `- ${o.path} — ${o.why}`));
	const approval = io.process === "implement" ? s.approvals.plan : io.process === "issues" ? s.approvals.requirements : undefined;
	if (approval?.comment) {
		lines.push("");
		lines.push(`承認時のユーザーコメント: ${approval.comment}`);
	}
	if (userNote) {
		lines.push("");
		lines.push(`ユーザーからの指示: ${userNote}`);
	}
	return lines.join("\n");
}

/** コードを扱うプロセスで、どこからの差分を見るべきかの案内 */
export function diffInstruction(s: HarnessState): string | undefined {
	const proc = processOf(s);
	if (!s.git?.base || !proc || !["implement", "review", "fix", "bugfix"].includes(proc)) return undefined;
	const short = s.git.base.slice(0, 12);
	return `変更の差分: \`git diff ${short}\`（実装開始時点 ${short} からの変更。未コミット分を含む）と \`git status\`（新規ファイル）${s.git.branch ? `／作業ブランチ: ${s.git.branch}` : ""}`;
}

/** handoff.md に追記する 1 件分の記録 */
export function handoffRecord(s: HarnessState, exists: (path: string) => boolean): string {
	const io = processIO(s, exists);
	const from = s.pendingHandoff?.from;
	const to = io?.process;
	return (
		`\n## ${new Date().toISOString()} ${from ? PROCESS_LABELS[from] : "開始"} → ${to ? PROCESS_LABELS[to] : "-"}\n\n` +
		`- フェーズ: ${s.phase}\n` +
		(io?.inputs.length ? `- 入力:\n${io.inputs.map((i) => `  - ${i.path}`).join("\n")}\n` : "") +
		(io?.outputs.length ? `- 出力:\n${io.outputs.map((o) => `  - ${o.path}`).join("\n")}\n` : "")
	);
}

/** エスカレーション記録（バグ修正セッションやユーザー判断の入力になる） */
export function escalationMarkdown(s: HarnessState, n: number): string {
	const e = s.escalation;
	const p = s.itemDir ? artifactPaths(s.itemDir) : undefined;
	const lines = [
		`# エスカレーション #${n}`,
		"",
		`- 日時: ${e?.at ?? ""}`,
		`- フロー / フェーズ: ${e?.flow} / ${e?.phase}`,
		`- 理由: ${e?.reason}`,
		`- 対象: ${describeIssue(s.issue)}`,
		"",
		"## 状況",
		"",
		e?.detail ?? "",
		"",
		"## 参照",
		"",
		`- 直近のテストログ: ${s.test.lastLog ?? "なし"}`,
	];
	if (p && s.review.round > 0) lines.push(`- 直近のレビュー記録: ${p.review(s.review.round)}`);
	if (s.review.lastFindings.length) {
		lines.push("", "## 未解決のレビュー指摘", "");
		for (const f of s.review.lastFindings) lines.push(`- [${f.severity}/${f.perspective}] ${f.title}${f.file ? ` (${f.file})` : ""}`);
	}
	lines.push("", "## 経緯（最近のイベント）", "");
	for (const l of s.log.slice(-15)) lines.push(`- ${l.at} ${l.event}`);
	return `${lines.join("\n")}\n`;
}
