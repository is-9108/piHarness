/**
 * E2E スモークテスト: 実際の Pi セッションに piHarness を読み込み、偽モデル（faux provider）で
 * 実装フロー（プラン → 承認 → Red → Green → レビュー指摘 → 修正 → 軽量レビュー → 完了）を通す。
 *
 *   npm run test:e2e
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const root = resolve(import.meta.dirname, "../..");
const project = mkdtempSync(join(tmpdir(), "pih-e2e-"));
const agentDir = mkdtempSync(join(tmpdir(), "pih-agent-"));
writeFileSync(
	join(project, "package.json"),
	JSON.stringify({ name: "demo", scripts: { test: "node -e \"const f=require('fs');process.exit(f.existsSync('src/feature.js')&&!f.existsSync('BROKEN')?0:1)\"" } }),
);

const faux = fauxProvider();
const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const done = (text: string) => fauxAssistantMessage(text);

const resourceLoader = new DefaultResourceLoader({
	cwd: project,
	agentDir,
	additionalExtensionPaths: [join(root, "extensions/harness/index.ts")],
	additionalSkillPaths: [join(root, "skills")],
	extensionFactories: [(pi) => pi.registerProvider(faux.provider)],
});
await resourceLoader.reload();

const { session } = await createAgentSession({
	cwd: project,
	agentDir,
	model: faux.getModel(),
	resourceLoader,
	sessionManager: SessionManager.inMemory(),
	settingsManager: SettingsManager.inMemory(),
});

const toolResults: string[] = [];
async function settle(): Promise<void> {
	for (let i = 0; i < 50 && faux.getPendingResponseCount() > 0; i++) {
		await new Promise((r) => setTimeout(r, 100));
		await session.waitForIdle();
	}
	await session.waitForIdle();
}
session.subscribe((e) => {
	if (e.type === "tool_execution_end") {
		const text = (e.result?.content ?? []).map((c: { text?: string }) => c.text ?? "").join("");
		toolResults.push(`${e.toolName}${e.isError ? " [ERROR]" : ""}: ${text.split("\n")[0]}`);
	}
});

const skills = resourceLoader.getSkills().skills.map((s) => s.name).sort();
assert.deepEqual(skills, ["harness-bugfix", "harness-requirements", "harness-review", "harness-tdd"]);

// 1) /impl 開始 → コード読込 → プラン作成 → 承認依頼（UI なし → 保留で停止）
faux.setResponses([
	call("harness_phase", { to: "impl_plan", note: "コード読込完了" }),
	call("write", { path: "src/feature.js", content: "x" }), // 承認前 → ブロックされるはず
	call("write", { path: ".pi/harness/plans/issue-1.md", content: "# プラン" }),
	call("harness_request_approval", { kind: "plan", summary: "テスト1件", documents: [".pi/harness/plans/issue-1.md"] }),
	done("承認待ちです"),
]);
await session.prompt("/impl 1");
await settle();
const firstUser = JSON.stringify(session.messages.find((m) => m.role === "user"));
assert.match(firstUser, /TDD 実装フロー（piHarness）/, "/impl で harness-tdd スキルが展開されること");

// 2) 人間が /harness approve → TDD
faux.setResponses([
	call("harness_run_tests", { expect: "red" }),
	call("write", { path: "src/feature.js", content: "module.exports = 1" }),
	call("harness_run_tests", { expect: "green" }),
	call("harness_phase", { to: "impl_review" }),
	call("harness_record_review", {
		summary: "要修正",
		findings: [{ severity: "major", perspective: "tests", title: "境界値テスト不足", detail: "..." }],
	}),
	call("write", { path: "src/feature.js", content: "module.exports = 2" }),
	call("harness_phase", { to: "impl_review" }), // 合格後に未テストの変更あり → 拒否されるはず
	call("harness_run_tests", { expect: "green" }),
	call("harness_phase", { to: "impl_review" }),
	call("harness_record_review", { summary: "LGTM", findings: [] }),
	done("完了"),
]);
await session.prompt("/harness approve");
await settle();

for (const r of toolResults) console.log("  ", r);

const errors = toolResults.filter((r) => r.includes("[ERROR]"));
assert.equal(errors.length, 2, "承認前の write と未テスト変更でのレビュー遷移の 2 件だけが失敗するはず");
assert.match(errors[0], /^write \[ERROR\]: .*プランが承認されるまで/);
assert.match(errors[1], /^harness_phase \[ERROR\]: .*再度テスト/);
assert.ok(toolResults.some((r) => r.startsWith("harness_record_review: レビュー 2 周目")));
assert.ok(existsSync(join(project, ".pi/harness/reviews/issue-1-round-1.md")));
assert.ok(readdirSync(join(project, ".pi/harness/logs")).length >= 3);

// 3) 別 Issue: テストが 3 回連続で失敗 → エスカレーション（UI なし → 停止）
toolResults.length = 0;
faux.setResponses([
	call("harness_phase", { to: "impl_plan" }),
	call("write", { path: ".pi/harness/plans/issue-2.md", content: "# プラン" }),
	call("harness_request_approval", { kind: "plan", summary: "s", documents: [".pi/harness/plans/issue-2.md"] }),
	done("承認待ち"),
]);
await session.prompt("/impl 2");
await settle();
faux.setResponses([
	call("write", { path: "BROKEN", content: "x" }),
	call("harness_run_tests", { expect: "green" }),
	call("harness_run_tests", { expect: "green" }),
	call("harness_run_tests", { expect: "green" }),
	done("エスカレーションしました"),
]);
await session.prompt("/harness approve");
await settle();
assert.match(toolResults.at(-1) ?? "", /^harness_run_tests: /);

// 4) ユーザーが /bugfix を選択 → 再現 → 分析（コード変更不可）→ 修正 → 検証 → 実装フローへ合流 → フルレビュー
faux.setResponses([
	call("harness_run_tests", { expect: "red" }),
	call("harness_phase", { to: "bug_analyze" }),
	call("write", { path: "src/feature.js", content: "y" }), // 分析中 → ブロック
	call("write", { path: ".pi/harness/bugs/broken.md", content: "# 原因" }),
	call("harness_phase", { to: "bug_fix" }),
	call("bash", { command: "rm BROKEN" }),
	call("harness_run_tests", { expect: "green" }),
	call("harness_phase", { to: "bug_done" }),
	call("harness_status", {}),
	call("harness_record_review", { summary: "LGTM", findings: [] }),
	done("合流して完了"),
]);
await session.prompt("/bugfix BROKEN ファイルが残る");
await settle();
for (const r of toolResults) console.log("  ", r);
const bugErrors = toolResults.filter((r) => r.includes("[ERROR]"));
assert.equal(bugErrors.length, 1);
assert.match(bugErrors[0], /^write \[ERROR\]: .*原因分析中/);
assert.ok(toolResults.some((r) => r.startsWith("harness_phase: バグ修正完了 → 実装フロー（#2")));
assert.ok(toolResults.some((r) => r.startsWith("harness_record_review: レビュー 1 周目（フル）")));

// 5) 要件定義フロー: ヒアリング → 承認前の Issue 登録は拒否 → 承認 → Issue 登録（dryRun: Markdown 保存）
toolResults.length = 0;
const issueBody = "## 背景・目的\nx\n## 受け入れ条件\n- [ ] y";
faux.setResponses([
	call("harness_phase", { to: "req_document" }),
	call("write", { path: "src/x.js", content: "x" }), // 要件定義中 → ブロック
	call("write", { path: "docs/requirements/logger.md", content: "# 要件" }),
	call("harness_create_issues", { issues: [{ title: "a", body: issueBody }], dryRun: true }), // 承認前 → 拒否
	call("harness_request_approval", { kind: "requirements", summary: "s", documents: ["docs/requirements/logger.md"] }),
	done("承認待ち"),
]);
await session.prompt("/req 温度ロガー");
await settle();
assert.match(JSON.stringify(session.messages.filter((m) => m.role === "user").at(-1)), /要件定義フロー（piHarness）/);
faux.setResponses([
	call("harness_create_issues", {
		issues: [
			{ title: "センサー読み取り", body: issueBody, labels: ["feature"] },
			{ title: "SQLite 保存", body: issueBody, dependsOn: [0] },
		],
		dryRun: true,
	}),
	done("登録しました"),
]);
await session.prompt("/harness approve");
await settle();
for (const r of toolResults) console.log("  ", r);
const reqErrors = toolResults.filter((r) => r.includes("[ERROR]"));
assert.equal(reqErrors.length, 2);
assert.match(reqErrors[0], /^write \[ERROR\]: .*要件定義フロー中/);
assert.match(reqErrors[1], /^harness_create_issues \[ERROR\]: .*承認された後/);
assert.match(toolResults.at(-1) ?? "", /^harness_create_issues: 2 件の Issue をMarkdown として docs\/issues\/ に保存/);
assert.deepEqual(readdirSync(join(project, "docs/issues")).sort(), ["01-センサー読み取り.md", "02-sqlite-保存.md"]);
assert.match(readFileSync(join(project, "docs/issues/02-sqlite-保存.md"), "utf8"), /## 依存関係[\s\S]*- センサー読み取り/);

session.dispose();
console.log("E2E smoke: OK");
