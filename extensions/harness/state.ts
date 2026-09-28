/**
 * piHarness のワークフロー状態機械（純粋関数のみ。Pi ランタイムに依存しない）。
 *
 * 3 つのフローを 1 つの状態で表現する:
 *   1. requirements: 要件定義 → 人間の承認ゲート → Issue 登録
 *   2. implement   : Issue/コード読込 → テスト・実装プラン → 承認 → TDD → テストループ → レビューループ
 *   3. bugfix      : エスカレーション時にユーザー判断で起動する独立したバグ修正フロー（完了後 implement へ合流）
 */

export type FlowKind = "requirements" | "implement" | "bugfix";

export type Phase =
	| "idle"
	// requirements
	| "req_clarify"
	| "req_document"
	| "req_approval"
	| "req_issues"
	| "req_done"
	// implement (TDD)
	| "impl_context"
	| "impl_plan"
	| "impl_plan_approval"
	| "impl_tdd"
	| "impl_review"
	| "impl_fix_review"
	| "impl_done"
	// bugfix
	| "bug_reproduce"
	| "bug_analyze"
	| "bug_fix"
	| "bug_done"
	// 共通
	| "escalated";

export type ApprovalKind = "requirements" | "plan";
export type ApprovalDecision = "approved" | "revise" | "rejected";

export interface ApprovalRecord {
	decision: ApprovalDecision;
	comment?: string;
	documents: string[];
	at: string;
}

export type Severity = "blocker" | "major" | "minor" | "nit";

export interface ReviewFinding {
	severity: Severity;
	perspective: string;
	title: string;
	detail: string;
	file?: string;
	line?: number;
	suggestion?: string;
}

export interface ReviewRound {
	round: number;
	mode: "full" | "light";
	blocking: number;
	total: number;
	summary: string;
	at: string;
}

export interface IssueRef {
	number?: number;
	title: string;
	url?: string;
	file?: string;
}

export type EscalationReason = "test_loop" | "review_loop" | "bugfix_loop" | "manual";

export interface Escalation {
	reason: EscalationReason;
	flow: FlowKind;
	phase: Phase;
	detail: string;
	at: string;
}

/** バグ修正フロー完了後に戻る先（実装フローの退避情報） */
export interface SuspendedImplement {
	phase: Phase;
	issue?: IssueRef;
}

/**
 * セッションを分ける単位。プロセスが変わるときは新しいセッションを開始し、
 * 前のプロセスとの連携は成果物（md ファイル）だけで行う。
 */
export type ProcessKind = "requirements" | "issues" | "plan" | "implement" | "review" | "fix" | "bugfix";

export interface PendingHandoff {
	from: ProcessKind | null;
	to: ProcessKind;
	at: string;
}

export interface HarnessState {
	version: 2;
	flow: FlowKind | null;
	phase: Phase;
	/** 作業項目ごとの成果物ディレクトリ（cwd からの相対パス。例: .pi/harness/issue-12） */
	itemDir?: string;
	/** プロセスが切り替わり、新しいセッションでの開始を待っている */
	pendingHandoff?: PendingHandoff;
	/** 拡張が作成した新しいセッションの開始処理中（そのプロセス用のモデルを適用する目印） */
	kickoff?: ProcessKind;
	/** エスカレーション・バグ修正の通し番号（成果物のファイル名に使用） */
	counters: { escalations: number; bugs: number };
	topic?: string;
	issue?: IssueRef;
	approvals: Partial<Record<ApprovalKind, ApprovalRecord>>;
	test: {
		/** 連続した「green 期待」テスト失敗回数（= 修正ループの周回数） */
		failures: number;
		max: number;
		lastResult?: "pass" | "fail";
		lastExpect?: "red" | "green";
		/** 最後のテスト実行以降に edit/write でファイルが変更されたか */
		dirty: boolean;
		runs: number;
		/** 直近のテストログ（cwd からの相対パス） */
		lastLog?: string;
	};
	review: {
		/** 実施済みレビュー周回数 */
		round: number;
		max: number;
		history: ReviewRound[];
		lastFindings: ReviewFinding[];
	};
	escalation?: Escalation;
	suspended?: SuspendedImplement;
	bug?: { description: string; startedAt: string };
	artifacts: { docs: string[]; plan?: string; issues: IssueRef[] };
	log: { at: string; event: string }[];
}

export interface Limits {
	maxTestLoops: number;
	maxReviewLoops: number;
}

export const DEFAULT_LIMITS: Limits = { maxTestLoops: 3, maxReviewLoops: 3 };

const LOG_LIMIT = 50;

export class TransitionError extends Error {}

export function now(): string {
	return new Date().toISOString();
}

export function initialState(limits: Limits = DEFAULT_LIMITS): HarnessState {
	return {
		version: 2,
		flow: null,
		phase: "idle",
		counters: { escalations: 0, bugs: 0 },
		approvals: {},
		test: { failures: 0, max: limits.maxTestLoops, dirty: false, runs: 0 },
		review: { round: 0, max: limits.maxReviewLoops, history: [], lastFindings: [] },
		artifacts: { docs: [], issues: [] },
		log: [],
	};
}

function clone(s: HarnessState): HarnessState {
	return structuredClone(s);
}

function withLog(s: HarnessState, event: string): HarnessState {
	s.log.push({ at: now(), event });
	if (s.log.length > LOG_LIMIT) s.log.splice(0, s.log.length - LOG_LIMIT);
	return s;
}

export function flowOf(phase: Phase): FlowKind | null {
	if (phase.startsWith("req_")) return "requirements";
	if (phase.startsWith("impl_")) return "implement";
	if (phase.startsWith("bug_")) return "bugfix";
	return null;
}

export function isActive(s: HarnessState): boolean {
	return s.flow !== null && s.phase !== "idle";
}

// ---------------------------------------------------------------------------
// フロー開始
// ---------------------------------------------------------------------------

export function startRequirements(prev: HarnessState, topic: string, limits: Limits, itemDir: string): HarnessState {
	const s = initialState(limits);
	s.itemDir = itemDir;
	s.flow = "requirements";
	s.phase = "req_clarify";
	s.topic = topic;
	s.log = prev.log.slice();
	return withLog(s, `要件定義フロー開始: ${topic || "(テーマ未指定)"}`);
}

export function startImplement(prev: HarnessState, issue: IssueRef, limits: Limits, itemDir: string): HarnessState {
	const s = initialState(limits);
	s.itemDir = itemDir;
	s.flow = "implement";
	s.phase = "impl_context";
	s.issue = issue;
	s.log = prev.log.slice();
	return withLog(s, `実装フロー開始: ${describeIssue(issue)}`);
}

/**
 * バグ修正フローを開始する。実装フロー中（エスカレーション含む）であれば、その状態を退避し完了後に合流する。
 */
export function startBugfix(prev: HarnessState, description: string, limits: Limits, standaloneItemDir: string): HarnessState {
	const s = clone(prev);
	const fromImplement =
		prev.flow === "implement" || (prev.phase === "escalated" && prev.escalation?.flow === "implement");
	if (fromImplement) {
		s.suspended = {
			phase: prev.phase === "escalated" ? (prev.escalation?.phase ?? "impl_tdd") : prev.phase,
			issue: prev.issue,
		};
	} else if (prev.flow === "bugfix" && prev.suspended) {
		// バグ修正フローの再起動: 退避先は維持
	} else {
		s.suspended = undefined;
	}
	// 実装フローからの起動なら同じ作業ディレクトリに bug-N.md を置く
	if (!s.suspended || !s.itemDir) s.itemDir = standaloneItemDir;
	if (!(prev.flow === "bugfix" && prev.bug)) s.counters.bugs += 1;
	s.flow = "bugfix";
	s.phase = "bug_reproduce";
	s.escalation = undefined;
	s.bug = { description, startedAt: now() };
	// 直近のテストログはバグ修正セッションの入力になるため引き継ぐ
	s.test = { failures: 0, max: limits.maxTestLoops, dirty: false, runs: 0, lastLog: prev.test.lastLog };
	return withLog(s, `バグ修正フロー開始: ${description || "(説明なし)"}`);
}

// ---------------------------------------------------------------------------
// 汎用の（ゲートなし）遷移
// ---------------------------------------------------------------------------

/**
 * `harness_phase` ツールで許可される遷移。ここに無い遷移は専用ツール（承認・テスト・レビュー・Issue 登録）経由でのみ行える。
 */
const FREE_TRANSITIONS: Partial<Record<Phase, Phase[]>> = {
	req_clarify: ["req_document"],
	req_document: ["req_clarify"],
	impl_context: ["impl_plan"],
	impl_plan: ["impl_context"],
	bug_reproduce: ["bug_analyze"],
	bug_analyze: ["bug_fix", "bug_reproduce"],
	bug_fix: ["bug_analyze"],
};

/** テスト合格（かつ未変更）を条件に許可される遷移 */
const TEST_GATED_TRANSITIONS: Partial<Record<Phase, Phase[]>> = {
	impl_tdd: ["impl_review"],
	impl_fix_review: ["impl_review"],
	bug_fix: ["bug_done"],
};

export function allowedTransitions(s: HarnessState): Phase[] {
	return [...(FREE_TRANSITIONS[s.phase] ?? []), ...(TEST_GATED_TRANSITIONS[s.phase] ?? [])];
}

export function transition(prev: HarnessState, to: Phase, note?: string): HarnessState {
	const free = FREE_TRANSITIONS[prev.phase] ?? [];
	const gated = TEST_GATED_TRANSITIONS[prev.phase] ?? [];
	if (!free.includes(to) && !gated.includes(to)) {
		const allowed = allowedTransitions(prev);
		throw new TransitionError(
			`${prev.phase} から ${to} へは遷移できません。` +
				(allowed.length ? `許可されている遷移: ${allowed.join(", ")}` : "このフェーズは専用ツールでのみ進められます。"),
		);
	}
	if (gated.includes(to)) {
		if (prev.test.lastResult !== "pass" || prev.test.lastExpect !== "green") {
			throw new TransitionError(
				`${to} へ進むには harness_run_tests (expect: "green") でテストスイート全体が合格している必要があります。`,
			);
		}
		if (prev.test.dirty) {
			throw new TransitionError(
				`最後のテスト合格後にファイルが変更されています。harness_run_tests で再度テストを実行してください。`,
			);
		}
	}
	const s = clone(prev);
	s.phase = to;
	if (to === "impl_review") s.review.lastFindings = [];
	return withLog(s, `${prev.phase} → ${to}${note ? `: ${note}` : ""}`);
}

// ---------------------------------------------------------------------------
// 承認ゲート
// ---------------------------------------------------------------------------

export function beginApproval(prev: HarnessState, kind: ApprovalKind, documents: string[]): HarnessState {
	const expected: Phase[] = kind === "requirements" ? ["req_document", "req_approval"] : ["impl_plan", "impl_plan_approval"];
	if (!expected.includes(prev.phase)) {
		throw new TransitionError(
			`${kind === "requirements" ? "要件定義" : "テスト/実装プラン"}の承認は ${expected[0]} フェーズでのみ依頼できます（現在: ${prev.phase}）。`,
		);
	}
	const s = clone(prev);
	s.phase = kind === "requirements" ? "req_approval" : "impl_plan_approval";
	if (kind === "requirements") s.artifacts.docs = unique([...s.artifacts.docs, ...documents]);
	else if (documents[0]) s.artifacts.plan = documents[0];
	return withLog(s, `${kind === "requirements" ? "要件定義" : "プラン"}の承認待ち`);
}

export function applyApproval(
	prev: HarnessState,
	kind: ApprovalKind,
	decision: ApprovalDecision,
	comment: string | undefined,
	documents: string[],
): HarnessState {
	const waiting: Phase = kind === "requirements" ? "req_approval" : "impl_plan_approval";
	if (prev.phase !== waiting) {
		throw new TransitionError(`承認待ちの状態ではありません（現在: ${prev.phase}）。`);
	}
	const s = clone(prev);
	s.approvals[kind] = { decision, comment, documents, at: now() };
	if (decision === "approved") {
		s.phase = kind === "requirements" ? "req_issues" : "impl_tdd";
	} else if (decision === "revise") {
		s.phase = kind === "requirements" ? "req_document" : "impl_plan";
	} else {
		s.flow = null;
		s.phase = "idle";
	}
	const label = { approved: "承認", revise: "修正依頼", rejected: "却下" }[decision];
	return withLog(s, `${kind === "requirements" ? "要件定義" : "プラン"}: ${label}${comment ? ` (${comment})` : ""}`);
}

export function isApproved(s: HarnessState, kind: ApprovalKind): boolean {
	return s.approvals[kind]?.decision === "approved";
}

// ---------------------------------------------------------------------------
// Issue 登録
// ---------------------------------------------------------------------------

export function canCreateIssues(s: HarnessState): boolean {
	return s.phase === "req_issues" && isApproved(s, "requirements");
}

/** 一部の登録に失敗した場合: 登録済みのものだけ記録し、フェーズは req_issues のまま */
export function appendIssues(prev: HarnessState, issues: IssueRef[]): HarnessState {
	if (!canCreateIssues(prev)) {
		throw new TransitionError("Issue 登録は要件定義が人間に承認された後（req_issues フェーズ）でのみ可能です。");
	}
	const s = clone(prev);
	s.artifacts.issues = [...s.artifacts.issues, ...issues];
	return withLog(s, `Issue を ${issues.length} 件登録（一部失敗）`);
}

export function recordIssues(prev: HarnessState, issues: IssueRef[]): HarnessState {
	if (!canCreateIssues(prev)) {
		throw new TransitionError("Issue 登録は要件定義が人間に承認された後（req_issues フェーズ）でのみ可能です。");
	}
	const s = clone(prev);
	s.artifacts.issues = [...s.artifacts.issues, ...issues];
	s.phase = "req_done";
	return withLog(s, `Issue を ${issues.length} 件登録`);
}

// ---------------------------------------------------------------------------
// テストループ
// ---------------------------------------------------------------------------

export const TEST_PHASES: Phase[] = ["impl_tdd", "impl_fix_review", "bug_reproduce", "bug_fix"];

export type TestOutcome =
	/** red 期待で失敗 = TDD の Red 確認 or バグ再現成功 */
	| { kind: "red_confirmed" }
	/** red 期待なのに合格 = テストが要件/バグを捉えていない */
	| { kind: "red_unexpected_pass" }
	| { kind: "pass" }
	| { kind: "fail"; failures: number; remaining: number }
	| { kind: "escalate"; failures: number };

export function recordTestRun(
	prev: HarnessState,
	expect: "red" | "green",
	passed: boolean,
	log?: string,
): { state: HarnessState; outcome: TestOutcome } {
	if (!TEST_PHASES.includes(prev.phase)) {
		throw new TransitionError(`現在のフェーズ (${prev.phase}) ではテストループは実行できません。`);
	}
	const s = clone(prev);
	s.test.runs += 1;
	s.test.lastExpect = expect;
	s.test.lastResult = passed ? "pass" : "fail";
	s.test.dirty = false;
	if (log) s.test.lastLog = log;

	if (expect === "red") {
		if (passed) return { state: withLog(s, "Red 期待のテストが合格（テストが不十分）"), outcome: { kind: "red_unexpected_pass" } };
		return { state: withLog(s, "Red 確認（期待どおり失敗）"), outcome: { kind: "red_confirmed" } };
	}

	if (passed) {
		s.test.failures = 0;
		return { state: withLog(s, "テスト合格"), outcome: { kind: "pass" } };
	}

	s.test.failures += 1;
	if (s.test.failures >= s.test.max) {
		const reason: EscalationReason = s.flow === "bugfix" ? "bugfix_loop" : "test_loop";
		const escalated = escalate(
			s,
			reason,
			`テスト失敗の修正ループが ${s.test.failures} 周しても改善しませんでした。`,
		);
		return { state: escalated, outcome: { kind: "escalate", failures: s.test.failures } };
	}
	return {
		state: withLog(s, `テスト失敗 (${s.test.failures}/${s.test.max})`),
		outcome: { kind: "fail", failures: s.test.failures, remaining: s.test.max - s.test.failures },
	};
}

export function markDirty(prev: HarnessState): HarnessState {
	if (prev.test.dirty) return prev;
	const s = clone(prev);
	s.test.dirty = true;
	return s;
}

// ---------------------------------------------------------------------------
// レビューループ
// ---------------------------------------------------------------------------

export const BLOCKING: Severity[] = ["blocker", "major"];

export function reviewMode(s: HarnessState): "full" | "light" {
	return s.review.round === 0 ? "full" : "light";
}

export type ReviewOutcome =
	| { kind: "clean"; round: number; nonBlocking: number }
	| { kind: "fix"; round: number; blocking: number; remaining: number }
	| { kind: "escalate"; round: number; blocking: number };

export function recordReview(
	prev: HarnessState,
	findings: ReviewFinding[],
	summary: string,
	blockingSeverities: Severity[] = BLOCKING,
): { state: HarnessState; outcome: ReviewOutcome } {
	if (prev.phase !== "impl_review") {
		throw new TransitionError(`レビュー結果は impl_review フェーズでのみ記録できます（現在: ${prev.phase}）。`);
	}
	const s = clone(prev);
	const mode = reviewMode(prev);
	const blocking = findings.filter((f) => blockingSeverities.includes(f.severity)).length;
	s.review.round += 1;
	s.review.lastFindings = findings;
	s.review.history.push({ round: s.review.round, mode, blocking, total: findings.length, summary, at: now() });

	if (blocking === 0) {
		s.phase = "impl_done";
		return {
			state: withLog(s, `レビュー ${s.review.round} 周目: 指摘なし（ブロッキング 0 件）→ 完了`),
			outcome: { kind: "clean", round: s.review.round, nonBlocking: findings.length },
		};
	}
	if (s.review.round >= s.review.max) {
		const escalated = escalate(
			s,
			"review_loop",
			`レビューループが ${s.review.round} 周してもブロッキング指摘 (${blocking} 件) が解消しませんでした。`,
		);
		return { state: escalated, outcome: { kind: "escalate", round: s.review.round, blocking } };
	}
	s.phase = "impl_fix_review";
	s.test.failures = 0;
	return {
		state: withLog(s, `レビュー ${s.review.round} 周目: ブロッキング指摘 ${blocking} 件 → 修正`),
		outcome: { kind: "fix", round: s.review.round, blocking, remaining: s.review.max - s.review.round },
	};
}

// ---------------------------------------------------------------------------
// エスカレーション
// ---------------------------------------------------------------------------

export function escalate(prev: HarnessState, reason: EscalationReason, detail: string): HarnessState {
	if (!prev.flow) throw new TransitionError("アクティブなフローがありません。");
	const s = clone(prev);
	s.escalation = { reason, flow: prev.flow, phase: prev.phase, detail, at: now() };
	s.counters.escalations += 1;
	s.phase = "escalated";
	return withLog(s, `エスカレーション (${reason}): ${detail}`);
}

/** エスカレーション後にユーザー判断でループを継続する（カウンタをリセットして元のフェーズへ戻る） */
export function resumeAfterEscalation(prev: HarnessState, limits: Limits): HarnessState {
	if (prev.phase !== "escalated" || !prev.escalation) {
		throw new TransitionError("エスカレーション中ではありません。");
	}
	const s = clone(prev);
	const esc = prev.escalation;
	s.flow = esc.flow;
	s.escalation = undefined;
	s.test.failures = 0;
	s.test.max = limits.maxTestLoops;
	if (esc.reason === "review_loop") {
		// 追加でレビューループを max 周分許可する（ブロッキング指摘の修正から再開）
		s.review.max = s.review.round + limits.maxReviewLoops;
		s.phase = "impl_fix_review";
	} else {
		s.phase = esc.phase;
	}
	return withLog(s, `ユーザー判断でループを継続 → ${s.phase}`);
}

// ---------------------------------------------------------------------------
// バグ修正フローの完了と合流
// ---------------------------------------------------------------------------

/**
 * bug_done の状態から実装フローへ合流する。バグ修正でコードが変わっているため、レビューはフルレビューからやり直す。
 * テストはバグ修正フローの最後で合格済み（dirty=false）なので impl_review から再開する。
 */
export function rejoinImplement(prev: HarnessState, limits: Limits): HarnessState {
	if (prev.phase !== "bug_done") throw new TransitionError("バグ修正フローが完了していません。");
	if (!prev.suspended) throw new TransitionError("合流先の実装フローがありません。");
	const s = clone(prev);
	s.flow = "implement";
	s.phase = "impl_review";
	s.issue = prev.suspended.issue ?? prev.issue;
	s.suspended = undefined;
	s.bug = undefined;
	s.test = { ...s.test, failures: 0, max: limits.maxTestLoops };
	s.review.round = 0;
	s.review.max = limits.maxReviewLoops;
	s.review.lastFindings = [];
	return withLog(s, "バグ修正完了 → 実装フロー (impl_review) へ合流");
}

export function finishFlow(prev: HarnessState, reason: string): HarnessState {
	const s = clone(prev);
	s.flow = null;
	s.phase = "idle";
	s.escalation = undefined;
	s.pendingHandoff = undefined;
	return withLog(s, `フロー終了: ${reason}`);
}

// ---------------------------------------------------------------------------
// プロセス（= セッション）境界
// ---------------------------------------------------------------------------

const PROCESS_OF: Record<Exclude<Phase, "idle" | "escalated">, ProcessKind> = {
	req_clarify: "requirements",
	req_document: "requirements",
	req_approval: "requirements",
	req_issues: "issues",
	req_done: "issues",
	impl_context: "plan",
	impl_plan: "plan",
	impl_plan_approval: "plan",
	impl_tdd: "implement",
	impl_review: "review",
	impl_fix_review: "fix",
	impl_done: "review",
	bug_reproduce: "bugfix",
	bug_analyze: "bugfix",
	bug_fix: "bugfix",
	bug_done: "bugfix",
};

/** フェーズが属するプロセス。エスカレーション中はエスカレーション元のプロセスに留まる */
export function processOf(s: Pick<HarnessState, "phase" | "escalation">): ProcessKind | null {
	if (s.phase === "idle") return null;
	if (s.phase === "escalated") return s.escalation ? (PROCESS_OF[s.escalation.phase as keyof typeof PROCESS_OF] ?? null) : null;
	return PROCESS_OF[s.phase];
}

/**
 * 状態変化がプロセス境界をまたぐ場合、新しいセッションでの開始待ち (pendingHandoff) を設定する。
 * 同じプロセス内の変化、フローの終了・完了フェーズへの到達では設定しない。
 */
export function withHandoff(prev: HarnessState, next: HarnessState): HarnessState {
	const from = processOf(prev);
	const to = processOf(next);
	if (!to || !next.flow || from === to) return next;
	if (next.phase === "impl_done" || next.phase === "req_done") return next;
	const s = clone(next);
	s.pendingHandoff = { from, to, at: now() };
	return withLog(s, `プロセス切替待ち: ${from ?? "-"} → ${to}（新しいセッションで開始）`);
}

export function clearHandoff(prev: HarnessState): HarnessState {
	if (!prev.pendingHandoff) return prev;
	const s = clone(prev);
	s.pendingHandoff = undefined;
	return s;
}

// ---------------------------------------------------------------------------
// 表示用
// ---------------------------------------------------------------------------

export function describeIssue(issue?: IssueRef): string {
	if (!issue) return "(Issue 未指定)";
	return `${issue.number ? `#${issue.number} ` : ""}${issue.title}`.trim();
}

export const PHASE_LABELS: Record<Phase, string> = {
	idle: "待機中",
	req_clarify: "要件ヒアリング",
	req_document: "要件定義書作成",
	req_approval: "要件承認待ち",
	req_issues: "Issue 登録",
	req_done: "要件定義完了",
	impl_context: "Issue/コード読込",
	impl_plan: "テスト/実装プラン作成",
	impl_plan_approval: "プラン承認待ち",
	impl_tdd: "TDD 実装",
	impl_review: "コードレビュー",
	impl_fix_review: "レビュー指摘修正",
	impl_done: "実装完了",
	bug_reproduce: "バグ再現",
	bug_analyze: "原因分析",
	bug_fix: "バグ修正",
	bug_done: "バグ修正完了",
	escalated: "エスカレーション中",
};

export function statusLine(s: HarnessState): string {
	if (!isActive(s)) return "";
	const parts = [`${s.flow}:${PHASE_LABELS[s.phase]}`];
	if (s.flow !== "requirements") parts.push(`test ${s.test.failures}/${s.test.max}`);
	if (s.flow === "implement") parts.push(`review ${s.review.round}/${s.review.max}`);
	if (s.test.dirty) parts.push("未テスト変更あり");
	if (s.pendingHandoff) parts.push(`次セッション待ち→${s.pendingHandoff.to}`);
	return parts.join(" | ");
}

function unique<T>(xs: T[]): T[] {
	return [...new Set(xs)];
}
