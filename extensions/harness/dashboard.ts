/**
 * TUI のダッシュボード（入力欄の上に常時表示するウィジェット）の内容を組み立てる（純粋関数）。
 * 作業全体のどこにいるか・いま何をしているか・次に何をするか・ブランチ・トークン/費用・コンテキスト使用率を一目で分かるようにする。
 */
import { describeIssue, type HarnessState, type Phase, reviewMode } from "./state.ts";

export type Color = "accent" | "success" | "warning" | "error" | "muted" | "dim" | "text";
export type Paint = (color: Color, text: string) => string;
const plain: Paint = (_c, t) => t;

export interface DashboardInput {
	state: HarnessState;
	/** いま実行中のこと（ツール・考え中・入力待ちなど） */
	activity?: string;
	branch?: string;
	model?: string;
	thinking?: string;
	/** このセッションのトークンと費用 */
	session: { input: number; output: number; cost: number };
	/** 作業項目（Issue / 要件定義）全体のトークンと費用（このセッションを含む） */
	item?: { tokens: number; cost: number; sessions: number };
	context?: { percent: number | null; tokens: number | null; window: number };
	/** 自動圧縮のしきい値（%） */
	compactAt?: number;
}

interface Step {
	label: string;
	phases: Phase[];
}

const STEPS: Record<"requirements" | "implement" | "bugfix", Step[]> = {
	requirements: [
		{ label: "ヒアリング", phases: ["req_clarify"] },
		{ label: "要件定義書", phases: ["req_document"] },
		{ label: "承認", phases: ["req_approval"] },
		{ label: "Issue 登録", phases: ["req_issues"] },
		{ label: "完了", phases: ["req_done"] },
	],
	implement: [
		{ label: "読込", phases: ["impl_context"] },
		{ label: "プラン", phases: ["impl_plan"] },
		{ label: "承認", phases: ["impl_plan_approval"] },
		{ label: "TDD 実装", phases: ["impl_tdd"] },
		{ label: "レビュー", phases: ["impl_review", "impl_spec_gap", "impl_fix_review"] },
		{ label: "完了", phases: ["impl_done"] },
	],
	bugfix: [
		{ label: "再現", phases: ["bug_reproduce"] },
		{ label: "分析", phases: ["bug_analyze"] },
		{ label: "修正", phases: ["bug_fix"] },
		{ label: "完了", phases: ["bug_done"] },
	],
};

/** フェーズごとの「次にやること」の短い説明 */
const NEXT: Partial<Record<Phase, string>> = {
	req_clarify: "仕様が固まるまで質問 → hearing.md",
	req_document: "要件定義書・Issue 分割案を作成 → 承認依頼",
	req_approval: "あなたの承認待ち",
	req_issues: "Issue を登録",
	req_done: "/impl next または「次の Issue をやって」",
	impl_context: "Issue とコードを読む",
	impl_plan: "テスト/実装プランを作成 → 承認依頼",
	impl_plan_approval: "あなたの承認待ち",
	impl_tdd: "Red → Green → Refactor を繰り返す → 実装レポート",
	impl_review: "レビューして結果を記録",
	impl_spec_gap: "仕様の確認: あなたの回答待ち",
	impl_fix_review: "指摘を修正 → 全テスト green → fix レポート",
	impl_done: "完了（コミット・PR を確認）",
	bug_reproduce: "再現テストを書いて失敗を確認",
	bug_analyze: "根本原因を分析（コード変更なし）",
	bug_fix: "最小限の修正 → 全テスト green",
	bug_done: "完了（実装フローへ合流）",
};

const FLOW_LABEL = { requirements: "要件定義", implement: "TDD 実装", bugfix: "バグ修正" } as const;

export function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

export function formatCost(usd: number): string {
	return usd >= 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(3)}`;
}

/** 作業全体の工程と現在位置（✓ 完了 / ▶ 現在 / ○ 未着手） */
export function stepsLine(s: HarnessState, paint: Paint = plain): string {
	if (!s.flow) return "";
	const steps = STEPS[s.flow];
	const phase = s.phase === "escalated" ? (s.escalation?.phase ?? s.phase) : s.phase;
	const current = steps.findIndex((st) => st.phases.includes(phase));
	const parts = steps.map((st, i) => {
		let label = st.label;
		if (st.label === "レビュー" && (s.review.round > 0 || phase === "impl_review" || phase === "impl_fix_review")) {
			label =
				phase === "impl_fix_review"
					? `レビュー ${s.review.round}/${s.review.max}（修正中）`
					: phase === "impl_spec_gap"
						? `レビュー ${s.review.round}/${s.review.max}（仕様の確認中）`
						: `レビュー ${s.review.round + (i === current ? 1 : 0)}/${s.review.max}`;
		}
		if (i < current || (i === current && st.label === "完了")) return paint("success", `✓ ${label}`);
		if (i === current) return paint(s.phase === "escalated" ? "error" : "accent", `${s.phase === "escalated" ? "⚠" : "▶"} ${label}`);
		return paint("dim", `○ ${label}`);
	});
	const tail = s.flow === "bugfix" && s.suspended ? paint("muted", ` → 合流: ${describeIssue(s.suspended.issue)}`) : "";
	return parts.join(paint("dim", " › ")) + tail;
}

export function renderDashboard(d: DashboardInput, paint: Paint = plain): string[] {
	const s = d.state;
	const sep = paint("dim", " │ ");
	const lines: string[] = [];
	const branch = d.branch ? `${paint("muted", "⎇")} ${d.branch}` : "";

	if (!s.flow || s.phase === "idle") {
		lines.push(
			[paint("accent", "🧭 piHarness"), "待機中", branch, paint("muted", "話しかけて開始: 作りたいもの / 実装したい Issue / 直したい不具合")]
				.filter(Boolean)
				.join(sep),
		);
	} else {
		const target = s.issue ? describeIssue(s.issue) : s.bug ? s.bug.description : (s.topic ?? "");
		lines.push([paint("accent", `🧭 ${FLOW_LABEL[s.flow]}`), target.slice(0, 50), branch].filter(Boolean).join(sep));
		lines.push(stepsLine(s, paint));

		const phase = s.phase === "escalated" ? s.escalation?.phase : s.phase;
		const now = d.activity ?? "入力待ち";
		if (s.phase === "escalated") {
			lines.push(paint("error", `⚠ エスカレーション中: ${(s.escalation?.detail ?? "").slice(0, 60)}`) + sep + paint("muted", "「ループを続けて」「バグ修正して」「やめたい」"));
		} else if (s.pendingHandoff) {
			lines.push(paint("warning", `↪ 次のセッションを開始します`));
		} else {
			lines.push(`${paint("accent", "▶ いま")} ${now}${sep}${paint("muted", "次:")} ${phase ? (NEXT[phase] ?? "") : ""}`);
		}

		const loops: string[] = [];
		if (s.flow !== "requirements") {
			const f = s.test.failures;
			loops.push(paint(f === 0 ? "muted" : f >= s.test.max - 1 ? "error" : "warning", `テスト修正 ${f}/${s.test.max}`));
		}
		if (s.flow === "implement") loops.push(paint("muted", `レビュー ${s.review.round}/${s.review.max}（次: ${reviewMode(s) === "full" ? "フル" : "軽量"}）`));
		if (s.test.lastResult) loops.push(paint(s.test.lastResult === "pass" ? "success" : "error", `直近のテスト ${s.test.lastResult === "pass" ? "PASS" : "FAIL"}`));
		if (s.test.dirty) loops.push(paint("warning", "未テストの変更あり"));
		if (loops.length) lines.push(loops.join(sep));
	}

	// トークン・費用・コンテキスト・モデル
	const usage: string[] = [];
	usage.push(`${paint("muted", "このセッション")} 入 ${formatTokens(d.session.input)} / 出 ${formatTokens(d.session.output)} ${formatCost(d.session.cost)}`);
	if (d.item && d.item.sessions > 0) usage.push(`${paint("muted", "作業合計")} ${formatTokens(d.item.tokens)} ${formatCost(d.item.cost)}（${d.item.sessions} セッション）`);
	if (d.context?.percent != null) {
		const p = Math.round(d.context.percent);
		const color: Color = d.compactAt && p >= d.compactAt ? "error" : d.compactAt && p >= d.compactAt * 0.8 ? "warning" : "muted";
		usage.push(paint(color, `コンテキスト ${p}%${d.compactAt ? `（圧縮 ${d.compactAt}%）` : ""}`));
	}
	if (d.model) usage.push(paint("dim", `${d.model}${d.thinking && d.thinking !== "off" ? ` · ${d.thinking}` : ""}`));
	lines.push(usage.join(sep));
	return lines;
}

/** ツール呼び出しから「いま何をしているか」の短い説明を作る */
export function describeActivity(toolName: string, args: Record<string, unknown> | undefined): string {
	const a = args ?? {};
	const str = (v: unknown, max = 50) => (typeof v === "string" ? (v.length > max ? `${v.slice(0, max)}…` : v) : "");
	switch (toolName) {
		case "harness_run_tests":
			return `🧪 テスト実行中（${a.expect === "red" ? "Red: 失敗を確認" : "Green: 全体 + チェック"}）`;
		case "harness_ask":
			return "❓ あなたに質問中";
		case "harness_request_approval":
			return "⏸ あなたの承認待ち";
		case "harness_record_review":
			return "📝 レビュー結果を記録中";
		case "harness_request_test_change":
			return "⏸ テストの変更の承認待ち";
		case "harness_create_issues":
			return "📋 Issue を登録中";
		case "harness_phase":
			return `➡ 次の工程へ（${str(a.to)}）`;
		case "harness_control":
			return "🧭 あなたの確認待ち";
		case "harness_status":
			return "🔎 状態を確認中";
		case "read":
			return `📖 読込: ${str(a.path)}`;
		case "edit":
		case "write":
			return `✏️ 編集: ${str(a.path)}`;
		case "bash":
			return `$ ${str(a.command)}`;
		case "grep":
		case "find":
		case "ls":
			return `🔎 検索: ${str(a.pattern ?? a.path)}`;
		default:
			return `🔧 ${toolName}`;
	}
}
