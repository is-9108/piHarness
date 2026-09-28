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
import { dirname, join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { findModel, type HarnessConfig, loadConfig, PROCESS_KINDS, resolveProcessModel, saveConfigPatch } from "./config.ts";
import { checkBash, checkWrite, type GuardPaths, isHarnessFile, STATE_FILE } from "./guard.ts";
import { buildContext } from "./guidance.ts";
import {
	escalationMarkdown,
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
	type ApprovalDecision,
	type ApprovalKind,
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

const CONTEXT_MESSAGE = "harness-context";
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
		ctx.ui.setStatus("harness", line ? `🧭 ${line}` : undefined);
	}

	function writeItemFile(ctx: { cwd: string }, rel: string, content: string, append = false): string {
		const abs = join(ctx.cwd, rel);
		mkdirSync(dirname(abs), { recursive: true });
		if (append) appendFileSync(abs, content);
		else writeFileSync(abs, content);
		return rel;
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

	/**
	 * 現在のプロセスを新しいセッションで開始する（コマンドからのみ呼べる）。
	 * 引き継ぎ内容を handoff.md に記録してから state.json を保存し、新セッションで開始メッセージを送る。
	 */
	async function startProcessSession(ctx: ExtensionCommandContext, note?: string): Promise<void> {
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
					"ユーザーは /harness continue（ループ継続）, /bugfix（独立したバグ修正フロー）, /harness abort（中止）から選べます。",
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
				"再開は /harness continue、バグ修正フローは /bugfix です。",
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
		const setting = resolveProcessModel(cfgOf(ctx).models, proc);
		const applied: string[] = [];
		if (setting.model) {
			// getAvailable() は起動直後に認証状態の反映が遅れることがあるため、全カタログから探して認証は setModel に判定させる
			const { model, error } = findModel(setting.model, ctx.modelRegistry.getAll());
			if (!model) {
				ctx.ui.notify(`[piHarness] ${PROCESS_LABELS[proc]}: ${error} 既定のモデルを使用します。`, "warning");
			} else if (!(await setModelWhenReady(ctx, model))) {
				ctx.ui.notify(`[piHarness] ${PROCESS_LABELS[proc]}: ${setting.model} の認証が設定されていません。既定のモデルを使用します。`, "warning");
			} else {
				applied.push(`${model.provider}/${model.id}`);
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

	pi.on("session_start", async (_e, ctx) => {
		state = loadState(ctx);
		if (state.kickoff) {
			const proc = state.kickoff;
			setState({ ...state, kickoff: undefined }, ctx);
			const applied = await applyProcessModel(ctx, proc);
			if (applied) ctx.ui.notify(`piHarness: ${PROCESS_LABELS[proc]} のモデル → ${applied}`, "info");
		}
		refreshUI(ctx);
		const { warnings } = loadConfig(ctx.cwd);
		for (const w of warnings) ctx.ui.notify(`[piHarness] ${w}`, "warning");
		if (state.pendingHandoff) {
			ctx.ui.notify(`piHarness: 「${PROCESS_LABELS[state.pendingHandoff.to]}」の開始待ちです。/harness next で開始します。`, "info");
		}
	});

	// 現在のプロセス・入出力成果物・次の行動をエージェントに伝える
	pi.on("before_agent_start", async (_e, ctx) => {
		if (!isActive(state)) return;
		const proc = processOf(state);
		if (proc && !pi.getSessionName()) {
			const who = state.issue?.number ? `#${state.issue.number} ` : state.topic ? `${state.topic} ` : "";
			pi.setSessionName(`[harness] ${who}${PROCESS_LABELS[proc]}`);
		}
		return {
			message: {
				customType: CONTEXT_MESSAGE,
				content: buildContext(state, cfgOf(ctx), processIO(state, existsIn(ctx))),
				display: false,
			},
		};
	});

	// 古いフェーズ情報がコンテキストに積み重ならないよう、最新のもの以外を除去する
	pi.on("context", async (event) => {
		const isCtx = (m: AgentMessage) => (m as { customType?: string }).customType === CONTEXT_MESSAGE;
		let lastIndex = -1;
		event.messages.forEach((m, i) => {
			if (isCtx(m)) lastIndex = i;
		});
		if (lastIndex < 0) return;
		return { messages: event.messages.filter((m, i) => !isCtx(m) || (i === lastIndex && isActive(state))) };
	});

	// プロセスが終わったら、エージェントが止まった時点で次のプロセスを新しいセッションで開始する
	pi.on("agent_settled", async (_e, ctx) => {
		if (!state.pendingHandoff) return;
		if (cfgOf(ctx).autoHandoff) {
			pi.sendUserMessage("/harness next", { expandPromptTemplates: true });
		} else {
			ctx.ui.notify(`次のプロセス「${PROCESS_LABELS[state.pendingHandoff.to]}」は /harness next で新しいセッションとして開始します。`, "info");
		}
	});

	// 承認ゲート前のコード変更・状態ファイルの改ざん・プロセス完了後の作業をブロック
	pi.on("tool_call", async (event, ctx) => {
		const cfg = cfgOf(ctx);
		if (event.toolName === "edit" || event.toolName === "write") {
			const d = checkWrite(state, (event.input as { path?: string }).path, guardPaths(ctx, cfg));
			if (d.block) return { block: true, reason: d.reason };
		}
		if (!isActive(state)) return;
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
		description: "piHarness のワークフロー状態（フロー・フェーズ・プロセスの入出力成果物・ループ回数・次にやること）を取得する。",
		promptSnippet: "Show piHarness workflow state (process, artifacts, loop counters, next action)",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			if (!isActive(state)) return reply("piHarness: アクティブなフローはありません。/req, /impl, /bugfix で開始できます。");
			return reply(buildContext(state, cfgOf(ctx), processIO(state, existsIn(ctx))));
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
		}),
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!isActive(state)) throw new Error("アクティブなフローがありません。");
			const next = transition(state, params.to, params.note);
			const required = requiredArtifact(state, params.to);
			if (required && !existsSync(join(ctx.cwd, required.path))) {
				throw new Error(
					`${params.to} へ進む前に成果物 ${required.path} を作成してください（${required.template} を使用）。` +
						"次のプロセスは新しいセッションで開始され、このファイルだけが引き継がれます。",
				);
			}
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
					const options = ["実装フローへ合流する（新しいセッションでコードレビューから再開）", "ここで止める（後で /harness rejoin）"];
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
			if (!ctx.hasUI) {
				return reply(
					`${label}の承認待ちです。ドキュメント (${documents.join(", ")}) と要約をユーザーに提示し、` +
						"/harness approve [コメント] または /harness revise <修正内容> の入力を待ってください。",
					true,
				);
			}
			const options = ["承認する", "修正を依頼する", "却下する（フローを中止）"];
			const title = `【${label}の承認依頼】\n${params.summary.slice(0, 1500)}\n\n対象: ${documents.join(", ")}`;
			const choice = await ctx.ui.select(title, options);
			if (choice === undefined) {
				return reply(
					`${label}の承認は保留されました。ユーザーがドキュメントを確認中です。作業を止め、/harness approve または /harness revise を待ってください。`,
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

			const started = Date.now();
			const result = await pi.exec("bash", ["-lc", command], { cwd: ctx.cwd, timeout: cfg.testTimeoutSec * 1000, signal });
			const secs = ((Date.now() - started) / 1000).toFixed(1);
			const passed = result.code === 0 && !result.killed;
			const output = `${result.stdout}\n${result.stderr}`;
			const log = writeItemFile(
				ctx,
				join(pathsOf(state).logs, `test-${timestamp()}.log`),
				`$ ${command}\n# phase=${state.phase} exit=${result.code} killed=${result.killed} ${secs}s expect=${params.expect}\n# reason: ${params.reason ?? ""}\n\n${output}`,
			);
			const { text: tail, truncated } = tailLines(output, cfg.testOutputLines);
			const header =
				`$ ${command}\n結果: ${passed ? "PASS" : "FAIL"} (exit ${result.code}${result.killed ? ", タイムアウト/中断" : ""}, ${secs}s)` +
				`\n全ログ: ${log}${truncated ? `（先頭 ${truncated} 行を省略）` : ""}\n\n${tail}\n\n`;

			const { state: next, outcome } = recordTestRun(state, params.expect, passed, log);
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
			const { state: next, outcome } = recordReview(state, findings, params.summary, cfg.blockingSeverities);
			const report = writeItemFile(ctx, pathsOf(state).review(outcome.round), reviewMarkdown(outcome.round, mode, params.summary, findings, cfg));
			setState(next, ctx);
			switch (outcome.kind) {
				case "clean":
					return reply(
						`レビュー ${outcome.round} 周目（${mode === "full" ? "フル" : "軽量"}）: ブロッキング指摘なし。実装フロー完了です。記録: ${report}\n` +
							(outcome.nonBlocking ? `軽微な指摘 ${outcome.nonBlocking} 件はユーザーへの報告に含めてください（必要なら別 Issue 化を提案）。` : "") +
							"変更内容・テスト結果・レビュー結果をユーザーに報告してください。",
					);
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
			const errors = validateDrafts(drafts);
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
				return reply(
					`${ok.length}/${drafts.length} 件を登録しました:\n${lines.join("\n")}\n\n失敗 (${failures.length} 件):\n- ${failures.join("\n- ")}\n` +
						"失敗したものだけを修正して再度 harness_create_issues してください（登録済みのものは含めない）。",
				);
			}
			setState(recordIssues(state, ok), ctx);
			const where = useGh ? "GitHub に登録" : `Markdown として ${cfg.docsDir}/issues/ に保存${params.dryRun ? "" : "（gh CLI が未認証/未インストールのため）"}`;
			return reply(
				`${ok.length} 件の Issue を${where}しました:\n${lines.join("\n")}\n\n要件定義フロー完了。一覧と推奨着手順をユーザーに報告し、/impl <番号> で実装フローを開始できることを伝えてください。`,
			);
		},
	});

	// -----------------------------------------------------------------------
	// コマンド（ユーザー操作）
	// -----------------------------------------------------------------------

	async function confirmReplace(ctx: ExtensionContext, next: string): Promise<boolean> {
		if (!isActive(state) || !ctx.hasUI) return true;
		return ctx.ui.confirm("進行中のフローがあります", `現在: ${state.flow} / ${PHASE_LABELS[state.phase]}\n破棄して ${next} を開始しますか？`);
	}

	pi.registerCommand("req", {
		description: "要件定義フローを新しいセッションで開始する（ヒアリング → 要件定義書 → 承認 → Issue 登録。各工程は別セッション）",
		handler: async (args, ctx) => {
			state = loadState(ctx);
			if (!(await confirmReplace(ctx, "要件定義フロー"))) return;
			let topic = args.trim();
			if (!topic && ctx.hasUI) topic = (await ctx.ui.input("何を作りたいですか？（テーマ・背景）"))?.trim() ?? "";
			const dir = newItemDir(ctx, `req-${timestamp().slice(0, 10)}-${slugify(topic || "requirements", 30)}`);
			setState(startRequirements(state, topic, limitsOf(cfgOf(ctx)), dir), ctx);
			await startProcessSession(ctx);
		},
	});

	pi.registerCommand("impl", {
		description: "TDD 実装フローを新しいセッションで開始する: /impl <Issue番号 | Issue URL>",
		handler: async (args, ctx) => {
			state = loadState(ctx);
			let arg = args.trim();
			if (!arg && ctx.hasUI) arg = (await ctx.ui.input("実装する Issue 番号または URL"))?.trim() ?? "";
			const num = parseIssueArg(arg);
			if (!num) {
				ctx.ui.notify("Issue 番号または URL を指定してください: /impl 12", "error");
				return;
			}
			if (!(await confirmReplace(ctx, `Issue #${num} の実装フロー`))) return;
			const cfg = cfgOf(ctx);
			const view = await pi
				.exec("gh", ["issue", "view", String(num), "--json", "number,title,body,url", ...(cfg.issueRepo ? ["--repo", cfg.issueRepo] : [])], {
					cwd: ctx.cwd,
					timeout: 60_000,
				})
				.catch(() => undefined);
			let issue: IssueRef = { number: num, title: "(タイトル未取得)" };
			let body: string | undefined;
			if (view?.code === 0) {
				try {
					const j = JSON.parse(view.stdout) as { number: number; title: string; body: string; url: string };
					issue = { number: j.number, title: j.title, url: j.url };
					body = j.body;
				} catch {
					// 取得失敗時はプラン作成セッションで取得させる
				}
			}
			setState(startImplement(state, issue, limitsOf(cfg), newItemDir(ctx, `issue-${num}`)), ctx);
			writeItemFile(
				ctx,
				pathsOf(state).issue,
				body !== undefined
					? `# #${issue.number} ${issue.title}\n\nURL: ${issue.url}\n\n${body}\n`
					: `# Issue #${num}\n\n（本文を自動取得できませんでした。\`gh issue view ${num}\` や docs/issues/ から内容を確認し、このファイルに本文を保存してください）\n`,
			);
			await startProcessSession(ctx);
		},
	});

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
			const joinsImplement = state.flow === "implement" || state.escalation?.flow === "implement";
			if (!joinsImplement && state.flow !== "bugfix" && !(await confirmReplace(ctx, "バグ修正フロー"))) return;
			setState(startBugfix(state, description, limitsOf(cfg), newItemDir(ctx, `bug-${timestamp()}`)), ctx);
			await startProcessSession(ctx);
		},
	});

	const SUBCOMMANDS = ["status", "next", "approve", "revise", "reject", "continue", "rejoin", "abort", "models", "config"];

	pi.registerCommand("harness", {
		description:
			"piHarness の操作: status | next | approve [コメント] | revise <修正内容> | reject | continue [指示] | rejoin | abort | models | config",
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
					case "models": {
						const catalogue = ctx.modelRegistry.getAll();
						const rows = PROCESS_KINDS.map((proc) => {
							const setting = resolveProcessModel(cfg.models, proc);
							const found = setting.model ? findModel(setting.model, catalogue) : undefined;
							const model = !setting.model
								? "(Pi の既定)"
								: !found?.model
									? `${setting.model} ⚠ ${found?.error ?? ""}`
									: ctx.modelRegistry.hasConfiguredAuth(found.model)
										? setting.model
										: `${setting.model} ⚠ 認証が未設定`;
							return `  ${PROCESS_LABELS[proc].padEnd(12, "　")} ${model}${setting.thinking ? `  thinking: ${setting.thinking}` : ""}`;
						});
						ctx.ui.notify(`プロセスごとのモデル（.pi/harness.json の models）:\n${rows.join("\n")}`, "info");
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
