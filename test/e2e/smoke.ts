/**
 * E2E スモークテスト: 実際の Pi セッションランタイムに piHarness を読み込み、偽モデル（faux provider）で 3 つのフローを通す。
 * プロセスごとに新しいセッションが作られ、前のセッションの会話が引き継がれない（成果物ファイルのみで連携する）ことを検証する。
 *
 *   npm run test:e2e
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
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
const project = mkdtempSync(join(tmpdir(), "pih-e2e-"));
const agentDir = mkdtempSync(join(tmpdir(), "pih-agent-"));
writeFileSync(
	join(project, "package.json"),
	JSON.stringify({
		name: "demo",
		scripts: { test: "node -e \"const f=require('fs');process.exit(f.existsSync('src/feature.js')&&!f.existsSync('BROKEN')?0:1)\"" },
	}),
);

const faux = fauxProvider();
const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const done = (text: string) => fauxAssistantMessage(text);

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

// 実行ログ: "<セッション番号>:<ツール名>[ ERROR]: <結果の 1 行目>"
const toolResults: string[] = [];
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
	return JSON.stringify(session.messages.find((m) => m.role === "user"));
}

const item = ".pi/harness/issue-1";
const p = (f: string) => `${item}/${f}`;

const skills = runtime.services.resourceLoader.getSkills().skills.map((s) => s.name).sort();
assert.deepEqual(skills, ["harness-bugfix", "harness-requirements", "harness-review", "harness-tdd"]);

// ---------------------------------------------------------------------------
// 実装フロー: 各プロセスが新しいセッションで実行される
// ---------------------------------------------------------------------------

// /impl → [S2] プラン作成（承認待ちで停止）
let r = await run("/impl 1", [
	call("harness_phase", { to: "impl_plan" }),
	call("write", { path: "src/feature.js", content: "x" }), // 承認前 → ブロック
	call("write", { path: p("plan.md"), content: "# プラン" }),
	call("harness_request_approval", { kind: "plan", summary: "PLAN-SESSION-MARKER", documents: [p("plan.md")] }),
]);
assert.equal(sessionNo, 2, "/impl でプラン作成用の新しいセッションが作られる");
assert.match(firstUserText(runtime.session), /TDD 実装フロー（piHarness）/, "スキルが展開される");
assert.match(firstUserText(runtime.session), /会話は引き継がれていません/);
assert.match(firstUserText(runtime.session), /issue-1\/issue\.md — 対象 Issue の本文/);
assert.match(r[1], /^2:write \[ERROR\]: .*承認されるまで/);
const planSession = runtime.session;

// 人間が承認 → [S3] TDD 実装 → implementation.md 必須 → レビューへ
r = await run("/harness approve 境界値も見ておいて", [
	call("harness_run_tests", { expect: "red" }),
	call("write", { path: "src/feature.js", content: "module.exports = 1" }),
	call("harness_run_tests", { expect: "green" }),
	call("harness_phase", { to: "impl_review" }), // implementation.md が無い → 拒否
	call("write", { path: p("implementation.md"), content: "# 実装レポート" }),
	call("harness_phase", { to: "impl_review" }),
	// ↑ でプロセス完了 → 自動で /harness next → [S4] レビュー
	call("harness_record_review", {
		summary: "要修正",
		findings: [{ severity: "major", perspective: "tests", title: "境界値テスト不足", detail: "..." }],
	}),
	// → [S5] 指摘修正
	call("write", { path: "src/feature.js", content: "module.exports = 2" }),
	call("harness_run_tests", { expect: "green" }),
	call("harness_phase", { to: "impl_review" }), // fix-1.md が無い → 拒否
	call("write", { path: p("fix-1.md"), content: "# 対応" }),
	call("harness_phase", { to: "impl_review" }),
	// → [S6] 軽量レビュー
	call("harness_record_review", { summary: "LGTM", findings: [] }),
	done("完了"),
]);
for (const x of r) console.log("  ", x);
assert.equal(sessionNo, 6, "実装 → レビュー → 修正 → レビュー がそれぞれ新しいセッション");
assert.deepEqual(
	r.filter((x) => x.includes("[ERROR]")).map((x) => x.split(":")[0]),
	["3", "5"],
);
assert.match(r.find((x) => x.startsWith("3:harness_phase [ERROR]")) ?? "", /implementation\.md/);
assert.match(r.find((x) => x.startsWith("5:harness_phase [ERROR]")) ?? "", /fix-1\.md/);
assert.ok(r.some((x) => /^4:harness_record_review: レビュー 1 周目/.test(x)));
assert.ok(r.some((x) => /^6:harness_record_review: レビュー 2 周目（軽量）/.test(x)));

const s3 = firstUserText(sessionsSeen[2]);
assert.match(s3, /承認時のユーザーコメント: 境界値も見ておいて/);
assert.doesNotMatch(s3, /# プラン/, "前セッションの会話・内容は開始メッセージに含まれない（ファイルパスのみ）");
assert.equal(sessionsSeen[2].messages.filter((m) => m.role === "user").length, 1);
assert.match(firstUserText(sessionsSeen[3]), /harness-review|コードレビュー（piHarness）/);
assert.match(firstUserText(sessionsSeen[5]), /review-1\.md — レビュー 1 周目の記録/);
assert.match(firstUserText(sessionsSeen[5]), /fix-1\.md — レビュー 1 周目の指摘への対応記録/);
assert.ok(JSON.stringify(planSession.messages).includes("PLAN-SESSION-MARKER"));
for (const later of sessionsSeen.slice(2)) {
	assert.ok(!JSON.stringify(later.messages).includes("PLAN-SESSION-MARKER"), "後続セッションにプラン作成セッションの会話が含まれない");
}
assert.ok(existsSync(join(project, p("review-1.md"))));
assert.ok(existsSync(join(project, p("review-2.md"))));
const handoff = readFileSync(join(project, p("handoff.md")), "utf8");
assert.equal(handoff.match(/^## /gm)?.length, 5, "handoff.md に 5 回分の引き継ぎ記録");

// ---------------------------------------------------------------------------
// エスカレーション → バグ修正（新セッション）→ 実装フローへ合流（新しいレビューセッション）
// ---------------------------------------------------------------------------

r = await run("/impl 2", [
	call("harness_phase", { to: "impl_plan" }),
	call("write", { path: ".pi/harness/issue-2/plan.md", content: "# プラン" }),
	call("harness_request_approval", { kind: "plan", summary: "s", documents: [".pi/harness/issue-2/plan.md"] }),
]);
const beforeEsc = sessionNo;
r = await run("/harness approve", [
	call("write", { path: "BROKEN", content: "x" }),
	call("harness_run_tests", { expect: "green" }),
	call("harness_run_tests", { expect: "green" }),
	call("harness_run_tests", { expect: "green" }), // 3 回目 → エスカレーション（UI なし → 停止）
]);
assert.equal(sessionNo, beforeEsc + 1);
assert.ok(existsSync(join(project, ".pi/harness/issue-2/escalation-1.md")));

r = await run("/bugfix BROKEN ファイルが残る", [
	call("harness_run_tests", { expect: "red" }),
	call("harness_phase", { to: "bug_analyze" }),
	call("write", { path: "src/feature.js", content: "y" }), // 分析中 → ブロック
	call("harness_phase", { to: "bug_fix" }),
	call("bash", { command: "rm BROKEN" }),
	call("harness_run_tests", { expect: "green" }),
	call("harness_phase", { to: "bug_done" }), // bug-1.md が無い → 拒否
	call("write", { path: ".pi/harness/issue-2/bug-1.md", content: "# 原因" }),
	call("harness_phase", { to: "bug_done" }), // → 合流 → 新しいレビューセッション
	call("harness_record_review", { summary: "LGTM", findings: [] }),
	done("合流して完了"),
]);
for (const x of r) console.log("  ", x);
const bugSession = beforeEsc + 2;
assert.equal(sessionNo, bugSession + 1);
assert.match(firstUserText(sessionsSeen[bugSession - 1]), /バグ修正フロー（piHarness）/);
assert.match(firstUserText(sessionsSeen[bugSession - 1]), /escalation-1\.md — エスカレーション記録 #1/);
assert.deepEqual(
	r.filter((x) => x.includes("[ERROR]")).map((x) => x.replace(/: .*/, "")),
	[`${bugSession}:write [ERROR]`, `${bugSession}:harness_phase [ERROR]`],
);
assert.ok(r.some((x) => x.startsWith(`${bugSession + 1}:harness_record_review: レビュー 1 周目（フル）`)));
assert.match(firstUserText(sessionsSeen[bugSession]), /bug-1\.md — バグレポート #1/);

// ---------------------------------------------------------------------------
// 要件定義フロー: 要件定義セッション → 承認 → Issue 登録セッション
// ---------------------------------------------------------------------------

const issueBody = "## 背景・目的\nx\n## 受け入れ条件\n- [ ] y";
r = await run("/req 温度ロガー", [
	call("harness_phase", { to: "req_document" }),
	call("write", { path: "src/x.js", content: "x" }), // 要件定義中 → ブロック
	call("write", { path: "docs/requirements/logger.md", content: "# 要件" }),
	call("harness_create_issues", { issues: [{ title: "a", body: issueBody }], dryRun: true }), // 承認前 → 拒否
	call("harness_request_approval", { kind: "requirements", summary: "s", documents: ["docs/requirements/logger.md"] }),
]);
const reqSession = sessionNo;
assert.match(firstUserText(runtime.session), /要件定義フロー（piHarness）/);
assert.deepEqual(
	r.filter((x) => x.includes("[ERROR]")).map((x) => x.replace(/: .*/, "")),
	[`${reqSession}:write [ERROR]`, `${reqSession}:harness_create_issues [ERROR]`],
);
r = await run("/harness approve", [
	call("harness_create_issues", {
		issues: [
			{ title: "センサー読み取り", body: issueBody, labels: ["feature"] },
			{ title: "SQLite 保存", body: issueBody, dependsOn: [0] },
		],
		dryRun: true,
	}),
	done("登録しました"),
]);
for (const x of r) console.log("  ", x);
assert.equal(sessionNo, reqSession + 1, "Issue 登録は新しいセッション");
assert.match(firstUserText(runtime.session), /docs\/requirements\/logger\.md — 承認済みの要件ドキュメント/);
assert.match(r.at(-1) ?? "", /2 件の Issue をMarkdown として docs\/issues\/ に保存/);
assert.deepEqual(readdirSync(join(project, "docs/issues")).sort(), ["01-センサー読み取り.md", "02-sqlite-保存.md"]);
assert.match(readFileSync(join(project, "docs/issues/02-sqlite-保存.md"), "utf8"), /## 依存関係[\s\S]*- センサー読み取り/);

const state = JSON.parse(readFileSync(join(project, ".pi/harness/state.json"), "utf8"));
assert.equal(state.phase, "req_done");
assert.equal(state.pendingHandoff, undefined);

await runtime.dispose();
console.log(`E2E smoke: OK (${sessionNo} sessions)`);
