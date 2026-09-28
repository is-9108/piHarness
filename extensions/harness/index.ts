/**
 * piHarness — pi-coding-agent 用ワークフロー制御拡張
 *
 * 1. 要件定義フロー   (/req)    : ヒアリング → 要件定義書 → 人間の承認ゲート → 小さな単位で GitHub Issue 登録
 * 2. TDD 実装フロー   (/impl)   : Issue/コード読込 → テスト/実装プラン → 承認 → TDD → テストループ(3周) → レビューループ(3周)
 * 3. バグ修正フロー   (/bugfix) : エスカレーション時にユーザー判断で起動 → 完了後に実装フローへ合流
 *
 * 各プロセス（要件定義 / Issue 登録 / プラン / 実装 / レビュー / 指摘修正 / バグ修正）は独立したセッションで実行する。
 * プロセス間の連携は作業ディレクトリの md ファイル（成果物）と state.json だけで行い、会話は引き継がない。
 *
 * 状態遷移は state.ts、引き継ぎは handoff.ts の純粋関数で行い、この拡張はツール/コマンド/イベントとの接続だけを担う。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { findModel, type HarnessConfig, loadConfig, PROCESS_KINDS, resolveProcessModel, saveConfigPatch } from "./config.ts";
import { checkBash, checkWrite, type GuardPaths, isHarnessFile, isInside, STATE_FILE } from "./guard.ts";
import { buildContext } from "./guidance.ts";
import { emptyRegistry, type IssueRegistry, nextIssue, progressTable, registerIssues, setStatus } from "./progress.ts";
import { analyzeTestDiff, findingsMarkdown, signature as integritySignature } from "./integrity.ts";
import { commitAll, currentBranch, defaultBranch, diffTrees, snapshotTree, diffSince, dirtyFiles, fingerprint, type GitInfo, headSha, isGitRepo, prepareBranch, branchName, type Run } from "./git.ts";
import { type UsageFile, sumSession, summarize as summarizeUsage, upsertSession, usageMarkdown } from "./usage.ts";
import {
	artifactPaths,
	escalationMarkdown,
	KICKOFF_MARKER,
	handoffRecord,
	kickoffMessage,
	PROCESS_LABELS,
	pathsOf,
	processIO,
	requiredArtifact,
} from "./handoff.ts";
import {
	type IssueDraft,
	draftFileName,
	draftMarkdown,
	ghIssueCreateArgs,
	ghLabelCreateArgs,
	parseIssueArg,
	parseIssueUrl,
	validateDrafts,
	withDependencies,
} from "./issues.ts";
import {
	acknowledgeTestChanges,
	type ApprovalDecision,
	type ApprovalKind,
	isAcknowledged,
	isTestGatedTransition,
	appendIssues,
	applyApproval,
	beginApproval,
	canCreateIssues,
	clearHandoff,
	describeIssue,
	finishFlow,
	type HarnessState,
	initialState,
	type IssueRef,
	isActive,
	type Limits,
	markDirty,
	PHASE_LABELS,
	type Phase,
	type ProcessKind,
	processOf,
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
	statusLine,
	TEST_PHASES,
	transition,
	TransitionError,
	withHandoff,
} from "./state.ts";
import { slugify, tailLines, timestamp } from "./text.ts";
import { toolsForProcess } from "./tools.ts";
import { compactionInstructions, shouldCompact } from "./compaction.ts";

const CONTEXT_MESSAGE = "harness-context";
/** Red 確認（期待どおりの失敗）で返す出力の行数。失敗理由が「未実装」かを確かめられれば十分 */
const RED_OUTPUT_LINES = 40;
/** piHarness 自身のディレクトリ（プロジェクト内に clone して使う場合、エージェントに書き換えさせない） */
const HARNESS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ALL_PHASES = Object.keys(PHASE_LABELS) as Phase[];

type ToolText = { content: { type: "text"; text: string }[]; details: { phase: Phase }; terminate?: boolean };

export default function piHarness(pi: ExtensionAPI): void {
	/** state.json のキャッシュ。セッションが変わると拡張は再生成されるため、真実は常にファイル側にある */
	let state: HarnessState = initialState();

	// -----------------------------------------------------------------------
	// 共通ヘルパー
	// -----------------------------------------------------------------------

	const cfgOf = (ctx: { cwd: string }): HarnessConfig => loadConfig(ctx.cwd).config;
	const limitsOf = (cfg: HarnessConfig): Limits => ({ maxTestLoops: cfg.maxTestLoops, maxReviewLoops: cfg.maxReviewLoops });
	const guardPaths = (ctx: ExtensionContext, cfg: HarnessConfig): GuardPaths => ({
		cwd: ctx.cwd,
		docsDir: cfg.docsDir,
		workDir: cfg.workDir,
	});
	const stateFile = (ctx: { cwd: string }) => join(ctx.cwd, cfgOf(ctx).workDir, STATE_FILE);
	const existsIn = (ctx: { cwd: string }) => (path: string) => existsSync(join(ctx.cwd, path));

	function loadState(ctx: ExtensionContext): HarnessState {
		const file = stateFile(ctx);
		const fresh = initialState(limitsOf(cfgOf(ctx)));
		if (!existsSync(file)) return fresh;
		try {
			const parsed = JSON.parse(readFileSync(file, "utf8")) as HarnessState;
			return parsed.version === 2 ? parsed : fresh;
		} catch (e) {
			ctx.ui.notify(`[piHarness] ${file} を読み込めませんでした: ${(e as Error).message}`, "error");
			return fresh;
		}
	}

	/** 状態を更新して state.json に保存する。プロセス境界をまたぐ場合は新セッション待ちを記録する */
	function setState(next: HarnessState, ctx: ExtensionContext): void {
		state = withHandoff(state, next);
		const file = stateFile(ctx);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
		refreshUI(ctx);
	}

	function refreshUI(ctx: ExtensionContext): void {
		const line = statusLine(state);
		// フロー外では、話しかけて開始できることを示す
		ctx.ui.setStatus("harness", line ? `🧭 ${line}` : "🧭 piHarness: 作りたいもの・実装したい Issue・直したい不具合を話しかけてください");
	}

	const gitRun =
		(ctx: { cwd: string }): Run =>
		(cmd, args) =>
			pi.exec(cmd, args, { cwd: ctx.cwd, timeout: 120_000 });

	/** git の差分・指紋・コミットから外すパス（成果物ディレクトリと、プロジェクト内に clone した piHarness 本体） */
	function gitExcludes(ctx: { cwd: string }, cfg: HarnessConfig): string[] {
		const out = [cfg.workDir];
		const rel = relative(ctx.cwd, HARNESS_ROOT);
		if (rel && !rel.startsWith("..") && !isAbsolute(rel)) out.push(rel);
		return out;
	}

	function writeItemFile(ctx: { cwd: string }, rel: string, content: string, append = false): string {
		const abs = join(ctx.cwd, rel);
		mkdirSync(dirname(abs), { recursive: true });
		if (append) appendFileSync(abs, content);
		else writeFileSync(abs, content);
		return rel;
	}

	const registryFile = (ctx: { cwd: string }) => join(ctx.cwd, cfgOf(ctx).workDir, "issues.json");

	function loadRegistry(ctx: { cwd: string }): IssueRegistry {
		const file = registryFile(ctx);
		if (!existsSync(file)) return emptyRegistry();
		try {
			const r = JSON.parse(readFileSync(file, "utf8")) as IssueRegistry;
			return r.version === 1 && Array.isArray(r.issues) ? r : emptyRegistry();
		} catch {
			return emptyRegistry();
		}
	}

	function saveRegistry(ctx: { cwd: string }, reg: IssueRegistry): void {
		writeItemFile(ctx, relative(ctx.cwd, registryFile(ctx)), `${JSON.stringify(reg, null, 2)}\n`);
	}

	/** 同じ名前の作業ディレクトリが既にあれば -r2, -r3 … を付けて新しく作る */
	function newItemDir(ctx: { cwd: string }, base: string): string {
		const root = cfgOf(ctx).workDir;
		let dir = join(root, base);
		for (let i = 2; existsSync(join(ctx.cwd, dir)); i++) dir = join(root, `${base}-r${i}`);
		return dir;
	}

	/** プロセス境界に達したときにツール結果へ付け加える文言 */
	function withHandoffNotice(result: ToolText): ToolText {
		if (!state.pendingHandoff) return result;
		const next = PROCESS_LABELS[state.pendingHandoff.to];
		result.content[0].text +=
			`\n\n[プロセス完了] 次の「${next}」は新しいセッションで開始されます（会話は引き継がれず、成果物ファイルのみが引き継がれます）。` +
			"これ以上作業せず、このプロセスの成果を 1〜3 文で報告して終了してください。";
		result.terminate = true;
		return result;
	}

	function reply(text: string, terminate = false): ToolText {
		return withHandoffNotice({
			content: [{ type: "text", text }],
			details: { phase: state.phase },
			...(terminate ? { terminate } : {}),
		});
	}

	function tempIndexFile(): string {
		return join(tmpdir(), `pi-harness-index-${process.pid}-${Date.now()}`);
	}

	/** 軽量レビューの開始前に、前回レビュー時点からの差分を delta-N.diff として書き出す */
	async function writeReviewDelta(ctx: ExtensionContext): Promise<void> {
		if (processOf(state) !== "review" || reviewMode(state) !== "light" || !state.review.snapshot || !state.itemDir) return;
		const run = gitRun(ctx);
		const current = await snapshotTree(run, tempIndexFile(), gitExcludes(ctx, cfgOf(ctx)));
		if (!current) return;
		const diff = await diffTrees(run, state.review.snapshot, current);
		writeItemFile(
			ctx,
			pathsOf(state).delta(state.review.round + 1),
			diff || `# 前回レビュー（${state.review.round} 周目）以降、コードの変更はありません\n`,
		);
	}

	/**
	 * 現在のプロセスを新しいセッションで開始する（コマンドからのみ呼べる）。
	 * 引き継ぎ内容を handoff.md に記録してから state.json を保存し、新セッションで開始メッセージを送る。
	 */
	async function startProcessSession(ctx: ExtensionCommandContext, note?: string): Promise<void> {
		await writeReviewDelta(ctx);
		const exists = existsIn(ctx);
		const kickoff = kickoffMessage(state, exists, note);
		writeItemFile(ctx, pathsOf(state).handoff, handoffRecord(state, exists), true);
		const pending = state.pendingHandoff;
		const proc = processOf(state) ?? undefined;
		// 新しいセッションの session_start でこのプロセス用のモデルを適用するための目印
		setState({ ...clearHandoff(state), kickoff: proc }, ctx);
		const title = `${state.issue?.number ? `#${state.issue.number} ` : ""}${proc ? PROCESS_LABELS[proc] : ""}`;
		const result = await ctx.newSession({
			withSession: async (next) => {
				next.ui.notify(`piHarness: ${title} を新しいセッションで開始します`, "info");
				// エージェントの実行完了を待たずにコマンドを終える
				void next.sendUserMessage(kickoff, { expandPromptTemplates: true }).catch((e: unknown) => {
					next.ui.notify(`[piHarness] 開始メッセージの送信に失敗しました: ${(e as Error).message}`, "error");
				});
			},
		});
		if (result.cancelled) {
			// 新セッションが開始されなかった場合は、次回 /harness next で再試行できるよう待ち状態に戻す
			setState({ ...state, kickoff: undefined, ...(pending ? { pendingHandoff: pending } : {}) }, ctx);
			ctx.ui.notify("新しいセッションの開始がキャンセルされました。/harness next で再開できます。", "warning");
		}
	}

	/**
	 * 実装フロー完了時の後処理: Issue を完了にし、変更をコミットし、設定に応じて PR を作成する。
	 * PR（外部への公開）は git.pr が "ask" ならユーザーの確認を必須にする。戻り値はユーザー向けの報告文。
	 */
	async function finalizeImplementation(ctx: ExtensionContext, cfg: HarnessConfig, opts: { forcePr?: boolean } = {}): Promise<string> {
		const lines: string[] = [];
		const issue = state.issue;
		if (issue) saveRegistry(ctx, setStatus(loadRegistry(ctx), issue, "done"));
		const usage = usageSummaryLine(ctx);
		if (usage) lines.push(usage);
		const git = state.git;
		if (!git || !cfg.git.enabled) {
			lines.push("Git 連携なし（コミット・PR は作成していません）。");
			return lines.join("\n");
		}
		const run = gitRun(ctx);
		const excludes = cfg.git.commitArtifacts ? gitExcludes(ctx, cfg).filter((e) => e !== cfg.workDir) : gitExcludes(ctx, cfg);
		const title = `${issue?.title ?? "piHarness 実装"}${issue?.number ? ` (#${issue.number})` : ""}`;
		let next: GitInfo = { ...git };
		if (cfg.git.commit && !git.commit) {
			try {
				const body = [
					"piHarness TDD 実装フローで作成",
					`レビュー: ${state.review.history.length} 周（${state.review.history.map((h) => `${h.round}:${h.blocking}件`).join(", ")}）`,
					issue?.number ? `\nCloses #${issue.number}` : "",
				].join("\n");
				const sha = await commitAll(run, excludes, `${title}\n\n${body}`);
				if (sha) {
					next = { ...next, commit: sha };
					lines.push(`コミットしました: ${sha.slice(0, 12)}${git.branch ? `（ブランチ ${git.branch}）` : ""}`);
				} else {
					lines.push("コミットする変更はありませんでした。");
				}
			} catch (e) {
				lines.push(`⚠ ${(e as Error).message}`);
				setState({ ...state, git: next }, ctx);
				return lines.join("\n");
			}
		}
		setState({ ...state, git: next }, ctx);

		const mode = opts.forcePr ? "auto" : cfg.git.pr;
		if (mode === "off") {
			lines.push("PR は作成しない設定です（git.pr: off）。");
		} else if (next.pr?.status === "created") {
			lines.push(`PR は作成済みです: ${next.pr.url}`);
		} else if (!next.branch || !next.baseBranch || next.branch === next.baseBranch) {
			lines.push("作業ブランチが無いため PR は作成していません（開始時のブランチ上で作業しました）。");
		} else if (!next.commit) {
			lines.push("コミットが無いため PR は作成していません。");
		} else {
			let go = mode === "auto";
			if (mode === "ask") {
				if (!ctx.hasUI) {
					lines.push("PR 作成には確認が必要です（git.pr: ask）。/harness pr で作成できます。");
				} else {
					go = await ctx.ui.confirm(
						"PR を作成しますか？",
						`ブランチ ${next.branch} を origin に push し、${next.baseBranch} への${cfg.git.draft ? "ドラフト " : ""}PR を作成します。\nタイトル: ${title}`,
					);
					if (!go) lines.push("PR の作成はスキップしました（後で /harness pr で作成できます）。");
				}
			}
			if (go) lines.push(await createPullRequest(ctx, cfg, title));
		}
		return lines.join("\n");
	}

	async function createPullRequest(ctx: ExtensionContext, cfg: HarnessConfig, title: string): Promise<string> {
		const git = state.git;
		if (!git?.branch || !git.baseBranch) return "作業ブランチが無いため PR を作成できません。";
		const fail = (msg: string) => {
			setState({ ...state, git: { ...git, pr: { status: "failed", error: msg } } }, ctx);
			return `⚠ PR を作成できませんでした: ${msg}（原因を解消して /harness pr で再試行できます）`;
		};
		const push = await pi.exec("git", ["push", "-u", "origin", git.branch], { cwd: ctx.cwd, timeout: 180_000 }).catch((e: Error) => ({ code: 1, stdout: "", stderr: e.message, killed: false }));
		if (push.code !== 0) return fail(`git push: ${(push.stderr || push.stdout).trim()}`);
		const p = pathsOf(state);
		const impl = existsSync(join(ctx.cwd, p.implementation)) ? readFileSync(join(ctx.cwd, p.implementation), "utf8") : "";
		const reviews = state.review.history.map((h) => `- ${h.round} 周目（${h.mode === "full" ? "フル" : "軽量"}）: ブロッキング ${h.blocking} 件 / 全 ${h.total} 件`).join("\n");
		const body = `${impl.trim()}\n\n## レビュー（piHarness）\n\n${reviews || "なし"}\n${state.issue?.number ? `\nCloses #${state.issue.number}\n` : ""}`;
		const args = ["pr", "create", "--base", git.baseBranch, "--head", git.branch, "--title", title, "--body", body];
		if (cfg.git.draft) args.push("--draft");
		if (cfg.issueRepo) args.push("--repo", cfg.issueRepo);
		const r = await pi.exec("gh", args, { cwd: ctx.cwd, timeout: 120_000 }).catch((e: Error) => ({ code: 1, stdout: "", stderr: e.message, killed: false }));
		const url = r.stdout.match(/https?:\/\/\S+\/pull\/\d+/)?.[0];
		if (r.code !== 0 || !url) return fail(`gh pr create: ${(r.stderr || r.stdout).trim()}`);
		setState({ ...state, git: { ...git, pr: { status: "created", url } } }, ctx);
		if (state.issue) saveRegistry(ctx, setStatus(loadRegistry(ctx), state.issue, "done", { pr: url }));
		return `PR を作成しました: ${url}`;
	}

	// -----------------------------------------------------------------------
	// モデル利用量（セッションごとに集計して作業ディレクトリの usage.json へ）
	// -----------------------------------------------------------------------

	/** このセッションが担当するプロセス（セッション開始時に決まる） */
	let sessionProcess: ProcessKind | undefined;

	function loadUsage(ctx: { cwd: string }, itemDir: string): UsageFile {
		const file = join(ctx.cwd, artifactPaths(itemDir).usage);
		if (!existsSync(file)) return { version: 1, sessions: [] };
		try {
			return JSON.parse(readFileSync(file, "utf8")) as UsageFile;
		} catch {
			return { version: 1, sessions: [] };
		}
	}

	function recordUsage(ctx: ExtensionContext): void {
		if (!state.itemDir) return;
		sessionProcess ??= processOf(state) ?? undefined;
		if (!sessionProcess) return;
		const models = sumSession(ctx.sessionManager.getEntries() as { type: string; message?: unknown }[]);
		if (Object.keys(models).length === 0) return;
		const file = upsertSession(loadUsage(ctx, state.itemDir), {
			sessionId: ctx.sessionManager.getSessionId(),
			process: sessionProcess,
			models,
			updatedAt: new Date().toISOString(),
		});
		writeItemFile(ctx, artifactPaths(state.itemDir).usage, `${JSON.stringify(file, null, 2)}\n`);
	}

	function usageSummaryLine(ctx: { cwd: string }): string | undefined {
		if (!state.itemDir) return undefined;
		const file = loadUsage(ctx, state.itemDir);
		if (file.sessions.length === 0) return undefined;
		const { total } = summarizeUsage(file);
		return `モデル利用量: ${file.sessions.length} セッション / 入力 ${total.input.toLocaleString("en-US")}・出力 ${total.output.toLocaleString("en-US")} トークン / $${total.cost.toFixed(4)}（詳細: /harness usage）`;
	}

	pi.on("agent_end", async (_e, ctx) => {
		try {
			recordUsage(ctx);
		} catch (e) {
			ctx.ui.notify(`[piHarness] 利用量を記録できませんでした: ${(e as Error).message}`, "warning");
		}
	});

	/**
	 * テストを弱める変更（テスト削除・スキップ/フォーカス追加・アサーション減少）を実装開始時点からの差分で検知する。
	 * 見つかった場合は理由の記録を求め、記録された理由は test-changes.md としてレビュー担当に引き継ぐ。
	 */
	async function checkTestIntegrity(ctx: ExtensionContext, cfg: HarnessConfig, reason: string | undefined): Promise<void> {
		if (!cfg.testIntegrity || !state.git?.base) return;
		const { nameStatus, patch } = await diffSince(gitRun(ctx), state.git.base, gitExcludes(ctx, cfg), ctx.cwd);
		const findings = analyzeTestDiff(nameStatus, patch);
		if (findings.length === 0) return;
		const sig = integritySignature(findings);
		if (isAcknowledged(state, sig)) return;
		if (!reason?.trim()) {
			throw new Error(
				`テストを弱める可能性のある変更を検知しました（実装開始時点 ${state.git.base.slice(0, 12)} からの差分）:\n${findingsMarkdown(findings)}\n\n` +
					"意図しない変更なら元に戻してください。正当な変更（仕様変更で不要になったテストの削除など）であれば、" +
					"harness_phase の testChangeReason に理由を書いて再実行してください。理由はレビュー担当が検証します。",
			);
		}
		writeItemFile(
			ctx,
			pathsOf(state).testChanges,
			`\n## ${new Date().toISOString()}（${PHASE_LABELS[state.phase]}）\n\n${findingsMarkdown(findings)}\n\n**理由:** ${reason.trim()}\n`,
			true,
		);
		setState(acknowledgeTestChanges(state, sig, reason.trim()), ctx);
	}

	/**
	 * ループ上限時のエスカレーション。記録ファイルを書き出し、UI があればその場でユーザーに判断を仰ぐ。
	 */
	async function handleEscalation(ctx: ExtensionContext, headline: string): Promise<ToolText> {
		const cfg = cfgOf(ctx);
		const n = state.counters.escalations;
		const record = writeItemFile(ctx, pathsOf(state).escalation(n), escalationMarkdown(state, n));
		const esc = state.escalation;
		const detail = `${headline}\n理由: ${esc?.detail ?? ""}\nエスカレーション記録: ${record}`;
		if (!ctx.hasUI) {
			return reply(
				`${detail}\n\n[ESCALATED] 作業を止め、状況（試したこと・失敗の原因仮説・選択肢）をユーザーに報告してください。` +
					"ユーザーはチャットで「ループを続けて」「バグ修正して」「やめたい」のように伝えるか、/harness continue・/bugfix・/harness abort で選べます。",
				true,
			);
		}
		const options = [
			"ループを継続する（カウンタをリセットしてもう一度）",
			"独立したバグ修正フローで対応する（新しいセッション）",
			"手動で対応する（フローを一時停止）",
			"フローを中止する",
		];
		const choice = await ctx.ui.select(`⚠ エスカレーション: ${headline}\n${esc?.detail ?? ""}`, options);
		if (choice === options[0]) {
			setState(resumeAfterEscalation(state, limitsOf(cfg)), ctx);
			return reply(
				`${detail}\n\nユーザー判断: ループを継続。カウンタをリセットしました（現在のフェーズ: ${state.phase}）。` +
					"これまでと異なるアプローチで原因を再分析してから修正してください。",
			);
		}
		if (choice === options[1]) {
			const description =
				(await ctx.ui.input("バグの内容（空欄ならエスカレーション理由を使用）", esc?.detail ?? "")) || esc?.detail || headline;
			setState(startBugfix(state, description, limitsOf(cfg), newItemDir(ctx, `bug-${timestamp()}`)), ctx);
			return reply(`${detail}\n\nユーザー判断: 独立したバグ修正フローで対応します（バグ: ${description}）。`);
		}
		if (choice === options[3]) {
			setState(finishFlow(state, "エスカレーション後にユーザーが中止"), ctx);
			return reply(`${detail}\n\nユーザー判断: フローを中止しました。作業を止めてください。`, true);
		}
		return reply(
			`${detail}\n\nユーザー判断: 手動で対応（フロー一時停止）。作業を止め、ここまでの状況を簡潔に報告してください。` +
				"再開・バグ修正・中止はチャットで伝えてもらえば、確認のうえ実行します（/harness continue・/bugfix・/harness abort でも可）。",
			true,
		);
	}

	// -----------------------------------------------------------------------
	// セッション・イベント
	// -----------------------------------------------------------------------

	/**
	 * プロセスに設定されたモデル・思考レベルを現在のセッションに適用する。
	 * 設定が無ければ何もしない（Pi の既定モデルのまま）。失敗しても処理は続け、警告だけ出す。
	 */
	async function applyProcessModel(ctx: ExtensionContext, proc: ProcessKind): Promise<string | undefined> {
		const variant = proc === "review" ? (reviewMode(state) === "full" ? "review_full" : "review_light") : undefined;
		const setting = resolveProcessModel(cfgOf(ctx).models, proc, variant);
		const applied: string[] = [];
		if (setting.model) {
			// 候補を先頭から試し、見つかって認証が設定されている最初のモデルを使う（フォールバック）
			const problems: string[] = [];
			for (const ref of setting.model) {
				// getAvailable() は起動直後に認証状態の反映が遅れることがあるため、全カタログから探して認証は setModel に判定させる
				const { model, error } = findModel(ref, ctx.modelRegistry.getAll());
				if (!model) {
					problems.push(error ?? ref);
					continue;
				}
				if (!(await setModelWhenReady(ctx, model))) {
					problems.push(`${ref} の認証が設定されていません。`);
					continue;
				}
				applied.push(`${model.provider}/${model.id}${problems.length ? `（フォールバック: ${problems.length} 件スキップ）` : ""}`);
				break;
			}
			if (applied.length === 0) {
				ctx.ui.notify(`[piHarness] ${PROCESS_LABELS[proc]}: 使えるモデルがありません。既定のモデルを使用します。\n${problems.join("\n")}`, "warning");
			} else if (problems.length) {
				ctx.ui.notify(`[piHarness] ${PROCESS_LABELS[proc]}: 優先候補を使えなかったためフォールバックしました。\n${problems.join("\n")}`, "warning");
			}
		}
		if (setting.thinking) {
			pi.setThinkingLevel(setting.thinking);
			applied.push(`thinking: ${pi.getThinkingLevel()}`);
		}
		return applied.length ? applied.join(", ") : undefined;
	}

	/**
	 * pi.setModel は認証状態のスナップショットで判定するが、新しいセッションの直後はスナップショットの更新が
	 * 非同期で遅れることがある。失敗したら非同期の認証解決で本当に未設定か確かめ、設定済みなら少し待って再試行する。
	 */
	async function setModelWhenReady(ctx: ExtensionContext, model: Parameters<typeof pi.setModel>[0]): Promise<boolean> {
		if (await pi.setModel(model)) return true;
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model).catch(() => ({ ok: false as const }));
		if (!auth.ok) return false;
		for (let i = 0; i < 30; i++) {
			await new Promise((r) => setTimeout(r, 100));
			if (await pi.setModel(model)) return true;
		}
		return false;
	}

	/** 現在のプロセスに必要なツールだけを有効にする（フロー外では状態確認と自然言語からの開始だけ） */
	function applyProcessTools(): void {
		const proc = isActive(state) && !state.pendingHandoff ? processOf(state) : null;
		const registered = pi.getAllTools().map((t) => t.name);
		pi.setActiveTools(toolsForProcess(pi.getActiveTools(), registered, proc));
	}

	pi.on("session_start", async (_e, ctx) => {
		state = loadState(ctx);
		sessionProcess = undefined;
		if (state.kickoff) {
			const proc = state.kickoff;
			sessionProcess = proc;
			setState({ ...state, kickoff: undefined }, ctx);
			const applied = await applyProcessModel(ctx, proc);
			if (applied) ctx.ui.notify(`piHarness: ${PROCESS_LABELS[proc]} のモデル → ${applied}`, "info");
		}
		applyProcessTools();
		refreshUI(ctx);
		const { warnings } = loadConfig(ctx.cwd);
		for (const w of warnings) ctx.ui.notify(`[piHarness] ${w}`, "warning");
		if (state.pendingHandoff) {
			ctx.ui.notify(`piHarness: 「${PROCESS_LABELS[state.pendingHandoff.to]}」の開始待ちです。/harness next で開始します。`, "info");
		}
	});

	/** このセッションで最後にエージェントへ伝えた状態（同じ内容は二度送らない） */
	let lastInjected: string | undefined;

	// 現在のプロセス・入出力成果物・次の行動をエージェントに伝える。
	// プロンプトキャッシュを壊さないよう、状態が変わったときだけ追記し、過去の状態表示は削除しない。
	pi.on("before_agent_start", async (event, ctx) => {
		if (!isActive(state)) return;
		const proc = processOf(state);
		if (proc && !pi.getSessionName()) {
			const who = state.issue?.number ? `#${state.issue.number} ` : state.topic ? `${state.topic} ` : "";
			pi.setSessionName(`[harness] ${who}${PROCESS_LABELS[proc]}`);
		}
		const content = buildContext(state, cfgOf(ctx), processIO(state, existsIn(ctx)));
		// セッション開始メッセージには同じ情報（入出力・次の行動）が含まれているので送らない
		const isKickoff = event.prompt.includes(KICKOFF_MARKER);
		if (reminderPending && !isKickoff) {
			const why = reminderPending;
			reminderPending = undefined;
			lastInjected = content;
			return { message: { customType: CONTEXT_MESSAGE, content: `${expandedResume(ctx, why)}\n\n${content}`, display: false } };
		}
		reminderPending = isKickoff ? undefined : reminderPending;
		if (isKickoff || content === lastInjected) {
			lastInjected = content;
			return;
		}
		lastInjected = content;
		return { message: { customType: CONTEXT_MESSAGE, content, display: false } };
	});

	// -----------------------------------------------------------------------
	// しきい値による自動圧縮
	// -----------------------------------------------------------------------

	/** しきい値を超えたので、次の安全な区切りで圧縮する */
	let compactRequested = false;
	/** 圧縮のためにツール呼び出しを止めて実行を中断した（圧縮後に自動で再開する） */
	let interruptedForCompaction = false;
	let compacting = false;
	let ownCompaction = false;
	/** 次のユーザー入力時に、圧縮で消えたスキル本文と成果物の一覧を注入する */
	let reminderPending: string | undefined;

	/** 圧縮で消えたスキル本文と成果物の一覧（/skill: で展開される） */
	function resumeMessage(ctx: ExtensionContext, why: string): string {
		return kickoffMessage(
			state,
			existsIn(ctx),
			`${why}会話は要約されています。要約の作業状態と上記の成果物を確認し、中断したところから作業を続けてください（最初からやり直さない）。`,
		).replace("をこの新しいセッションで開始します。", "を再開します。");
	}

	/** before_agent_start で注入する用: スキル本文をファイルから読んで展開済みの形にする */
	function expandedResume(ctx: ExtensionContext, why: string): string {
		const text = resumeMessage(ctx, why);
		const m = text.match(/^\/skill:(\S+) /);
		if (!m) return text;
		const file = join(HARNESS_ROOT, "skills", m[1], "SKILL.md");
		const body = existsSync(file) ? readFileSync(file, "utf8").replace(/^---\n[\s\S]*?\n---\n/, "").trim() : "";
		return `${body}\n\n${text.slice(m[0].length)}`;
	}

	function startCompaction(ctx: ExtensionContext, percent: number): void {
		const cfg = cfgOf(ctx);
		const resume = interruptedForCompaction;
		interruptedForCompaction = false;
		compacting = true;
		ownCompaction = true;
		ctx.ui.notify(`piHarness: コンテキスト使用率 ${percent}% のため圧縮します（しきい値 ${cfg.compaction.thresholdPercent}%）`, "info");
		ctx.compact({
			customInstructions: compactionInstructions(state),
			onComplete: () => {
				compacting = false;
				if (!isActive(state) || state.pendingHandoff) return;
				const why = `コンテキスト使用率が ${percent}% に達したため`;
				if (resume) {
					pi.sendUserMessage(resumeMessage(ctx, why), { deliverAs: "followUp", expandPromptTemplates: true });
				} else {
					reminderPending = why;
				}
			},
			onError: (e) => {
				compacting = false;
				ownCompaction = false;
				ctx.ui.notify(`[piHarness] 圧縮に失敗しました: ${e.message}`, "warning");
				if (resume && isActive(state)) {
					pi.sendUserMessage("コンテキストの圧縮に失敗しました。そのまま作業を続けてください。", { deliverAs: "followUp" });
				}
			},
		});
	}

	let requestedPercent = 0;

	// ターンの区切りでしきい値を確認し、超えていれば圧縮を予約する（実行中の圧縮は中断を伴うため、次の区切りで止める）
	pi.on("turn_end", async (_e, ctx) => {
		const usage = ctx.getContextUsage();
		if (compactRequested || !shouldCompact(state, usage, cfgOf(ctx).compaction, compacting)) return;
		compactRequested = true;
		requestedPercent = Math.round(usage?.percent ?? 0);
	});

	// Pi 自身の自動圧縮（上限直前・オーバーフロー時）でも、消えたスキル本文と成果物の一覧を送り直す
	pi.on("session_compact", async (_e, ctx) => {
		if (ownCompaction) {
			ownCompaction = false;
			return;
		}
		if (!isActive(state) || state.pendingHandoff) return;
		if (ctx.isIdle()) reminderPending = "Pi がコンテキストを自動圧縮したため";
		else pi.sendUserMessage(resumeMessage(ctx, "Pi がコンテキストを自動圧縮したため"), { deliverAs: "steer", expandPromptTemplates: true });
	});

	// プロセスが終わったら、エージェントが止まった時点で次のプロセスを新しいセッションで開始する
	pi.on("agent_settled", async (_e, ctx) => {
		if (compactRequested) {
			compactRequested = false;
			if (!state.pendingHandoff && !compacting) startCompaction(ctx, requestedPercent);
			else interruptedForCompaction = false;
		}
		if (!state.pendingHandoff) return;
		if (cfgOf(ctx).autoHandoff || forceHandoff) {
			forceHandoff = false;
			pi.sendUserMessage("/harness next", { expandPromptTemplates: true });
		} else {
			ctx.ui.notify(`次のプロセス「${PROCESS_LABELS[state.pendingHandoff.to]}」は /harness next で新しいセッションとして開始します。`, "info");
		}
	});

	// 承認ゲート前のコード変更・状態ファイルの改ざん・プロセス完了後の作業をブロック
	pi.on("tool_call", async (event, ctx) => {
		const cfg = cfgOf(ctx);
		if (event.toolName === "edit" || event.toolName === "write") {
			const path = (event.input as { path?: string }).path;
			if (path && !isInside(ctx.cwd, HARNESS_ROOT, "/") && isInside(path, HARNESS_ROOT, ctx.cwd)) {
				return { block: true, reason: `[piHarness] piHarness 本体 (${HARNESS_ROOT}) は編集できません。` };
			}
			const d = checkWrite(state, path, guardPaths(ctx, cfg));
			if (d.block) return { block: true, reason: d.reason };
		}
		if (!isActive(state)) return;
		if (compactRequested && !state.pendingHandoff) {
			interruptedForCompaction = true;
			return {
				block: true,
				reason: "[piHarness] コンテキストが大きくなったため、ここで一度止めて圧縮します。圧縮後に再開の指示が届くので、今は何もせず待ってください。",
				terminate: true,
			};
		}
		if (state.pendingHandoff && !event.toolName.startsWith("harness_")) {
			return {
				block: true,
				reason: "[piHarness] このプロセスは完了しています。次のプロセスは新しいセッションで開始されます。作業を終了してください。",
				terminate: true,
			};
		}
		if (event.toolName === "bash") {
			const d = checkBash(state, (event.input as { command?: string }).command);
			if (d.block) return { block: true, reason: d.reason };
		}
	});

	// テスト合格後の変更を検知（未テストのままレビューや完了へ進ませない）
	pi.on("tool_result", async (event, ctx) => {
		if (!isActive(state) || event.isError) return;
		if (event.toolName !== "edit" && event.toolName !== "write") return;
		const path = (event.input as { path?: string }).path;
		if (isHarnessFile(path, guardPaths(ctx, cfgOf(ctx)))) return;
		if (!TEST_PHASES.includes(state.phase)) return;
		const next = markDirty(state);
		if (next !== state) setState(next, ctx);
	});

	// -----------------------------------------------------------------------
	// ツール
	// -----------------------------------------------------------------------

	pi.registerTool({
		name: "harness_status",
		label: "Harness Status",
		description:
			"piHarness の状態を取得する。view: state = フロー・フェーズ・成果物・ループ回数・次にやること（既定）/ issues = 登録した Issue の進み具合 / usage = モデル利用量。ユーザーに「今どうなっている？」「進み具合は？」「どれくらい使った？」と聞かれたときに使う。",
		promptSnippet: "Show piHarness state, issue progress or model usage",
		parameters: Type.Object({
			view: Type.Optional(StringEnum(["state", "issues", "usage"] as const, { description: "表示する内容（既定: state）" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (params.view === "issues") {
				await refreshRegistryFromGitHub(ctx, cfgOf(ctx));
				return reply(progressTable(loadRegistry(ctx)));
			}
			if (params.view === "usage") {
				if (!state.itemDir) return reply("利用量の記録はまだありません。");
				return reply(usageMarkdown(loadUsage(ctx, state.itemDir), PROCESS_LABELS));
			}
			if (!isActive(state)) return reply("piHarness: 進行中のフローはありません。ユーザーの依頼に応じて harness_control で要件定義・実装・バグ修正を開始できます（開始前にユーザーの確認を取ります）。");
			return reply(buildContext(state, cfgOf(ctx), processIO(state, existsIn(ctx))));
		},
	});

	/** ツールから開始したフローは autoHandoff の設定にかかわらず新しいセッションで始める（ユーザーが確認済みのため） */
	let forceHandoff = false;

	pi.registerTool({
		name: "harness_control",
		label: "Harness Control",
		description:
			"ユーザーの自然言語の依頼から piHarness のフローを開始・操作する。実行前に必ずユーザーへ確認ダイアログを出し、承認された場合だけ実行する。" +
			"action: start_requirements（新しい機能・アプリを作りたい、要件を固めたい）/ start_implement（Issue を実装したい。issue に番号・URL・docs/issues/*.md、指定が無ければ next = 次に着手できる Issue）/ " +
			"start_bugfix（不具合を直したい。実装中なら完了後に合流）/ continue_loop（エスカレーション後にループを続けたい）/ rejoin（バグ修正を実装フローへ合流させたい）/ abort（フローをやめたい）。",
		promptSnippet: "Start or control a piHarness flow from the user's natural-language request (always confirmed by the user)",
		promptGuidelines: [
			"ユーザーが作りたいもの・実装したい Issue・直したい不具合を話したら、自分で作業を始めず harness_control で対応するフローの開始を提案する（ツールがユーザーに確認する）。",
			"依頼の意図がどのフローか曖昧なときは、harness_control を呼ぶ前にユーザーに聞く。ユーザーが取り消したら、無理に進めず意図を確認する。",
		],
		parameters: Type.Object({
			action: StringEnum(["start_requirements", "start_implement", "start_bugfix", "continue_loop", "rejoin", "abort"] as const),
			request: Type.String({ description: "ユーザーの依頼の要約（確認ダイアログに表示する）" }),
			topic: Type.Optional(Type.String({ description: "start_requirements: 作りたいもののテーマ" })),
			issue: Type.Optional(Type.String({ description: "start_implement: Issue 番号・URL・docs/issues/*.md・next" })),
			description: Type.Optional(Type.String({ description: "start_bugfix: バグの症状・再現手順" })),
		}),
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				throw new Error("ユーザーの確認が必要なため、確認ダイアログを出せない環境では実行できません。/req・/impl・/bugfix・/harness コマンドを案内してください。");
			}
			const cfg = cfgOf(ctx);
			const inProgress = isActive(state) && !["impl_done", "req_done", "bug_done"].includes(state.phase);
			const current = inProgress ? `${state.flow} / ${PHASE_LABELS[state.phase]}${state.issue ? `（${describeIssue(state.issue)}）` : ""}` : "";
			let title: string;
			const lines: string[] = [];
			let run: () => Promise<Prepared>;
			let replaces = false;

			switch (params.action) {
				case "start_requirements": {
					const topic = params.topic?.trim() ?? "";
					title = "要件定義を開始しますか？";
					lines.push(`テーマ: ${topic || "（未指定。ヒアリングで確認します）"}`, "新しいセッションでヒアリング（質問）から始めます。");
					run = async () => prepareRequirements(ctx, topic);
					replaces = inProgress;
					break;
				}
				case "start_implement": {
					const target = await resolveImplementTarget(ctx, cfg, params.issue?.trim() || "next");
					if ("error" in target) return reply(target.error);
					title = "Issue の実装を開始しますか？";
					lines.push(`Issue: ${describeIssue(target.issue)}${target.issue.url ? ` ${target.issue.url}` : ""}`, "新しいセッションで Issue とコードの読み込み → テスト/実装プランの作成から始めます。");
					run = async () => prepareImplement(ctx, cfg, target.issue, target.body);
					replaces = inProgress;
					break;
				}
				case "start_bugfix": {
					const description = params.description?.trim() || state.escalation?.detail || params.request;
					const joins = joinsImplementFlow();
					title = "バグ修正を開始しますか？";
					lines.push(`バグ: ${description}`, joins ? `完了後、実装フロー（${describeIssue(state.issue)}）のレビューへ合流します。` : "単独のバグ修正として新しいセッションで始めます。");
					run = async () => prepareBugfix(ctx, cfg, description);
					replaces = inProgress && !joins && state.flow !== "bugfix";
					break;
				}
				case "continue_loop": {
					if (state.phase !== "escalated") return reply("エスカレーション中ではないため、ループの継続はできません。");
					title = "ループを継続しますか？";
					lines.push(state.escalation?.detail ?? "", "修正ループのカウンタをリセットして続けます。");
					run = async () => {
						setState(resumeAfterEscalation(state, limitsOf(cfg)), ctx);
						if (sessionProcess !== processOf(state)) {
							// 別のセッションから再開する場合は、そのプロセスを新しいセッションで開き直す
							const proc = processOf(state);
							if (proc) setState({ ...state, pendingHandoff: { from: proc, to: proc, at: new Date().toISOString() } }, ctx);
							return { ok: true, message: "ループを継続します。" };
						}
						return { ok: true, message: "ループを継続します（カウンタをリセット）。これまでと異なるアプローチで原因を再分析してから修正してください。" };
					};
					break;
				}
				case "rejoin": {
					if (state.phase !== "bug_done" || !state.suspended) return reply("合流できるバグ修正フローがありません。");
					title = "実装フローへ合流しますか？";
					lines.push(`合流先: ${describeIssue(state.suspended.issue)}`, "新しいセッションでフルレビューから再開します。");
					run = async () => {
						setState(rejoinImplement(state, limitsOf(cfg)), ctx);
						return { ok: true, message: "実装フローへ合流します。" };
					};
					break;
				}
				case "abort": {
					if (!isActive(state)) return reply("進行中のフローはありません。");
					title = "フローを中止しますか？";
					lines.push(`中止するフロー: ${current || `${state.flow} / ${PHASE_LABELS[state.phase]}`}`, "成果物ファイルは残ります。");
					run = async () => {
						setState(finishFlow(state, "ユーザーが中止（自然言語）"), ctx);
						return { ok: true, message: "フローを中止しました。" };
					};
					break;
				}
			}
			if (replaces) lines.push("", `⚠ 進行中のフロー（${current}）は中断されます（成果物は残ります）。`);
			lines.push("", `依頼: ${params.request}`);

			// 開始・操作の前に必ずユーザーの確認を取る
			if (!(await ctx.ui.confirm(title, lines.join("\n")))) {
				return reply("ユーザーが取り消しました。何も実行していません。ユーザーの意図を確認してください。");
			}
			const result = await run();
			if (state.pendingHandoff) forceHandoff = true;
			return reply(result.message, !result.ok || params.action === "abort");
		},
	});

	pi.registerTool({
		name: "harness_ask",
		label: "Ask User",
		description:
			"ユーザーに質問して回答を得る。要件の曖昧な点を確認するときに使う。1 回の呼び出しで 1 論点。選択肢を渡すと選択式（自由入力も可）になる。質問と回答は作業ディレクトリの qa.md に記録され、後続のプロセスに引き継がれる。",
		promptSnippet: "Ask the user one clarifying question (optionally with choices) and get the answer",
		promptGuidelines: ["要件定義中は仕様が明確になるまで harness_ask で質問を繰り返す。推測で仕様を決めない。"],
		parameters: Type.Object({
			question: Type.String({ description: "質問文。背景と、なぜそれを決める必要があるかを 1〜2 文で含める" }),
			options: Type.Optional(Type.Array(Type.String(), { description: "選択肢（推奨があれば先頭に置き「(推奨)」と付ける）" })),
		}),
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) throw new Error("UI が利用できないため質問できません。質問内容をテキストで出力してユーザーの返信を待ってください。");
			let answer: string | undefined;
			if (params.options?.length) {
				const free = "（自由入力で回答する）";
				const choice = await ctx.ui.select(params.question, [...params.options, free]);
				answer = choice === free ? await ctx.ui.input(params.question) : choice;
			} else {
				answer = await ctx.ui.input(params.question);
			}
			const text = answer?.trim();
			if (isActive(state) && state.itemDir) {
				writeItemFile(ctx, pathsOf(state).qa, `\n### Q (${new Date().toISOString()})\n\n${params.question}\n\n**A:** ${text || "（回答なし）"}\n`, true);
			}
			if (!text) return reply("ユーザーは回答しませんでした（スキップ）。必要なら別の聞き方で再度質問してください。");
			return reply(`ユーザーの回答: ${text}`);
		},
	});

	pi.registerTool({
		name: "harness_phase",
		label: "Harness Phase",
		description:
			"ワークフローのフェーズを遷移する。承認・テスト合格・成果物の作成が必要な遷移は条件を満たさないと失敗する。承認依頼・テスト実行・レビュー記録・Issue 登録は専用ツールを使う。",
		promptSnippet: "Move the piHarness workflow to the next phase (validated)",
		parameters: Type.Object({
			to: StringEnum(ALL_PHASES as [Phase, ...Phase[]], { description: "遷移先フェーズ" }),
			note: Type.Optional(Type.String({ description: "遷移理由・成果の要約" })),
			testChangeReason: Type.Optional(
				Type.String({
					description:
						"テストの削除・スキップ追加・アサーション減少を検知して遷移が拒否された場合に限り、その変更が正当である理由（レビュー担当が検証する）",
				}),
			),
		}),
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!isActive(state)) throw new Error("アクティブなフローがありません。");
			const cfg = cfgOf(ctx);
			const gated = isTestGatedTransition(state.phase, params.to);
			// 合格時点から作業ツリーが変わっていれば（bash 経由の変更を含む）未テスト扱いにする
			if (gated && state.test.fingerprint && !state.test.dirty) {
				const current = await fingerprint(gitRun(ctx), ctx.cwd, gitExcludes(ctx, cfg));
				if (current && current !== state.test.fingerprint) setState(markDirty(state), ctx);
			}
			const next = transition(state, params.to, params.note);
			const required = requiredArtifact(state, params.to);
			if (required && !existsSync(join(ctx.cwd, required.path))) {
				throw new Error(
					`${params.to} へ進む前に成果物 ${required.path} を作成してください（${required.template} を使用）。` +
						"次のプロセスは新しいセッションで開始され、このファイルだけが引き継がれます。",
				);
			}
			if (gated) await checkTestIntegrity(ctx, cfg, params.testChangeReason);
			const from = state.phase;
			setState(next, ctx);

			// ヒアリング完了時、回答済みの未確定論点は退避する（次にヒアリングへ戻るときは新しい open-questions.md が必要）
			if (from === "req_clarify" && state.phase === "req_document") {
				const oq = pathsOf(state).openQuestions;
				if (existsSync(join(ctx.cwd, oq))) {
					renameSync(join(ctx.cwd, oq), join(ctx.cwd, pathsOf(state).dir, `open-questions-resolved-${timestamp()}.md`));
				}
			}

			if (state.phase === "bug_done") {
				if (!state.suspended) {
					setState(finishFlow(state, "バグ修正完了"), ctx);
					return reply("バグ修正フロー完了。修正内容・根本原因・追加したテストをユーザーに報告してください。");
				}
				let rejoin = true;
				if (ctx.hasUI) {
					const options = ["実装フローへ合流する（新しいセッションでコードレビューから再開）", "ここで止める（後で「合流して」と伝えるか /harness rejoin）"];
					rejoin = (await ctx.ui.select("バグ修正が完了しました。実装フローへ合流しますか？", options)) === options[0];
				}
				if (!rejoin) return reply("バグ修正完了。ユーザーは合流を保留しました。状況を報告して待機してください。", true);
				setState(rejoinImplement(state, limitsOf(cfgOf(ctx))), ctx);
				return reply(`バグ修正完了 → 実装フロー（${describeIssue(state.issue)}）へ合流します。合流後はフルレビューから再開します。`);
			}
			return reply(`フェーズを ${state.phase}（${PHASE_LABELS[state.phase]}）へ遷移しました。`);
		},
	});

	pi.registerTool({
		name: "harness_request_approval",
		label: "Request Approval",
		description:
			"人間の承認ゲート。要件定義書（kind: requirements）またはテスト/実装プラン（kind: plan）の承認をユーザーに依頼し、結果を返す。承認されるまで次のプロセスへは進めない。",
		promptSnippet: "Ask the human to approve requirements or the test/implementation plan (hard gate)",
		promptGuidelines: [
			"承認待ちの間にユーザーがチャットで承認・修正を伝えたら、発言だけで承認扱いにせず harness_request_approval をもう一度呼んで確認ダイアログで確定する。",
		],
		parameters: Type.Object({
			kind: StringEnum(["requirements", "plan"] as const),
			summary: Type.String({ description: "承認者向けの要約（目的・スコープ・主要な決定事項・リスク）" }),
			documents: Type.Array(Type.String(), { description: "レビュー対象ドキュメントのパス（cwd からの相対パス）", minItems: 1 }),
		}),
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const kind = params.kind as ApprovalKind;
			let documents = params.documents;
			if (kind === "plan") {
				const plan = pathsOf(state).plan;
				if (!existsSync(join(ctx.cwd, plan))) throw new Error(`プランは ${plan} に作成してください（次のプロセスへはこのファイルが引き継がれます）。`);
				documents = [plan, ...documents.filter((d) => d !== plan)];
			}
			const missing = documents.filter((d) => !existsSync(join(ctx.cwd, d)));
			if (missing.length) throw new Error(`ドキュメントが見つかりません: ${missing.join(", ")}`);
			setState(beginApproval(state, kind, documents), ctx);

			const label = kind === "requirements" ? "要件定義" : "テスト/実装プラン";
			const warning = kind === "plan" ? planSizeWarning(ctx, cfgOf(ctx)) : undefined;
			if (!ctx.hasUI) {
				return reply(
					`${warning ? `${warning}\n` : ""}${label}の承認待ちです。ドキュメント (${documents.join(", ")}) と要約をユーザーに提示し、` +
						"ユーザーがチャットで承認・修正を伝えたら harness_request_approval を再度呼んで確認ダイアログで確定する（/harness approve・/harness revise でも可）。",
					true,
				);
			}
			const options = ["承認する", "修正を依頼する", "却下する（フローを中止）"];
			const title = `【${label}の承認依頼】\n${warning ? `${warning}\n` : ""}${params.summary.slice(0, 1500)}\n\n対象: ${documents.join(", ")}`;
			const choice = await ctx.ui.select(title, options);
			if (choice === undefined) {
				return reply(
					`${label}の承認は保留されました。ユーザーがドキュメントを確認中です。作業を止めて待ち、ユーザーがチャットで承認・修正を伝えたら harness_request_approval を再度呼んで確定してください（/harness approve・/harness revise でも可）。`,
					true,
				);
			}
			const decision: ApprovalDecision = choice === options[0] ? "approved" : choice === options[1] ? "revise" : "rejected";
			let comment: string | undefined;
			if (decision === "revise") comment = (await ctx.ui.editor(`${label}への修正依頼`, "")) || undefined;
			if (decision === "approved") comment = (await ctx.ui.input("承認コメント（任意）")) || undefined;
			setState(applyApproval(state, kind, decision, comment, documents), ctx);
			return reply(approvalMessage(kind, decision, comment), decision === "rejected");
		},
	});

	/** プランのテストケースが多すぎる場合の警告（1 セッションで扱える大きさを超えそうなら Issue の分割を促す） */
	function planSizeWarning(ctx: ExtensionContext, cfg: HarnessConfig): string | undefined {
		const file = join(ctx.cwd, pathsOf(state).plan);
		if (!existsSync(file)) return undefined;
		const cases = readFileSync(file, "utf8").match(/^\|\s*T\d+\s*\|/gm)?.length ?? 0;
		if (cases <= cfg.issueLimits.maxPlanTestCases) return undefined;
		return `⚠ テストケースが ${cases} 件あります（目安 ${cfg.issueLimits.maxPlanTestCases} 件以下）。1 セッションで扱うには大きいため、Issue の分割を検討してください。`;
	}

	function approvalMessage(kind: ApprovalKind, decision: ApprovalDecision, comment?: string): string {
		const c = comment ? `\nユーザーのコメント: ${comment}` : "";
		if (decision === "approved") return `${kind === "requirements" ? "要件定義" : "テスト/実装プラン"}が承認されました。${c}`;
		if (decision === "revise") {
			return `修正を依頼されました。${c}\n指摘を反映して${kind === "requirements" ? "要件定義書" : "プラン"}を更新し、再度 harness_request_approval してください。不明点は harness_ask で確認すること。`;
		}
		return `却下されました。フローを中止しました。${c}\n作業を止めてください。`;
	}

	pi.registerTool({
		name: "harness_run_tests",
		label: "Run Tests",
		description:
			"設定されたテストスイート全体を実行し、テストループを進める。expect: red は TDD の Red 確認/バグ再現（失敗が期待値）、green は合格が期待値。green の連続失敗が上限に達するとユーザーへエスカレーションする。",
		promptSnippet: "Run the full test suite and advance the TDD/test-fix loop (red or green expected)",
		promptGuidelines: [
			"テスト失敗時は出力から原因を分析し、仮説と修正内容を説明してから修正して harness_run_tests を再実行する。",
			"部分的なテスト実行は bash で行ってよいが、ループの判定とフェーズ遷移には harness_run_tests（全体実行）の結果のみが使われる。",
		],
		parameters: Type.Object({
			expect: StringEnum(["red", "green"] as const, { description: "red: 失敗を期待 / green: 合格を期待" }),
			reason: Type.Optional(Type.String({ description: "何を確認する実行か（前回失敗の原因分析と修正内容など）" })),
		}),
		executionMode: "sequential",
		async execute(_id, params, signal, _onUpdate, ctx) {
			if (!TEST_PHASES.includes(state.phase)) {
				throw new TransitionError(`現在のフェーズ (${state.phase}) ではテストループは実行できません。`);
			}
			const cfg = cfgOf(ctx);
			let command = cfg.testCommand;
			if (!command && ctx.hasUI) {
				command = (await ctx.ui.input("テストコマンドが未設定です。テストスイート全体を実行するコマンドを入力してください", "npm test"))?.trim();
				if (command) saveConfigPatch(ctx.cwd, { testCommand: command });
			}
			if (!command) throw new Error("テストコマンドが未設定です。.pi/harness.json の testCommand を設定してください。");

			// green 判定ではテストに加えて lint・型チェックなどのチェックも合格を必須にする
			const commands = [
				{ label: "テスト", command },
				...(params.expect === "green" ? cfg.checkCommands.map((c) => ({ label: "チェック", command: c })) : []),
			];
			const runs: { label: string; command: string; code: number; killed: boolean; secs: string; output: string }[] = [];
			for (const c of commands) {
				const started = Date.now();
				const result = await pi.exec("bash", ["-lc", c.command], { cwd: ctx.cwd, timeout: cfg.testTimeoutSec * 1000, signal });
				runs.push({
					...c,
					code: result.code,
					killed: result.killed,
					secs: ((Date.now() - started) / 1000).toFixed(1),
					output: `${result.stdout}\n${result.stderr}`,
				});
			}
			const ok = (r: (typeof runs)[number]) => r.code === 0 && !r.killed;
			const passed = runs.every(ok);
			const log = writeItemFile(
				ctx,
				join(pathsOf(state).logs, `test-${timestamp()}.log`),
				`# phase=${state.phase} expect=${params.expect}\n# reason: ${params.reason ?? ""}\n` +
					runs.map((r) => `\n$ ${r.command}\n# exit=${r.code} killed=${r.killed} ${r.secs}s\n\n${r.output}`).join("\n"),
			);
			// モデルに渡す出力は必要な分だけ: 合格時は要約のみ、Red 確認は失敗理由の確認に足る分、失敗時は失敗したコマンドの末尾
			const shown = runs.find((r) => !ok(r)) ?? runs[0];
			const lines = passed ? 0 : params.expect === "red" ? Math.min(cfg.testOutputLines, RED_OUTPUT_LINES) : cfg.testOutputLines;
			const summary = runs
				.map((r) => `$ ${r.command}\n  → ${ok(r) ? "PASS" : "FAIL"} (exit ${r.code}${r.killed ? ", タイムアウト/中断" : ""}, ${r.secs}s)`)
				.join("\n");
			let header = `${summary}\n結果: ${passed ? "PASS" : "FAIL"}\n全ログ: ${log}${lines ? "" : "（出力は省略。必要ならログを読む）"}\n\n`;
			if (lines) {
				const { text: tail, truncated } = tailLines(shown.output, lines);
				header += `[${shown.label}の出力の末尾${truncated ? `・先頭 ${truncated} 行を省略` : ""}: ${shown.command}]\n${tail}\n\n`;
			}
			// 実行後の作業ツリーの指紋（合格後に bash 経由でファイルが変わってもレビューへ進めないようにする）
			const fp = passed && params.expect === "green" ? await fingerprint(gitRun(ctx), ctx.cwd, gitExcludes(ctx, cfg)) : undefined;

			const { state: next, outcome } = recordTestRun(state, params.expect, passed, log, fp);
			setState(next, ctx);
			switch (outcome.kind) {
				case "red_confirmed":
					return reply(`${header}Red を確認しました（期待どおり失敗）。失敗理由が「未実装/バグ」によるものか確認し、最小限の実装で Green にしてください。`);
				case "red_unexpected_pass":
					return reply(`${header}⚠ 失敗するはずのテストが合格しました。テストが要件やバグを捉えていません。テストを見直してください（ループ回数には数えません）。`);
				case "pass": {
					const p = pathsOf(state);
					const hint =
						state.phase === "impl_tdd"
							? `プランの全項目が完了していれば、実装レポート ${p.implementation} を書いて harness_phase で impl_review へ。残りがあれば次のテストを書く (Red)。`
							: state.phase === "impl_fix_review"
								? `指摘ごとの対応を ${p.fix(state.review.round)} に書いて harness_phase で impl_review へ。`
								: state.phase === "bug_fix"
									? `バグレポート ${p.bug(state.counters.bugs)} を完成させて harness_phase で bug_done へ。`
									: "次のステップへ進んでください。";
					return reply(`${header}✅ 全テスト合格。${hint}`);
				}
				case "fail":
					return reply(
						`${header}❌ テスト失敗（修正ループ ${outcome.failures}/${state.test.max}、残り ${outcome.remaining} 回）。\n` +
							"1) 失敗したテストとエラーを特定 2) 根本原因の仮説を立てる 3) 仮説を確認 4) 最小限の修正 5) harness_run_tests を再実行。\n" +
							"テストを弱める・スキップする・削除することで合格させてはいけません。",
					);
				case "escalate":
					return handleEscalation(ctx, `テスト修正ループが上限 (${outcome.failures} 周) に達しました（直近ログ: ${log}）`);
			}
		},
	});

	const FindingSchema = Type.Object({
		severity: StringEnum(["blocker", "major", "minor", "nit"] as const, {
			description: "blocker: 誤動作/データ破損/セキュリティ, major: 要件未達/重大な設計・テスト不足, minor: 改善推奨, nit: 好み",
		}),
		perspective: Type.String({ description: "観点（correctness, requirements, tests, security, performance, maintainability, ...）" }),
		title: Type.String(),
		detail: Type.String({ description: "問題の内容と根拠" }),
		file: Type.Optional(Type.String()),
		line: Type.Optional(Type.Number()),
		suggestion: Type.Optional(Type.String({ description: "修正案" })),
	});

	pi.registerTool({
		name: "harness_record_review",
		label: "Record Review",
		description:
			"コードレビュー結果を記録（review-<周回>.md に書き出し）し、レビューループを進める。ブロッキング指摘 (blocker/major) が無ければ実装完了、あれば指摘修正プロセスへ。上限周回でも残る場合はユーザーへエスカレーションする。",
		promptSnippet: "Record code review findings and advance the review loop",
		parameters: Type.Object({
			summary: Type.String({ description: "レビュー全体の所見" }),
			findings: Type.Array(FindingSchema, { description: "指摘一覧（無ければ空配列）" }),
		}),
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const cfg = cfgOf(ctx);
			const mode = reviewMode(state);
			const findings = params.findings as ReviewFinding[];
			const { state: recorded, outcome } = recordReview(state, findings, params.summary, cfg.blockingSeverities);
			// レビューした時点の作業ツリーを記録し、次の軽量レビューでは「ここからの差分」だけを見せる
			const snapshot = state.git ? await snapshotTree(gitRun(ctx), tempIndexFile(), gitExcludes(ctx, cfg)) : undefined;
			const next = snapshot ? { ...recorded, review: { ...recorded.review, snapshot } } : recorded;
			const report = writeItemFile(ctx, pathsOf(state).review(outcome.round), reviewMarkdown(outcome.round, mode, params.summary, findings, cfg));
			setState(next, ctx);
			switch (outcome.kind) {
				case "clean": {
					const finalized = await finalizeImplementation(ctx, cfg);
					return reply(
						`レビュー ${outcome.round} 周目（${mode === "full" ? "フル" : "軽量"}）: ブロッキング指摘なし。実装フロー完了です。記録: ${report}\n` +
							`${finalized}\n` +
							(outcome.nonBlocking ? `軽微な指摘 ${outcome.nonBlocking} 件はユーザーへの報告に含めてください（必要なら別 Issue 化を提案）。` : "") +
							"変更内容・テスト結果・レビュー結果・コミット/PR・利用量をユーザーに報告してください。",
					);
				}
				case "fix":
					return reply(
						`レビュー ${outcome.round} 周目: ブロッキング指摘 ${outcome.blocking} 件。記録: ${report}\n` +
							`指摘修正は新しいセッションで行います（レビューループ残り ${outcome.remaining} 周）。`,
					);
				case "escalate":
					return handleEscalation(ctx, `レビューループが上限 (${outcome.round} 周) に達してもブロッキング指摘 ${outcome.blocking} 件が残っています（記録: ${report}）`);
			}
		},
	});

	function reviewMarkdown(round: number, mode: string, summary: string, findings: ReviewFinding[], cfg: HarnessConfig): string {
		const rows = findings.map(
			(f, i) =>
				`### ${i + 1}. [${f.severity}${cfg.blockingSeverities.includes(f.severity) ? " 🔴" : ""}] ${f.title}\n\n` +
				`- 観点: ${f.perspective}\n${f.file ? `- 場所: ${f.file}${f.line ? `:${f.line}` : ""}\n` : ""}\n${f.detail}\n` +
				(f.suggestion ? `\n**修正案:** ${f.suggestion}\n` : ""),
		);
		return `# レビュー ${round} 周目（${mode === "full" ? "フルレビュー" : "軽量レビュー"}）\n\n対象: ${describeIssue(state.issue)}\n日時: ${new Date().toISOString()}\n\n## 所見\n\n${summary}\n\n## 指摘 (${findings.length} 件)\n\n${rows.join("\n") || "なし\n"}`;
	}

	pi.registerTool({
		name: "harness_create_issues",
		label: "Create Issues",
		description:
			"承認済みの要件から GitHub Issue を登録する（gh CLI 使用。使えない場合は docs/issues に Markdown で保存）。1 Issue = 1 機能のレビューしやすい小さな単位にし、本文に受け入れ条件を含めること。要件定義の承認後のみ実行可能。",
		promptSnippet: "Register small, feature-sized GitHub issues after requirements approval",
		parameters: Type.Object({
			issues: Type.Array(
				Type.Object({
					title: Type.String(),
					body: Type.String({ description: "Markdown 本文（背景・スコープ・受け入れ条件・テスト観点・参照ドキュメント）" }),
					size: StringEnum(["S", "M", "L"] as const, { description: "規模の見積もり: S = 〜100 行 / M = 〜300 行 / L = それ以上（L は分割が必要）" }),
					labels: Type.Optional(Type.Array(Type.String())),
					dependsOn: Type.Optional(Type.Array(Type.Number(), { description: "依存する Issue（この配列内の 0 始まりインデックス）" })),
				}),
				{ minItems: 1 },
			),
			dryRun: Type.Optional(Type.Boolean({ description: "true なら GitHub に登録せず Markdown として保存のみ" })),
		}),
		executionMode: "sequential",
		async execute(_id, params, signal, _onUpdate, ctx) {
			if (!canCreateIssues(state)) {
				throw new TransitionError("Issue 登録は要件定義が人間に承認された後（req_issues フェーズ）でのみ可能です。");
			}
			const cfg = cfgOf(ctx);
			const drafts = params.issues as IssueDraft[];
			const errors = validateDrafts(drafts, cfg.issueLimits);
			if (errors.length) throw new Error(`Issue 案に問題があります:\n- ${errors.join("\n- ")}`);

			if (ctx.hasUI) {
				const list = drafts.map((d, i) => `${i + 1}. ${d.title}`).join("\n");
				const ok = await ctx.ui.confirm(
					`${params.dryRun ? "Markdown に保存" : "GitHub に登録"}します（${drafts.length} 件）`,
					`${list}\n\nよろしいですか？`,
				);
				if (!ok) return reply("ユーザーが Issue 登録を取り消しました。分割案についてユーザーに確認してください。", true);
			}

			const useGh =
				!params.dryRun && (await pi.exec("gh", ["auth", "status"], { cwd: ctx.cwd, timeout: 30_000 }).catch(() => undefined))?.code === 0;
			const created: IssueRef[] = [];
			const failures: string[] = [];

			if (useGh && cfg.ensureLabels) {
				const labels = new Set([...cfg.issueLabels, ...drafts.flatMap((d) => d.labels ?? [])]);
				for (const l of labels) await pi.exec("gh", ghLabelCreateArgs(l, cfg.issueRepo), { cwd: ctx.cwd, timeout: 30_000, signal });
			}

			for (const [i, d] of drafts.entries()) {
				const labels = [...new Set([...cfg.issueLabels, ...(d.labels ?? [])])];
				const body = withDependencies(d, created);
				if (useGh) {
					const r = await pi.exec("gh", ghIssueCreateArgs(d.title, body, labels, cfg.issueRepo), { cwd: ctx.cwd, timeout: 60_000, signal });
					const parsed = parseIssueUrl(r.stdout);
					if (r.code !== 0 || !parsed.url) {
						failures.push(`${d.title}: ${(r.stderr || r.stdout).trim()}`);
						created.push({ title: d.title });
						continue;
					}
					created.push({ title: d.title, ...parsed });
				} else {
					const rel = join(cfg.docsDir, "issues", draftFileName(i, d.title));
					writeItemFile(ctx, rel, draftMarkdown(d, labels, body));
					created.push({ title: d.title, file: rel });
				}
			}

			const ok = created.filter((c) => c.url || c.file);
			const lines = ok.map((c) => `- ${c.number ? `#${c.number} ` : ""}${c.title} ${c.url ?? c.file ?? ""}`);
			writeItemFile(ctx, join(pathsOf(state).dir, "issues.md"), `\n## ${new Date().toISOString()}\n\n${lines.join("\n")}\n`, true);
			if (failures.length) {
				setState(appendIssues(state, ok), ctx);
				const failedIds = new Set(created.filter((c) => !c.url && !c.file).map((c) => `title:${c.title}`));
				const reg = registerIssues(loadRegistry(ctx), drafts.map((d, i) => ({ ...created[i], dependsOn: d.dependsOn })), state.itemDir);
				saveRegistry(ctx, { ...reg, issues: reg.issues.filter((i) => !failedIds.has(i.id)) });
				return reply(
					`${ok.length}/${drafts.length} 件を登録しました:\n${lines.join("\n")}\n\n失敗 (${failures.length} 件):\n- ${failures.join("\n- ")}\n` +
						"失敗したものだけを修正して再度 harness_create_issues してください（登録済みのものは含めない）。",
				);
			}
			setState(recordIssues(state, ok), ctx);
			saveRegistry(
				ctx,
				registerIssues(
					loadRegistry(ctx),
					drafts.map((d, i) => ({ ...created[i], dependsOn: d.dependsOn })),
					state.itemDir,
				),
			);
			const where = useGh ? "GitHub に登録" : `Markdown として ${cfg.docsDir}/issues/ に保存${params.dryRun ? "" : "（gh CLI が未認証/未インストールのため）"}`;
			return reply(
				`${ok.length} 件の Issue を${where}しました:\n${lines.join("\n")}\n${usageSummaryLine(ctx) ?? ""}\n\n要件定義フロー完了。一覧と推奨着手順をユーザーに報告し、/impl next（依存関係から次の Issue を自動選択）または /impl <番号> で実装フローを開始できることを伝えてください。`,
			);
		},
	});

	// -----------------------------------------------------------------------
	// コマンド（ユーザー操作）
	// -----------------------------------------------------------------------

	async function confirmReplace(ctx: ExtensionContext, next: string): Promise<boolean> {
		if (!isActive(state) || !ctx.hasUI) return true;
		if (["impl_done", "req_done", "bug_done"].includes(state.phase) && !state.suspended) return true;
		return ctx.ui.confirm("進行中のフローがあります", `現在: ${state.flow} / ${PHASE_LABELS[state.phase]}\n破棄して ${next} を開始しますか？`);
	}

	type Prepared = { ok: boolean; message: string };

	/** 要件定義フローの状態を用意する（セッションはまだ開始しない。呼び出し側が開始する） */
	function prepareRequirements(ctx: ExtensionContext, topic: string): Prepared {
		const dir = newItemDir(ctx, `req-${timestamp().slice(0, 10)}-${slugify(topic || "requirements", 30)}`);
		setState(startRequirements(state, topic, limitsOf(cfgOf(ctx)), dir), ctx);
		return { ok: true, message: `要件定義フローを開始します（テーマ: ${topic || "未指定"}）。` };
	}

	pi.registerCommand("req", {
		description: "要件定義フローを新しいセッションで開始する（ヒアリング → 要件定義書 → 承認 → Issue 登録。各工程は別セッション）",
		handler: async (args, ctx) => {
			state = loadState(ctx);
			if (!(await confirmReplace(ctx, "要件定義フロー"))) return;
			let topic = args.trim();
			if (!topic && ctx.hasUI) topic = (await ctx.ui.input("何を作りたいですか？（テーマ・背景）"))?.trim() ?? "";
			prepareRequirements(ctx, topic);
			await startProcessSession(ctx);
		},
	});

	/** Issue 番号・URL・Markdown ファイルから Issue の情報と本文を得る */
	async function resolveIssue(ctx: ExtensionContext, cfg: HarnessConfig, arg: string): Promise<{ issue: IssueRef; body?: string } | undefined> {
		const file = arg.replace(/^file:/, "");
		if (/\.md$/i.test(file) && existsSync(join(ctx.cwd, file))) {
			const text = readFileSync(join(ctx.cwd, file), "utf8");
			const title =
				text.match(/^title:\s*"?(.+?)"?\s*$/m)?.[1]?.replace(/\\"/g, '"') ?? text.match(/^#\s+(.+)$/m)?.[1] ?? file;
			return { issue: { title, file: relative(ctx.cwd, join(ctx.cwd, file)) }, body: text };
		}
		const num = parseIssueArg(arg);
		if (!num) return undefined;
		const view = await pi
			.exec("gh", ["issue", "view", String(num), "--json", "number,title,body,url", ...(cfg.issueRepo ? ["--repo", cfg.issueRepo] : [])], {
				cwd: ctx.cwd,
				timeout: 60_000,
			})
			.catch(() => undefined);
		if (view?.code === 0) {
			try {
				const j = JSON.parse(view.stdout) as { number: number; title: string; body: string; url: string };
				return { issue: { number: j.number, title: j.title, url: j.url }, body: j.body };
			} catch {
				// 取得失敗時はプラン作成セッションで取得させる
			}
		}
		// 登録済みの Issue ならタイトルだけでも補う
		const known = loadRegistry(ctx).issues.find((i) => i.number === num);
		return { issue: { number: num, title: known?.title ?? "(タイトル未取得)", url: known?.url } };
	}

	/** GitHub 上で閉じられた Issue を完了扱いにする（gh が使える場合のみ） */
	async function refreshRegistryFromGitHub(ctx: ExtensionContext, cfg: HarnessConfig): Promise<void> {
		let reg = loadRegistry(ctx);
		const targets = reg.issues.filter((i) => i.number && i.status !== "done");
		if (targets.length === 0) return;
		const auth = await pi.exec("gh", ["auth", "status"], { cwd: ctx.cwd, timeout: 30_000 }).catch(() => undefined);
		if (auth?.code !== 0) return;
		for (const i of targets) {
			const r = await pi
				.exec("gh", ["issue", "view", String(i.number), "--json", "state", ...(cfg.issueRepo ? ["--repo", cfg.issueRepo] : [])], {
					cwd: ctx.cwd,
					timeout: 30_000,
				})
				.catch(() => undefined);
			if (r?.code === 0 && /"CLOSED"/.test(r.stdout)) reg = setStatus(reg, i, "done");
		}
		saveRegistry(ctx, reg);
	}

	/** 実装する Issue を決める（"next" なら依存関係から選ぶ） */
	async function resolveImplementTarget(
		ctx: ExtensionContext,
		cfg: HarnessConfig,
		arg: string,
	): Promise<{ issue: IssueRef; body?: string } | { error: string }> {
		if (arg === "next") {
			await refreshRegistryFromGitHub(ctx, cfg);
			const reg = loadRegistry(ctx);
			const { issue: next, blocked, inProgress } = nextIssue(reg);
			if (!next) {
				const why = inProgress.length
					? `実装中: ${inProgress.map((i) => i.id).join(", ")}`
					: blocked.length
						? `依存待ち: ${blocked.map((b) => `${b.issue.id}（${b.waitingFor.join(", ")} 待ち）`).join(", ")}`
						: "未着手の Issue はありません。";
				return { error: `着手できる Issue がありません。${why}\n\n${progressTable(reg)}` };
			}
			arg = next.number ? String(next.number) : (next.file ?? "");
		}
		const resolved = await resolveIssue(ctx, cfg, arg);
		return resolved ?? { error: "Issue 番号・URL・docs/issues/*.md のいずれか、または next を指定してください。" };
	}

	/** 実装フローの状態を用意する: 作業ブランチ・差分の基準・Issue 本文（セッションはまだ開始しない） */
	async function prepareImplement(ctx: ExtensionContext, cfg: HarnessConfig, issue: IssueRef, body: string | undefined): Promise<Prepared> {
		let git: GitInfo | undefined;
		const run = gitRun(ctx);
		if (cfg.git.enabled && (await isGitRepo(run))) {
			const dirty = await dirtyFiles(run, gitExcludes(ctx, cfg));
			if (dirty.length && cfg.git.dirtyStart !== "allow") {
				const list = dirty.slice(0, 10).join("\n") + (dirty.length > 10 ? `\n…ほか ${dirty.length - 10} 件` : "");
				if (cfg.git.dirtyStart === "refuse") return { ok: false, message: `未コミットの変更があるため開始できません（git.dirtyStart: refuse）:\n${list}` };
				if (ctx.hasUI && !(await ctx.ui.confirm("未コミットの変更があります", `${list}\n\nこの変更は作業ブランチに持ち込まれ、レビューの差分にも含まれます。続けますか？`))) {
					return { ok: false, message: "未コミットの変更があるため、ユーザーが開始を取り消しました。" };
				}
			}
			// 作成元: 設定 → 現在のブランチ。ただし別の作業ブランチ（前の Issue）上にいる場合は既定ブランチから切る
			const target = branchName(cfg.git.branchPrefix, issue);
			let startFrom = cfg.git.baseBranch;
			const cur = await currentBranch(run);
			if (!startFrom && cur && cur !== target && cfg.git.branchPrefix && cur.startsWith(cfg.git.branchPrefix)) {
				const def = await defaultBranch(run);
				if (def) {
					startFrom = def;
					if (ctx.hasUI) {
						const options = [`${def} から作成する（推奨）`, `現在の作業ブランチ ${cur} から作成する（積み上げ）`];
						const choice = await ctx.ui.select(`別の作業ブランチ ${cur} 上にいます。${target} をどこから作成しますか？`, options);
						if (choice === undefined) return { ok: false, message: "ブランチの作成元が選ばれなかったため、開始を取り消しました。" };
						if (choice === options[1]) startFrom = cur;
					}
				}
			}
			try {
				git = await prepareBranch(run, target, startFrom);
			} catch (e) {
				return { ok: false, message: `[piHarness] ${(e as Error).message}` };
			}
		}

		const base = issue.number ? `issue-${issue.number}` : `issue-${slugify((issue.file ?? issue.title).replace(/\.md$/, "").split("/").pop() ?? "local", 40)}`;
		setState({ ...startImplement(state, issue, limitsOf(cfg), newItemDir(ctx, base)), git }, ctx);
		saveRegistry(ctx, setStatus(loadRegistry(ctx), issue, "in_progress"));
		writeItemFile(
			ctx,
			pathsOf(state).issue,
			issue.file
				? `# ${issue.title}\n\n元ファイル: ${issue.file}\n\n${body ?? ""}\n`
				: body !== undefined
					? `# #${issue.number} ${issue.title}\n\nURL: ${issue.url}\n\n${body}\n`
					: `# Issue #${issue.number}\n\n（本文を自動取得できませんでした。\`gh issue view ${issue.number}\` や docs/issues/ から内容を確認し、このファイルに本文を保存してください）\n`,
		);
		return {
			ok: true,
			message: `${describeIssue(issue)} の実装フローを開始します。${git?.branch ? `作業ブランチ: ${git.branch}（差分の基準: ${git.base.slice(0, 12)}）` : ""}`,
		};
	}

	pi.registerCommand("impl", {
		description: "TDD 実装フローを新しいセッションで開始する: /impl <Issue番号 | Issue URL | docs/issues/*.md | next>",
		getArgumentCompletions: (prefix) => ("next".startsWith(prefix.trim()) ? [{ value: "next", label: "next（次に着手できる Issue）" }] : null),
		handler: async (args, ctx) => {
			state = loadState(ctx);
			const cfg = cfgOf(ctx);
			let arg = args.trim();
			if (!arg && ctx.hasUI) arg = (await ctx.ui.input("実装する Issue（番号 / URL / docs/issues/*.md / next）"))?.trim() ?? "";
			const target = await resolveImplementTarget(ctx, cfg, arg);
			if ("error" in target) {
				ctx.ui.notify(target.error, "info");
				return;
			}
			if (!(await confirmReplace(ctx, `${describeIssue(target.issue)} の実装フロー`))) return;
			const prepared = await prepareImplement(ctx, cfg, target.issue, target.body);
			ctx.ui.notify(prepared.message, prepared.ok ? "info" : "error");
			if (prepared.ok) await startProcessSession(ctx);
		},
	});

	function joinsImplementFlow(): boolean {
		return state.flow === "implement" || state.escalation?.flow === "implement";
	}

	/** バグ修正フローの状態を用意する（実装フロー中なら退避して完了後に合流。セッションはまだ開始しない） */
	async function prepareBugfix(ctx: ExtensionContext, cfg: HarnessConfig, description: string): Promise<Prepared> {
		setState(startBugfix(state, description, limitsOf(cfg), newItemDir(ctx, `bug-${timestamp()}`)), ctx);
		// 単独のバグ修正では現在の HEAD を差分の基準にする（ブランチは切らない）
		if (!state.git && cfg.git.enabled && (await isGitRepo(gitRun(ctx)))) {
			const head = await headSha(gitRun(ctx));
			if (head) setState({ ...state, git: { base: head, branch: await currentBranch(gitRun(ctx)) } }, ctx);
		}
		return {
			ok: true,
			message: `バグ修正フローを開始します${state.suspended ? `（完了後 ${describeIssue(state.suspended.issue)} の実装フローへ合流）` : ""}。`,
		};
	}

	pi.registerCommand("bugfix", {
		description: "独立したバグ修正フローを新しいセッションで開始する（完了後、中断中の実装フローへ合流）: /bugfix <バグの説明>",
		handler: async (args, ctx) => {
			state = loadState(ctx);
			const cfg = cfgOf(ctx);
			let description = args.trim();
			if (!description && ctx.hasUI) {
				description = (await ctx.ui.input("バグの内容（症状・再現手順）", state.escalation?.detail ?? ""))?.trim() ?? "";
			}
			if (!description) description = state.escalation?.detail ?? "";
			if (!joinsImplementFlow() && state.flow !== "bugfix" && !(await confirmReplace(ctx, "バグ修正フロー"))) return;
			await prepareBugfix(ctx, cfg, description);
			await startProcessSession(ctx);
		},
	});

	const SUBCOMMANDS = ["status", "next", "approve", "revise", "reject", "continue", "rejoin", "abort", "pr", "issues", "usage", "models", "config"];

	pi.registerCommand("harness", {
		description:
			"piHarness の操作: status | next | approve [コメント] | revise <修正内容> | reject | continue [指示] | rejoin | abort | pr | issues | usage [作業ディレクトリ] | models | config",
		getArgumentCompletions: (prefix) => SUBCOMMANDS.filter((s) => s.startsWith(prefix.trim())).map((s) => ({ value: s, label: s })),
		handler: async (args, ctx) => {
			const [sub = "status", ...rest] = args.trim().split(/\s+/);
			const text = rest.join(" ").trim();
			const cfg = cfgOf(ctx);
			state = loadState(ctx);
			try {
				switch (sub) {
					case "status": {
						const body = isActive(state) ? buildContext(state, cfg, processIO(state, existsIn(ctx))) : "アクティブなフローはありません。";
						const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "(未設定)";
						const recent = state.log.slice(-8).map((l) => `  ${l.at.slice(11, 19)} ${l.event}`).join("\n");
						ctx.ui.notify(`${body}\n現在のモデル: ${current}（thinking: ${pi.getThinkingLevel()}）\n\n最近のイベント:\n${recent || "  なし"}`, "info");
						return;
					}
					case "next": {
						// 次のプロセス（または中断中の現在のプロセス）を新しいセッションで開始する
						if (!isActive(state)) {
							ctx.ui.notify("アクティブなフローはありません。", "info");
							return;
						}
						if (state.phase === "escalated") {
							ctx.ui.notify("エスカレーション中です。/harness continue, /bugfix, /harness abort のいずれかを選んでください。", "warning");
							return;
						}
						await startProcessSession(ctx, text || undefined);
						return;
					}
					case "approve":
					case "revise":
					case "reject": {
						const kind: ApprovalKind | undefined =
							state.phase === "req_approval" ? "requirements" : state.phase === "impl_plan_approval" ? "plan" : undefined;
						if (!kind) {
							ctx.ui.notify(`承認待ちではありません（現在: ${state.phase}）`, "warning");
							return;
						}
						if (sub === "revise" && !text) {
							ctx.ui.notify("修正内容を指定してください: /harness revise <内容>", "error");
							return;
						}
						const decision: ApprovalDecision = sub === "approve" ? "approved" : sub === "revise" ? "revise" : "rejected";
						const docs = kind === "requirements" ? state.artifacts.docs : state.artifacts.plan ? [state.artifacts.plan] : [];
						setState(applyApproval(state, kind, decision, text || undefined, docs), ctx);
						if (decision === "approved") await startProcessSession(ctx);
						else if (decision === "revise") pi.sendUserMessage(approvalMessage(kind, decision, text || undefined));
						else ctx.ui.notify("却下しました。フローを中止しました。", "info");
						return;
					}
					case "continue": {
						setState(resumeAfterEscalation(state, limitsOf(cfg)), ctx);
						await startProcessSession(
							ctx,
							`エスカレーション後にユーザーがループ継続を選択しました（カウンタはリセット済み）。エスカレーション記録を読み、これまでと異なるアプローチで原因を再分析してください。${text ? ` ${text}` : ""}`,
						);
						return;
					}
					case "rejoin": {
						setState(rejoinImplement(state, limitsOf(cfg)), ctx);
						await startProcessSession(ctx);
						return;
					}
					case "abort": {
						if (!isActive(state)) {
							ctx.ui.notify("アクティブなフローはありません。", "info");
							return;
						}
						if (ctx.hasUI && !(await ctx.ui.confirm("フローを中止しますか？", `${state.flow} / ${PHASE_LABELS[state.phase]}`))) return;
						setState(finishFlow(state, text || "ユーザーが中止"), ctx);
						ctx.ui.notify("フローを中止しました。", "info");
						return;
					}
					case "pr": {
						if (state.phase !== "impl_done") {
							ctx.ui.notify(`PR は実装フロー完了後に作成できます（現在: ${state.phase}）`, "warning");
							return;
						}
						if (ctx.hasUI && cfg.git.pr !== "auto" && !(await ctx.ui.confirm("PR を作成しますか？", `ブランチ ${state.git?.branch ?? "-"} → ${state.git?.baseBranch ?? "-"}`))) return;
						ctx.ui.notify(await finalizeImplementation(ctx, cfg, { forcePr: true }), "info");
						return;
					}
					case "issues": {
						await refreshRegistryFromGitHub(ctx, cfg);
						ctx.ui.notify(`${progressTable(loadRegistry(ctx))}\n\n次の Issue は /impl next で開始できます。`, "info");
						return;
					}
					case "usage": {
						const dir = text || state.itemDir;
						if (!dir) {
							ctx.ui.notify("作業ディレクトリを指定してください: /harness usage .pi/harness/issue-12", "warning");
							return;
						}
						ctx.ui.notify(`モデル利用量（${dir}）:\n${usageMarkdown(loadUsage(ctx, dir), PROCESS_LABELS)}`, "info");
						return;
					}
					case "models": {
						const catalogue = ctx.modelRegistry.getAll();
						const describe = (refs: string[] | undefined) => {
							if (!refs) return "(Pi の既定)";
							return refs
								.map((ref) => {
									const found = findModel(ref, catalogue);
									if (!found.model) return `${ref} ⚠ ${found.error ?? ""}`;
									return ctx.modelRegistry.hasConfiguredAuth(found.model) ? ref : `${ref} ⚠ 認証が未設定`;
								})
								.join(" → ");
						};
						const rows: string[] = [];
						for (const proc of PROCESS_KINDS) {
							const variants = proc === "review" ? (["review_full", "review_light"] as const) : [undefined];
							for (const v of variants) {
								const setting = resolveProcessModel(cfg.models, proc, v);
								const label = v === "review_full" ? "レビュー(フル)" : v === "review_light" ? "レビュー(軽量)" : PROCESS_LABELS[proc];
								rows.push(`  ${label.padEnd(12, "　")} ${describe(setting.model)}${setting.thinking ? `  thinking: ${setting.thinking}` : ""}`);
							}
						}
						ctx.ui.notify(`プロセスごとのモデル（.pi/harness.json の models。→ はフォールバック順）:\n${rows.join("\n")}`, "info");
						return;
					}
					case "config": {
						ctx.ui.notify(`piHarness 設定 (.pi/harness.json + 自動検出):\n${JSON.stringify(cfg, null, 2)}`, "info");
						return;
					}
					default:
						ctx.ui.notify(`不明なサブコマンド: ${sub}\n使い方: /harness ${SUBCOMMANDS.join(" | ")}`, "error");
				}
			} catch (e) {
				ctx.ui.notify(`[piHarness] ${(e as Error).message}`, "error");
			}
		},
	});
}
