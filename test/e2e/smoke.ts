/**
 * E2E スモークテスト: 実際の Pi セッションランタイムに piHarness を読み込み、偽モデル（faux provider）で 3 つのフローを通す。
 * プロセスごとに新しいセッションが作られ、前のセッションの会話が引き継がれない（成果物ファイルのみで連携する）ことを検証する。
 *
 *   npm run test:e2e
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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

// Git リポジトリとして初期化（作業ブランチ・差分基準・完了時コミットの検証用）
const git = (...args: string[]) => execFileSync("git", args, { cwd: project, encoding: "utf8" }).trim();
git("init", "-q", "-b", "main");
git("config", "user.name", "e2e");
git("config", "user.email", "e2e@example.com");
writeFileSync(join(project, ".gitignore"), ".pi/harness/state.json\n.pi/harness/**/logs/\n");

const faux = fauxProvider({ models: [{ id: "worker" }, { id: "reviewer", reasoning: true }, { id: "cheap" }] });
// プロセスごとのモデル設定: レビューだけ別モデル + 高い思考レベル、それ以外は default
mkdirSync(join(project, ".pi"), { recursive: true });
writeFileSync(
	join(project, ".pi/harness.json"),
	JSON.stringify({
		// lint 相当のチェック: LINT_FAIL ファイルがあると失敗する
		checkCommands: ["node -e \"process.exit(require('fs').existsSync('LINT_FAIL')?1:0)\""],
		models: {
			default: "faux/worker",
			hearing: "faux/cheap",
			requirements: { model: "faux/reviewer", thinking: "high" },
			review: { model: "faux/reviewer", thinking: "high" },
		},
	}),
);
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
			extensionFactories: [(pi) => pi.registerProvider(faux.provider)],
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
	call("write", { path: join(root, "skills/harness-tdd/SKILL.md"), content: "x" }), // piHarness 本体 → ブロック
	call("harness_request_approval", { kind: "plan", summary: "PLAN-SESSION-MARKER", documents: [p("plan.md")] }),
]);
assert.match(r[3], /^2:write \[ERROR\]: .*piHarness 本体/);
assert.match(readFileSync(join(root, "skills/harness-tdd/SKILL.md"), "utf8"), /^---\nname: harness-tdd/);
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
	call("bash", { command: "touch LINT_FAIL" }),
	call("harness_run_tests", { expect: "green" }), // テストは通るがチェック（lint 相当）が失敗 → 失敗 1 回
	call("bash", { command: "rm LINT_FAIL" }),
	call("harness_run_tests", { expect: "green" }),
	call("harness_phase", { to: "impl_review" }), // implementation.md が無い → 拒否
	call("write", { path: p("implementation.md"), content: "# 実装レポート" }),
	call("bash", { command: "echo '// bash で変更' >> src/feature.js" }),
	call("harness_phase", { to: "impl_review" }), // 合格後に bash で変更 → 拒否
	call("harness_run_tests", { expect: "green" }),
	call("harness_phase", { to: "impl_review" }),
	// ↑ でプロセス完了 → 自動で /harness next → [S4] レビュー
	call("harness_record_review", {
		summary: "要修正",
		findings: [{ severity: "major", perspective: "tests", title: "境界値テスト不足", detail: "..." }],
	}),
	// → [S5] 指摘修正
	call("write", { path: "src/feature.js", content: "module.exports = 2" }),
	call("write", { path: "test/feature.test.js", content: "it.skip('境界値', () => {});\n" }),
	call("harness_run_tests", { expect: "green" }),
	call("harness_phase", { to: "impl_review" }), // fix-1.md が無い → 拒否
	call("write", { path: p("fix-1.md"), content: "# 対応" }),
	call("harness_phase", { to: "impl_review" }), // it.skip の追加を検知 → 拒否
	call("harness_phase", { to: "impl_review", testChangeReason: "境界値テストは #9 のセンサー実装待ちのため一時的にスキップ" }),
	// → [S6] 軽量レビュー → 完了（コミット）
	call("harness_record_review", { summary: "LGTM", findings: [] }),
	done("完了"),
]);
for (const x of r) console.log("  ", x);
assert.equal(sessionNo, 6, "実装 → レビュー → 修正 → レビュー がそれぞれ新しいセッション");
const errorsOf = (session: number) => r.filter((x) => x.startsWith(`${session}:`) && x.includes("[ERROR]"));
assert.equal(errorsOf(3).length, 2);
assert.match(errorsOf(3)[0], /implementation\.md/);
assert.match(errorsOf(3)[1], /再度テスト/, "bash による変更も未テスト扱いになる");
assert.equal(errorsOf(5).length, 2);
assert.match(errorsOf(5)[0], /fix-1\.md/);
assert.match(errorsOf(5)[1], /テストを弱める可能性のある変更を検知/);
const s3Runs = toolTexts.filter((_, i) => toolResults[i].startsWith("3:harness_run_tests"));
assert.match(s3Runs[1], /LINT_FAIL[\s\S]*→ FAIL[\s\S]*結果: FAIL[\s\S]*修正ループ 1\/3/, "チェックコマンドの失敗で green 判定が失敗する");
assert.match(s3Runs[2], /結果: PASS/);
assert.ok(r.some((x) => /^4:harness_record_review: レビュー 1 周目/.test(x)));
assert.ok(r.some((x) => /^6:harness_record_review: レビュー 2 周目（軽量）/.test(x)));
assert.match(readFileSync(join(project, p("test-changes.md")), "utf8"), /\[skip_added\] test\/feature\.test\.js[\s\S]*#9 のセンサー実装待ち/);
assert.match(firstUserText(sessionsSeen[5]), /test-changes\.md — テストの削除・スキップ/, "テスト変更の理由がレビューに引き継がれる");
assert.match(firstUserText(sessionsSeen[3]), /変更の差分: `git diff [0-9a-f]{12}`/);
// Git: 作業ブランチ issue-1 上に完了コミット（Closes #1）。PR は確認が必要（UI なし）なので作成しない
assert.equal(git("rev-parse", "--abbrev-ref", "HEAD"), "issue-1");
assert.match(git("log", "-1", "--format=%B"), /\(#1\)[\s\S]*Closes #1/);
assert.match(git("show", "--stat", "--format=", "HEAD"), /src\/feature\.js/);
assert.doesNotMatch(git("show", "--stat", "--format=", "HEAD"), /\.pi\/harness\//, "成果物は既定でコミットしない");
assert.equal(git("status", "--porcelain", "--", "src", "test"), "");
const issue1 = JSON.parse(readFileSync(join(project, ".pi/harness/state.json"), "utf8"));
assert.equal(issue1.phase, "impl_done");
assert.match(issue1.git.commit, /^[0-9a-f]{40}$/);
assert.equal(issue1.git.baseBranch, "main");
// 利用量: プロセスごとのセッションが記録される
const usage1 = JSON.parse(readFileSync(join(project, p("usage.json")), "utf8"));
assert.deepEqual([...new Set(usage1.sessions.map((x: { process: string }) => x.process))].sort(), ["fix", "implement", "plan", "review"]);

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

r = await run("/impl 2", [ // 作業ブランチ issue-1 上から開始 → UI なしでは既定ブランチ main から issue-2 を作成
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
	call("bash", { command: "rm BROKEN && mkdir -p src && echo 'module.exports = 1' > src/feature.js" }), // issue-2 は main から作成されている
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
// issue-2 は既定ブランチ main から作成され（issue-1 の変更を含まない）、合流後のレビュー通過でコミットされる
assert.equal(git("rev-parse", "--abbrev-ref", "HEAD"), "issue-2");
assert.match(git("log", "-1", "--format=%s"), /\(#2\)$/);
assert.equal(git("merge-base", "issue-2", "main"), git("rev-parse", "main"));
assert.equal(git("rev-list", "--count", "main..issue-2"), "1");
assert.equal(JSON.parse(readFileSync(join(project, ".pi/harness/state.json"), "utf8")).git.baseBranch, "main");

// ---------------------------------------------------------------------------
// 要件定義フロー: ヒアリング → 要件定義書作成 →（未確定論点で）ヒアリング → 要件定義書作成 → 承認 → Issue 登録
// それぞれ別セッション。ヒアリングは安価なモデル、要件定義書作成は高性能モデル
// ---------------------------------------------------------------------------

const issueBody = "## 背景・目的\nx\n## 受け入れ条件\n- [ ] y";
const reqItem = `.pi/harness/req-${new Date().toISOString().slice(0, 10)}-温度ロガー`;
r = await run("/req 温度ロガー", [
	call("write", { path: "src/x.js", content: "x" }), // 要件定義中 → ブロック
	call("harness_phase", { to: "req_document" }), // hearing.md が無い → 拒否
	call("write", { path: `${reqItem}/hearing.md`, content: "# 確定事項" }),
	call("harness_phase", { to: "req_document" }), // → 要件定義書作成セッション
	call("harness_phase", { to: "req_clarify" }), // open-questions.md が無い → 拒否
	call("write", { path: `${reqItem}/open-questions.md`, content: "- 保存期間は?" }),
	call("harness_phase", { to: "req_clarify" }), // → ヒアリングセッション（2 回目）
	call("write", { path: `${reqItem}/hearing.md`, content: "# 確定事項（保存期間: 30 日）" }),
	call("harness_phase", { to: "req_document" }), // → 要件定義書作成セッション（2 回目）
	call("write", { path: "docs/requirements/logger.md", content: "# 要件" }),
	call("harness_create_issues", { issues: [{ title: "a", body: issueBody }], dryRun: true }), // 承認前 → 拒否
	call("harness_request_approval", { kind: "requirements", summary: "s", documents: ["docs/requirements/logger.md"] }),
]);
assert.ok(existsSync(join(project, reqItem, "hearing.md")));
assert.ok(!existsSync(join(project, reqItem, "open-questions.md")), "回答済みの open-questions.md は退避される");
assert.ok(readdirSync(join(project, reqItem)).some((f) => f.startsWith("open-questions-resolved-")));
for (const x of r) console.log("  ", x);
const hearing1 = sessionNo - 3;
assert.deepEqual(
	r.filter((x) => x.includes("[ERROR]")).map((x) => x.replace(/: .*/, "")),
	[`${hearing1}:write [ERROR]`, `${hearing1}:harness_phase [ERROR]`, `${hearing1 + 1}:harness_phase [ERROR]`, `${hearing1 + 3}:harness_create_issues [ERROR]`],
);
assert.match(r.find((x) => x.startsWith(`${hearing1}:harness_phase [ERROR]`)) ?? "", /hearing\.md/);
assert.match(r.find((x) => x.startsWith(`${hearing1 + 1}:harness_phase [ERROR]`)) ?? "", /open-questions\.md/);
assert.match(firstUserText(sessionsSeen[hearing1 - 1]), /「1\. ヒアリング」から/);
assert.match(firstUserText(sessionsSeen[hearing1]), /「2\. ドキュメント作成」から/);
assert.match(firstUserText(sessionsSeen[hearing1]), /hearing\.md — ヒアリングで確定した仕様のまとめ/);
assert.match(firstUserText(sessionsSeen[hearing1 + 1]), /open-questions\.md — 要件定義書作成で見つかった未確定の論点/);
assert.doesNotMatch(firstUserText(sessionsSeen[hearing1 + 2]), /open-questions\.md — 要件定義書作成で見つかった/, "回答済みの未確定論点は退避され、次の要件定義書作成には渡らない");
const reqSession = sessionNo;
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

// プロセスごとのモデル:
//   レビュー・要件定義書作成 → reviewer + thinking high / ヒアリング → cheap / それ以外 → worker
const reviewSessions = new Set([4, 6, bugSession + 1]);
const hearingSessions = new Set([hearing1, hearing1 + 2]);
const documentSessions = new Set([hearing1 + 1, hearing1 + 3]);
sessionsSeen.forEach((session, i) => {
	const no = i + 1;
	if (no === 1) return; // pi 起動直後のセッション（ハーネス外）
	const strong = reviewSessions.has(no) || documentSessions.has(no);
	const expected = strong ? "reviewer" : hearingSessions.has(no) ? "cheap" : "worker";
	assert.equal(session.model?.id, expected, `セッション ${no} のモデル`);
	if (strong) assert.equal(session.thinkingLevel, "high", `セッション ${no} の思考レベル`);
});

const state = JSON.parse(readFileSync(join(project, ".pi/harness/state.json"), "utf8"));
assert.equal(state.kickoff, undefined);
assert.equal(state.phase, "req_done");
assert.equal(state.pendingHandoff, undefined);

// Issue の進み具合: 要件定義で登録した 2 件のうち、依存の無い 01 が次の候補。/impl next で Markdown の Issue から開始できる
const registry = JSON.parse(readFileSync(join(project, ".pi/harness/issues.json"), "utf8"));
const fromReq = registry.issues.filter((i: { file?: string }) => i.file);
assert.deepEqual(fromReq.map((i: { deps: string[] }) => i.deps.length), [0, 1]);
assert.equal(registry.issues.find((i: { id: string }) => i.id === "#1").status, "done");
r = await run("/impl next", [done("プラン作成を開始します")]);
const nextState = JSON.parse(readFileSync(join(project, ".pi/harness/state.json"), "utf8"));
assert.equal(nextState.issue.file, "docs/issues/01-センサー読み取り.md");
assert.equal(nextState.phase, "impl_context");
assert.equal(git("rev-parse", "--abbrev-ref", "HEAD"), "issue-01");
assert.match(firstUserText(runtime.session), /センサー読み取り/);

await runtime.dispose();
console.log(`E2E smoke: OK (${sessionNo} sessions)`);
