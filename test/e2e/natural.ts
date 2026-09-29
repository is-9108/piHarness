/**
 * E2E: TUI での自然言語のやり取りからフローを開始する。
 * コマンドを使わず「〜を作りたい」と話すと harness_control が呼ばれ、必ず確認ダイアログが出て、
 * 承認したときだけ新しいセッションでプロセスが始まることを確認する（確認ダイアログの応答はスクリプトで与える）。
 *
 *   node test/e2e/natural.ts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	type ExtensionUIContext,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

const root = resolve(import.meta.dirname, "../..");
const project = mkdtempSync(join(tmpdir(), "pih-nl-"));
const agentDir = mkdtempSync(join(tmpdir(), "pih-agent-"));
mkdirSync(join(project, "docs/issues"), { recursive: true });
writeFileSync(join(project, ".gitignore"), "");
writeFileSync(join(project, "docs/issues/01-login.md"), "---\ntitle: \"ログイン API\"\n---\n\n# ログイン API\n\n## 受け入れ条件\n\n- [ ] 200 を返す\n");

// ブランチ表示の確認のため git リポジトリにする
const git = (...args: string[]) => execFileSync("git", args, { cwd: project, encoding: "utf8" }).trim();
git("init", "-q", "-b", "main");
git("config", "user.name", "t");
git("config", "user.email", "t@example.com");
git("add", "-A");
git("commit", "-q", "-m", "init");

const faux = fauxProvider({ models: [{ id: "m" }] });
const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const say = (text: string) => fauxAssistantMessage(text);

// 確認ダイアログの応答（順番に使う）と、表示された内容の記録
const confirmAnswers: boolean[] = [];
const confirms: { title: string; message: string }[] = [];
// 選択ダイアログの応答（選択肢の先頭一致。順番に使う）と、表示された内容の記録
const selectAnswers: string[] = [];
const selects: { title: string; options: string[] }[] = [];
// ダッシュボード（setWidget）と作業中表示（setWorkingMessage）の記録
let widget: string[] = [];
const working: string[] = [];
// Pi は UI コンテキストのメソッドを個別に参照するので、必要なメソッドをすべて持つ素のオブジェクトにする
const noop = () => undefined;
const methods = [
	"notify", "onTerminalInput", "setStatus", "setWorkingMessage", "setWorkingVisible", "setWorkingIndicator", "setHiddenThinkingLabel",
	"setWidget", "setFooter", "setHeader", "setTitle", "custom", "pasteToEditor", "setEditorText", "getEditorText", "addAutocompleteProvider",
	"setEditorComponent", "getEditorComponent", "getAllThemes", "getTheme", "setTheme", "getToolsExpanded", "setToolsExpanded",
];
const ui = Object.fromEntries(methods.map((m) => [m, noop])) as unknown as ExtensionUIContext;
Object.assign(ui, {
	setWidget: (key: string, content: string[] | undefined) => {
		if (key === "harness") widget = content ?? [];
	},
	setWorkingMessage: (m?: string) => {
		if (m) working.push(m);
	},
	confirm: async (title: string, message: string) => {
		confirms.push({ title, message });
		return confirmAnswers.shift() ?? false;
	},
	select: async (title: string, options: string[]) => {
		selects.push({ title, options });
		const a = selectAnswers.shift();
		return a === undefined ? undefined : options.find((o) => o.startsWith(a));
	},
	input: async () => undefined,
	editor: async () => undefined,
});

const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
	const services = await createAgentSessionServices({
		cwd,
		agentDir,
		settingsManager: SettingsManager.inMemory(),
		resourceLoaderOptions: {
			additionalExtensionPaths: [join(root, "extensions/harness/index.ts")],
			additionalSkillPaths: [join(root, "skills")],
			extensionFactories: [(pi) => pi.registerProvider(faux.provider)],
		},
	});
	const created = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model: faux.getModel() });
	return { ...created, services, diagnostics: services.diagnostics };
};
const runtime = await createAgentSessionRuntime(createRuntime, { cwd: project, agentDir, sessionManager: SessionManager.inMemory() });
const sessions: AgentSession[] = [];
const results: string[] = [];
const bind = async () => {
	const session = runtime.session;
	await session.bindExtensions({
		uiContext: ui,
		mode: "tui",
		commandContextActions: {
			waitForIdle: () => session.waitForIdle(),
			newSession: (o) => runtime.newSession(o),
			fork: async (id, o) => ({ cancelled: (await runtime.fork(id, o)).cancelled }),
			navigateTree: async () => ({ cancelled: true }),
			switchSession: (p, o) => runtime.switchSession(p, o),
			reload: () => session.reload(),
		},
	});
	const no = sessions.push(session);
	session.subscribe((e) => {
		if (e.type === "tool_execution_end") {
			const text = (e.result?.content ?? []).map((c: { text?: string }) => c.text ?? "").join("");
			results.push(`${no}:${e.toolName}${e.isError ? " [ERROR]" : ""}: ${text.split("\n")[0]}`);
		}
	});
};
runtime.setRebindSession(bind);
await bind();

async function talk(text: string, responses: ReturnType<typeof say>[]): Promise<void> {
	faux.setResponses(responses);
	await runtime.session.prompt(text);
	for (let i = 0; i < 100 && (faux.getPendingResponseCount() > 0 || !runtime.session.isIdle); i++) {
		await new Promise((r) => setTimeout(r, 50));
		await runtime.session.waitForIdle();
	}
	await new Promise((r) => setTimeout(r, 150));
	await runtime.session.waitForIdle();
	assert.equal(faux.getPendingResponseCount(), 0, `未消費の応答: ${text}`);
}
const state = () => JSON.parse(readFileSync(join(project, ".pi/harness/state.json"), "utf8"));
const userText = (s: AgentSession) =>
	s.messages
		.filter((m) => m.role === "user")
		.map((m) => (typeof m.content === "string" ? m.content : m.content.map((c) => ("text" in c ? c.text : "")).join("")))
		.join("\n");

// フロー外のダッシュボード: 待機中・ブランチ・話しかけ方
assert.match(widget[0], /待機中 │ ⎇ main │ 話しかけて開始/);

// フロー外の通常の会話では、harness ツールは状態確認と開始だけ
const idleTools = sessions[0].getActiveToolNames().filter((t) => t.startsWith("harness_")).sort();
assert.deepEqual(idleTools, ["harness_control", "harness_status"]);

// 1) 「作りたい」と話す → 確認ダイアログで「いいえ」→ 何も始まらない
confirmAnswers.push(false);
await talk("温度センサーの値を記録するツールを作りたい", [
	call("harness_control", { action: "start_requirements", request: "温度センサーの値を記録するツールを作りたい", topic: "温度ロガー" }),
	say("取り消しました。どうしますか？"),
]);
assert.equal(confirms.length, 1);
assert.match(confirms[0].title, /要件定義を開始しますか/);
assert.match(confirms[0].message, /テーマ: 温度ロガー[\s\S]*依頼: 温度センサーの値を記録するツールを作りたい/);
assert.match(results.at(-1) ?? "", /ユーザーが取り消しました/);
assert.equal(sessions.length, 1, "取り消したので新しいセッションは作られない");
assert.ok(!existsSync(join(project, ".pi/harness/state.json")) || state().phase === "idle");

// 2) もう一度話す → 「はい」→ 新しいセッションでヒアリングが始まる
confirmAnswers.push(true);
await talk("やっぱり作りたい。始めて", [
	call("harness_control", { action: "start_requirements", request: "温度ロガーを作りたい", topic: "温度ロガー" }),
	// ↑ でプロセス開始 → 自動で新しいセッション（ヒアリング）
	say("ヒアリングを始めます。"),
]);
assert.equal(sessions.length, 2, "承認後、新しいセッションが作られる");
assert.equal(state().phase, "req_clarify");
assert.match(userText(sessions[1]), /<skill name="harness-hearing"/);
assert.match(userText(sessions[1]), /テーマ: 温度ロガー/);

// 3) ヒアリング中に「Issue を実装したい」と話す → 進行中のフローが中断される旨を表示して確認 → 実装フロー
confirmAnswers.push(true);
await talk("それより先にログイン API の Issue を実装したい", [
	call("harness_control", { action: "start_implement", request: "ログイン API の Issue を実装したい", issue: "docs/issues/01-login.md" }),
	say("プラン作成を始めます。"),
]);
const implConfirm = confirms.at(-1)!;
assert.match(implConfirm.title, /Issue の実装を開始しますか/);
assert.match(implConfirm.message, /Issue: ログイン API/);
assert.match(implConfirm.message, /⚠ 進行中のフロー（requirements \/ 要件ヒアリング）は中断されます/);
assert.equal(sessions.length, 3);
assert.equal(state().phase, "impl_context");
assert.match(userText(sessions[2]), /<skill name="harness-plan"/);
// ダッシュボード: フロー・Issue・作業ブランチ・工程の現在位置・トークン
assert.match(widget[0], /🧭 TDD 実装 │ ログイン API │ ⎇ issue-01-login-api/);
assert.equal(widget[1], "▶ 読込 › ○ プラン › ○ 承認 › ○ TDD 実装 › ○ レビュー › ○ 完了");
assert.match(widget.at(-1) ?? "", /このセッション 入 [\d.]+k? \/ 出/);
assert.match(widget.at(-1) ?? "", /faux\/m/);
assert.ok(working.includes("🧭 あなたの確認待ち"), "ツール実行中の作業が表示される");
assert.match(widget.at(-1) ?? "", /作業合計 [\d.]+k? \$[\d.]+（1 セッション）/, "前のフロー・通常の会話のセッションは新しい作業の合計に含めない");
if (process.env.SHOW_WIDGET) console.log(`\n${widget.join("\n")}\n`);

// 4) 状態を自然言語で聞く（確認なし・読み取りのみ）
await talk("今どうなってる？", [call("harness_status", {}), say("プラン作成中です。")]);
assert.match(results.at(-1) ?? "", /^3:harness_status: \[piHarness ワークフロー制御中\]/);

// 5) レビューで見つかった仕様の曖昧さに、自然言語で答える（回答ダイアログ → 決まった解釈でもう一度レビュー）
const writeState = (patch: Record<string, unknown>) =>
	writeFileSync(join(project, ".pi/harness/state.json"), `${JSON.stringify({ ...state(), ...patch }, null, 2)}\n`);
const item = state().itemDir as string;
writeState({
	phase: "impl_spec_gap",
	review: { ...state().review, round: 1, lastBlocking: 0 },
	specGaps: [{ id: "Q1", criterion: "AC-1", question: "パスワードが空のときは？", interpretations: ["400 を返す", "401 を返す"], round: 1 }],
});
await talk("/harness status", []); // state.json を読み直す
selectAnswers.push("401");
await talk("401 でお願いします", [
	call("harness_control", { action: "answer_spec_gap", request: "401 を返す" }),
	// ↑ で回答 → 新しいセッションでフルレビュー
	say("レビューを始めます。"),
]);
assert.match(selects.at(-1)!.title, /仕様の確認 Q1（AC-1）\nパスワードが空のときは？/);
assert.deepEqual(selects.at(-1)!.options, ["400 を返す", "401 を返す", "（自由入力で回答する）"]);
assert.equal(sessions.length, 4, "回答後、新しいセッションでレビューし直す");
assert.equal(state().phase, "impl_review");
assert.match(userText(sessions[3]), /<skill name="harness-review"/);
assert.match(userText(sessions[3]), /decisions\.md — 仕様の確認へのユーザーの回答/);
assert.match(readFileSync(join(project, item, "decisions.md"), "utf8"), /\*\*決定:\*\* 401 を返す/);
assert.equal(confirms.length, 3, "回答ダイアログそのものが確認なので、別の確認は出さない");

// 6) 指摘修正中にロックされたテストを変えたい → 変更申請 → ユーザーが承認したら編集できる
mkdirSync(join(project, "test"), { recursive: true });
writeFileSync(join(project, "test/login.test.js"), "expect(status).toBe(400);\n");
const hash = createHash("sha256").update(readFileSync(join(project, "test/login.test.js"))).digest("hex");
writeState({ phase: "impl_fix_review", testLock: { mode: "review", at: "", files: { "test/login.test.js": hash }, allowed: [] } });
await talk("/harness next", [say("修正を始めます。")]);
assert.equal(sessions.length, 5);
selectAnswers.push("承認する");
await talk("続けて", [
	call("write", { path: "test/login.test.js", content: "expect(status).toBe(401);\n" }), // ロック中 → ブロック
	call("harness_request_test_change", { files: ["test/login.test.js"], reason: "Q1 の回答で 401 に決まったため", criterion: "AC-1" }),
	call("write", { path: "test/login.test.js", content: "expect(status).toBe(401);\n" }),
	say("テストを直しました。"),
]);
assert.match(results.at(-3) ?? "", /^5:write \[ERROR\]: .*test\/login\.test\.js はロックされています/);
assert.match(selects.at(-1)!.title, /【テストの変更申請】\nファイル: test\/login\.test\.js\n根拠: AC-1/);
assert.match(results.at(-2) ?? "", /^5:harness_request_test_change: ユーザーが承認しました/);
assert.match(results.at(-1) ?? "", /^5:write: Successfully/);
assert.match(readFileSync(join(project, item, "test-changes.md"), "utf8"), /ユーザーが承認[\s\S]*test\/login\.test\.js[\s\S]*\[AC-1\] Q1 の回答で 401/);

// 7) 「やめたい」→ 確認 → 中止
confirmAnswers.push(true);
// 中止は作業を止めるためターンを終える（続けて作業しない）
await talk("やっぱりやめたい", [call("harness_control", { action: "abort", request: "作業をやめたい" })]);
assert.match(results.at(-1) ?? "", /フローを中止しました/);
assert.match(confirms.at(-1)!.title, /フローを中止しますか/);
assert.equal(state().phase, "idle");
assert.equal(confirms.length, 4, "開始・操作のたびに必ず確認している");

await runtime.dispose();
console.log(`E2E natural: OK (${sessions.length} sessions, ${confirms.length} confirmations)`);
