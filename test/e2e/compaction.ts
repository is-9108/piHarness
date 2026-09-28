/**
 * E2E: しきい値による自動圧縮。コンテキストウィンドウの小さい偽モデルで、大きなツール出力により使用率がしきい値を超えると
 * 圧縮され、プロセスのスキルと成果物の一覧が送り直されて同じセッションで作業が再開されることを確認する。
 *
 *   node test/e2e/compaction.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

const root = resolve(import.meta.dirname, "../..");
const project = mkdtempSync(join(tmpdir(), "pih-cmp-"));
const agentDir = mkdtempSync(join(tmpdir(), "pih-agent-"));
mkdirSync(join(project, ".pi"), { recursive: true });
writeFileSync(join(project, ".pi/harness.json"), JSON.stringify({ compaction: { thresholdPercent: 50 } }));

const faux = fauxProvider({ models: [{ id: "small", contextWindow: 30_000, maxTokens: 2_000 }] });
const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
	const services = await createAgentSessionServices({
		cwd,
		agentDir,
		// テスト用に「直近の保持量」を小さくして、小さなセッションでも要約対象ができるようにする
		settingsManager: SettingsManager.inMemory({ compaction: { keepRecentTokens: 1000, reserveTokens: 1000 } } as never),
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
let compactions = 0;
const bind = async () => {
	const session = runtime.session;
	await session.bindExtensions({
		commandContextActions: {
			waitForIdle: () => session.waitForIdle(),
			newSession: (o) => runtime.newSession(o),
			fork: async (id, o) => ({ cancelled: (await runtime.fork(id, o)).cancelled }),
			navigateTree: async () => ({ cancelled: true }),
			switchSession: (p, o) => runtime.switchSession(p, o),
			reload: () => session.reload(),
		},
	});
	session.subscribe((e) => {
		if (e.type === "compaction_end") compactions++;
	});
};
runtime.setRebindSession(bind);
await bind();

faux.setResponses([
	// プラン作成セッション: 大きな出力のツールでコンテキスト使用率を 50% 超にする
	call("bash", { command: "node -e \"for (let i = 0; i < 1000; i++) console.log('survey-result-' + 'x'.repeat(28) + i)\"" }),
	// しきい値超過後の次のツール呼び出しはブロックされ、実行が止まる
	call("read", { path: "README.md" }),
	// → 圧縮（要約の生成に 1 応答使う）
	fauxAssistantMessage("## 要約\n- プラン作成中。コード調査済み。"),
	// → 再開メッセージで同じセッションが続く
	call("harness_status", {}),
	fauxAssistantMessage("再開しました"),
]);
await runtime.session.prompt("/impl 1");
for (let i = 0; i < 100 && (faux.getPendingResponseCount() > 0 || !runtime.session.isIdle); i++) {
	await new Promise((r) => setTimeout(r, 100));
	await runtime.session.waitForIdle();
}
await new Promise((r) => setTimeout(r, 200));
await runtime.session.waitForIdle();

assert.equal(faux.getPendingResponseCount(), 0, "すべての応答が消費される（圧縮 → 再開まで進む）");
assert.equal(compactions, 1, "しきい値を超えたので 1 回圧縮される（Pi 自身の上限直前の圧縮ではなく piHarness のしきい値で）");
const userTexts = runtime.session.messages
	.filter((m) => m.role === "user")
	.map((m) => (typeof m.content === "string" ? m.content : m.content.map((c) => ("text" in c ? c.text : "")).join("")));
const resume = userTexts.find((t) => t.includes("を再開します"));
assert.ok(resume, "再開メッセージが送られる");
assert.match(resume, /<skill name="harness-plan"/, "圧縮で消えたスキル本文を送り直す");
assert.match(resume, /コンテキスト使用率が \d+% に達したため/);
assert.match(resume, /issue\.md — 対象 Issue の本文/, "成果物の一覧も送り直す");
await runtime.dispose();
console.log("E2E compaction: OK");
