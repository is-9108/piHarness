/**
 * E2E: ドキュメント作成フロー。実際の Pi セッションランタイムに piHarness を読み込み、偽モデルで
 * 構成案 → 承認 → 執筆 → レビュー → 指摘修正 → 軽量レビュー → コミット までを通す。
 * テストのツールは使わず、ドキュメント以外の変更はブロックされ、レビュー前に git の差分でも確かめられることを検証する。
 *
 *   npm run test:e2e
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
	type AgentSession,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

const root = resolve(import.meta.dirname, "../..");
const project = mkdtempSync(join(tmpdir(), "pih-e2e-docs-"));
const agentDir = mkdtempSync(join(tmpdir(), "pih-agent-"));
writeFileSync(
	join(project, "package.json"),
	JSON.stringify({
		name: "demo",
		scripts: { test: "node -e \"const f=require('fs');process.exit(f.existsSync('src/feature.js')&&!f.existsSync('BROKEN')?0:1)\"" },
	}),
);

// Git リポジトリとして初期化（作業ブランチ・差分基準・完了時コミットの検証用）
const git = (...args: string[]) => execFileSync("git", args, { cwd: project, encoding: "utf8" }).trim();
git("init", "-q", "-b", "main");
git("config", "user.name", "e2e");
git("config", "user.email", "e2e@example.com");
writeFileSync(join(project, ".gitignore"), ".pi/harness/state.json\n.pi/harness/**/logs/\n");
mkdirSync(join(project, "src"));
writeFileSync(join(project, "src/app.js"), "// --port で待ち受けポートを指定する\n");
writeFileSync(join(project, "README.md"), "# demo\n");

const faux = fauxProvider({ models: [{ id: "worker" }, { id: "reviewer", reasoning: true }, { id: "cheap" }] });
// プロセスごとのモデル設定: レビューだけ別モデル + 高い思考レベル、それ以外は default
mkdirSync(join(project, ".pi"), { recursive: true });
writeFileSync(
	join(project, ".pi/harness.json"),
	JSON.stringify({
		models: {
			default: "faux/worker",
			doc_review: { model: "faux/reviewer", thinking: "high" },
		},
	}),
);
let toolInfos: () => { name: string; exposure?: string }[] = () => [];
const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const done = (text: string) => fauxAssistantMessage(text);

git("add", "-A");
git("commit", "-q", "-m", "init");

const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
	const services = await createAgentSessionServices({
		cwd,
		agentDir,
		settingsManager: SettingsManager.inMemory(),
		resourceLoaderOptions: {
			additionalExtensionPaths: [join(root, "extensions/harness/index.ts")],
			additionalSkillPaths: [join(root, "skills")],
			extensionFactories: [
				(pi) => {
					pi.registerProvider(faux.provider);
					// MCP サーバーのツールに見立てたもの（codemode のスクリプトからは有効なツールに関係なく呼べる）
					const tool = (name: string, readOnly: boolean) =>
						pi.registerTool({
							name,
							label: name,
							description: name,
							parameters: Type.Object({ path: Type.String() }),
							annotations: readOnly ? { readOnlyHint: true } : undefined,
							async execute(_id, params) {
								if (!readOnly) writeFileSync(join(project, params.path), "mcp\n");
								return { content: [{ type: "text", text: `${name} ok` }], details: undefined };
							},
						});
					tool("mcp__fs__write_file", false);
					tool("mcp__fs__read_file", true);
					toolInfos = () => pi.getAllTools();
				},
			],
		},
	});
	const created = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model: faux.getModel() });
	return { ...created, services, diagnostics: services.diagnostics };
};
const runtime = await createAgentSessionRuntime(createRuntime, { cwd: project, agentDir, sessionManager: SessionManager.inMemory() });

// 実行ログ: "<セッション番号>:<ツール名>[ ERROR]: <結果の 1 行目>"
const toolResults: string[] = [];
/** ツール結果の全文（toolResults と同じ順序） */
const toolTexts: string[] = [];
const sessionsSeen: AgentSession[] = [];
let sessionNo = 0;

async function bind(): Promise<void> {
	const session = runtime.session;
	await session.bindExtensions({
		commandContextActions: {
			waitForIdle: () => session.waitForIdle(),
			newSession: (options) => runtime.newSession(options),
			fork: async (entryId, options) => ({ cancelled: (await runtime.fork(entryId, options)).cancelled }),
			navigateTree: async () => ({ cancelled: true }),
			switchSession: (path, options) => runtime.switchSession(path, options),
			reload: () => session.reload(),
		},
	});
	sessionNo = sessionsSeen.push(session);
	const no = sessionNo;
	session.subscribe((e) => {
		if (e.type === "tool_execution_end") {
			const text = (e.result?.content ?? []).map((c: { text?: string }) => c.text ?? "").join("");
			toolResults.push(`${no}:${e.toolName}${e.isError ? " [ERROR]" : ""}: ${text.split("\n")[0]}`);
			toolTexts.push(text);
		}
	});
}
runtime.setRebindSession(bind);
await bind();

/** 偽モデルの応答を使い切り、セッション切り替えを含めて落ち着くまで待つ */
async function settle(): Promise<void> {
	for (let i = 0; i < 100; i++) {
		await new Promise((r) => setTimeout(r, 50));
		await runtime.session.waitForIdle();
		if (faux.getPendingResponseCount() === 0 && runtime.session.isIdle) {
			await new Promise((r) => setTimeout(r, 100));
			if (runtime.session.isIdle) return;
		}
	}
	throw new Error(`settle timeout (pending=${faux.getPendingResponseCount()})`);
}

async function run(prompt: string, responses: ReturnType<typeof done>[]): Promise<string[]> {
	const from = toolResults.length;
	faux.setResponses(responses);
	await runtime.session.prompt(prompt);
	await settle();
	assert.equal(faux.getPendingResponseCount(), 0, `未消費の応答があります: ${prompt}`);
	return toolResults.slice(from);
}

function firstUserText(session: AgentSession): string {
	const m = session.messages.find((x) => x.role === "user") as { content?: string | { type: string; text?: string }[] } | undefined;
	if (!m) return "";
	return typeof m.content === "string" ? m.content : (m.content ?? []).map((c) => c.text ?? "").join("\n");
}

const item = `.pi/harness/docs-${new Date().toISOString().slice(0, 10)}-導入手順`;
const p = (f: string) => `${item}/${f}`;
const toolsOf = (i: number) => sessionsSeen[i - 1].getActiveToolNames();
const errorsOf = (r: string[], session: number) => r.filter((x) => x.startsWith(`${session}:`) && x.includes("[ERROR]"));

const skills = runtime.services.resourceLoader.getSkills().skills.map((s) => s.name);
for (const s of ["harness-doc-plan", "harness-doc-write", "harness-doc-review", "harness-doc-fix"]) assert.ok(skills.includes(s), s);

// /doc → [S2] 構成案（承認待ちで停止）
let r = await run("/doc 導入手順", [
	call("write", { path: "docs/setup.md", content: "x" }), // 構成案の承認前 → ブロック
	call("harness_run_tests", { expect: "green" }), // ドキュメント作成フローにテストのツールは無い
	call("write", { path: p("outline.md"), content: "# 構成案\n\n## 作成・更新するファイル\n\n- docs/setup.md\n" }),
	call("harness_request_approval", { kind: "outline", summary: "導入手順を docs/setup.md に書く", documents: [p("outline.md")] }),
]);
for (const x of r) console.log("  ", x);
assert.equal(sessionNo, 2, "/doc で構成案作成用の新しいセッションが作られる");
assert.match(firstUserText(runtime.session), /<skill name="harness-doc-plan"/);
assert.doesNotMatch(firstUserText(runtime.session), /Red → Green/, "TDD の手順は含まれない");
assert.match(git("rev-parse", "--abbrev-ref", "HEAD"), /^docs-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}$/, "日本語だけのテーマは日時のブランチ名");
assert.match(errorsOf(r, 2)[0], /^2:write \[ERROR\]: .*構成案が承認されるまで/);
assert.match(errorsOf(r, 2)[1], /^2:harness_run_tests \[ERROR\]/);
assert.ok(!toolsOf(2).includes("harness_run_tests") && toolsOf(2).includes("harness_request_approval"));
assert.match(r.at(-1) ?? "", /ドキュメントの構成案の承認待ち/);
assert.ok(!existsSync(join(project, p("baseline.md"))), "テストが無いのでベースラインは取らない");

// 承認 → [S3] 執筆 → [S4] レビュー → [S5] 指摘修正 → [S6] 軽量レビュー → 完了（コミット）
r = await run("/harness approve 初心者向けに", [
	call("write", { path: "src/app.js", content: "x" }), // コードは変更できない → ブロック
	call("mcp__fs__write_file", { path: "src/mcp.js" }), // 書き換えうる MCP ツール → ブロック
	call("write", { path: "docs/setup.md", content: "# 導入手順\n\n`node src/app.js --port 3000`\n" }),
	call("edit", { path: "README.md", edits: [{ oldText: "# demo", newText: "# demo\n\n導入手順は [docs/setup.md](docs/setup.md)" }] }),
	call("harness_phase", { to: "doc_review" }), // doc-report.md が無い → 拒否
	call("write", { path: p("doc-report.md"), content: "# 執筆レポート\n\n## 概要\n\n導入手順を書いた。\n\n## 作成・更新したファイル\n\n- docs/setup.md\n- README.md\n\n## 確認した情報源\n\n- src/app.js:1\n" }),
	call("bash", { command: "echo '// bash で変更' >> src/app.js" }),
	call("harness_phase", { to: "doc_review" }), // bash でコードを変更 → git の差分で拒否
	call("bash", { command: "git checkout -- src/app.js" }),
	call("harness_phase", { to: "doc_review" }),
	// → [S4] レビュー（読み取り専用）
	call("harness_record_review", {
		summary: "ポートの既定値が書かれていない",
		findings: [{ severity: "major", perspective: "completeness", title: "既定のポートが無い", detail: "src/app.js を見ると既定値がある", file: "docs/setup.md", line: 3 }],
	}),
	// → [S5] 指摘修正
	call("write", { path: "docs/setup.md", content: "# 導入手順\n\n`node src/app.js --port 3000`（既定 8080）\n" }),
	call("harness_phase", { to: "doc_review" }), // fix-1.md が無い → 拒否
	call("write", { path: p("fix-1.md"), content: "# 対応\n\n- 既定のポートを追記" }),
	call("harness_phase", { to: "doc_review" }),
	// → [S6] 軽量レビュー → 完了
	call("harness_record_review", { summary: "解消済み", findings: [] }),
	done("完了"),
]);
for (const x of r) console.log("  ", x);
assert.equal(sessionNo, 6, "執筆 → レビュー → 修正 → レビュー がそれぞれ新しいセッション");
assert.match(firstUserText(sessionsSeen[2]), /<skill name="harness-doc-write"/);
assert.match(firstUserText(sessionsSeen[2]), /outline\.md — 承認済みの構成案/);
assert.match(firstUserText(sessionsSeen[2]), /承認時のユーザーコメント: 初心者向けに/);
const e3 = errorsOf(r, 3);
assert.equal(e3.length, 4);
assert.match(e3[0], /^3:write \[ERROR\]: .*以外は変更できません.*対象: src\/app\.js/);
assert.match(e3[1], /^3:mcp__fs__write_file \[ERROR\]/);
assert.match(e3[2], /doc-report\.md/);
assert.match(e3[3], /ドキュメント以外のファイルは変更できません: src\/app\.js/, "bash での変更も git の差分で止める");
assert.ok(!existsSync(join(project, "src/mcp.js")));
assert.ok(!toolsOf(3).includes("harness_run_tests") && !toolsOf(3).includes("harness_record_decision"));
// レビュー: 読み取り専用・ドキュメントの観点・レビュー用のモデル
assert.match(firstUserText(sessionsSeen[3]), /<skill name="harness-doc-review"/);
assert.ok(!toolsOf(4).includes("write") && toolsOf(4).includes("harness_record_review"));
assert.equal(sessionsSeen[3].model?.id, "reviewer");
assert.equal(sessionsSeen[2].model?.id, "worker");
const review1 = readFileSync(join(project, p("review-1.md")), "utf8");
assert.match(review1, /対象 \| ドキュメント: 導入手順/);
assert.match(review1, /\| 正確さ（accuracy） \| 指摘なし \|[\s\S]*\| 網羅性（completeness） \| 1 件 \|/, "ドキュメントの観点で集計する");
assert.match(firstUserText(sessionsSeen[4]), /<skill name="harness-doc-fix"/);
assert.match(errorsOf(r, 5)[0], /fix-1\.md/);
assert.match(firstUserText(sessionsSeen[5]), /delta-2\.diff — 前回レビュー以降の差分/, "2 周目は差分だけを見る");
// 完了: ドキュメントだけがコミットされる
const state = JSON.parse(readFileSync(join(project, ".pi/harness/state.json"), "utf8"));
assert.equal(state.phase, "doc_done");
assert.equal(state.test.runs, 0, "テストは一度も実行しない");
assert.match(git("log", "-1", "--format=%B"), /^ドキュメント: 導入手順[\s\S]*ドキュメント作成フローで作成/);
assert.deepEqual(git("show", "--name-only", "--format=", "HEAD").split("\n").sort(), ["README.md", "docs/setup.md"]);
assert.ok(r.some((x) => /^6:harness_record_review: .*ドキュメント作成フロー完了/.test(x)));

await runtime.dispose();
console.log(`E2E docs: OK (${sessionNo} sessions)`);
