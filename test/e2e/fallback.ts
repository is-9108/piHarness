/**
 * E2E: プロバイダーの利用上限でのモデルの切り替え。
 * 偽のプロバイダーを 2 つ（primary / backup）用意し、primary が利用上限のエラーを返したら、
 * piHarness が primary を上限として記録し、models の次の候補（backup）に切り替えて同じセッションで再開することを確かめる。
 * 上限の記録は以降のプロセス（新しいセッション）にも効き、候補がすべて上限なら止まる。
 *
 *   node test/e2e/fallback.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
const project = mkdtempSync(join(tmpdir(), "pih-fb-"));
const agentDir = mkdtempSync(join(tmpdir(), "pih-agent-"));
mkdirSync(join(project, ".pi"), { recursive: true });
writeFileSync(
	join(project, ".pi/harness.json"),
	JSON.stringify({ models: { default: ["primary/m", "backup/m"] }, dashboard: false }),
);

const primary = fauxProvider({ provider: "primary", api: "faux-primary", models: [{ id: "m" }] });
const backup = fauxProvider({ provider: "backup", api: "faux-backup", models: [{ id: "m" }] });
const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const say = (text: string) => fauxAssistantMessage(text);
// pi が再試行しない利用上限のエラー（OpenCode Go の月間上限・OpenAI の insufficient_quota と同じ文言）
const limitError = (message: string) => fauxAssistantMessage("", { stopReason: "error", errorMessage: message });

const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
	const services = await createAgentSessionServices({
		cwd,
		agentDir,
		settingsManager: SettingsManager.inMemory(),
		resourceLoaderOptions: {
			additionalExtensionPaths: [join(root, "extensions/harness/index.ts")],
			additionalSkillPaths: [join(root, "skills")],
			extensionFactories: [(pi) => pi.registerProvider(primary.provider), (pi) => pi.registerProvider(backup.provider)],
		},
	});
	const created = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model: primary.getModel() });
	return { ...created, services, diagnostics: services.diagnostics };
};
const runtime = await createAgentSessionRuntime(createRuntime, { cwd: project, agentDir, sessionManager: SessionManager.inMemory() });
const sessions: AgentSession[] = [];
const results: string[] = [];
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
	const no = sessions.push(session);
	session.subscribe((e) => {
		if (e.type === "tool_execution_end") {
			const text = (e.result?.content ?? []).map((c: { text?: string }) => c.text ?? "").join("");
			results.push(`${no}:${e.toolName}${e.isError ? " [ERROR]" : ""}: ${text.split("\n")[0]}`);
		}
	});
}
runtime.setRebindSession(bind);
await bind();

const pending = () => primary.getPendingResponseCount() + backup.getPendingResponseCount();
async function run(prompt: string, primaryResponses: ReturnType<typeof say>[], backupResponses: ReturnType<typeof say>[]): Promise<void> {
	primary.setResponses(primaryResponses);
	backup.setResponses(backupResponses);
	await runtime.session.prompt(prompt);
	for (let i = 0; i < 100; i++) {
		await new Promise((r) => setTimeout(r, 50));
		await runtime.session.waitForIdle();
		if (pending() === 0 && runtime.session.isIdle) {
			await new Promise((r) => setTimeout(r, 150));
			if (runtime.session.isIdle) break;
		}
	}
	assert.equal(pending(), 0, `未消費の応答があります: ${prompt}`);
}
const state = () => JSON.parse(readFileSync(join(project, ".pi/harness/state.json"), "utf8"));
const status = () => JSON.parse(readFileSync(join(project, ".pi/harness/provider-status.json"), "utf8"));
const userTexts = (s: AgentSession) =>
	s.messages
		.filter((m) => m.role === "user")
		.map((m) => (typeof m.content === "string" ? m.content : m.content.map((c) => ("text" in c ? c.text : "")).join("")));
const item = `.pi/harness/req-${new Date().toISOString().slice(0, 10)}-温度ロガー`;

// 1) ヒアリングを primary で始める → 利用上限のエラーで止まる → backup に切り替えて同じセッションで再開
await run(
	"/req 温度ロガー",
	[limitError("GoUsageLimitError: Monthly usage limit reached. Try again in 2 hours.")],
	[
		call("write", { path: `${item}/hearing.md`, content: "# 確定事項" }),
		call("harness_phase", { to: "req_document" }), // → 要件定義書作成（新しいセッション）
		say("要件定義書を作ります。"),
	],
);
for (const x of results) console.log("  ", x);
assert.equal(sessions.length, 3, "切り替えは同じセッションで行い、次のプロセスは新しいセッション");
const hearing = sessions[1];
assert.match(userTexts(hearing).at(-1) ?? "", /前のモデル（primary\/m）が利用上限に達して応答が止まったため、backup\/m に切り替えました/);
assert.equal(hearing.model?.provider, "backup");
const s1 = status();
assert.equal(s1.providers.primary.kind, "quota");
const until = new Date(s1.providers.primary.until).getTime() - Date.now();
assert.ok(until > 110 * 60_000 && until <= 120 * 60_000, "エラーの本文（Try again in 2 hours）から解除の時刻を読む");
assert.ok(state().log.some((l: { event: string }) => /primary\/m が利用上限のため backup\/m に切り替え/.test(l.event)));

// 2) 次のプロセスも、上限が解除されるまでは primary を避ける
assert.equal(state().phase, "req_document");
assert.equal(sessions[2].model?.provider, "backup", "新しいセッションでも上限中のプロバイダーを避ける");

// 3) backup も上限 → 切り替え先が無いので止まる（勝手に再開しない）
await run("続けて", [], [limitError("insufficient_quota: You exceeded your current quota, please check your plan and billing details.")]);
assert.equal(sessions.length, 3);
assert.equal(userTexts(sessions[2]).filter((t) => t.includes("切り替えました")).length, 0, "切り替え先が無ければ再開の指示を送らない");
assert.deepEqual(Object.keys(status().providers).sort(), ["backup", "primary"]);
assert.ok(state().log.some((l: { event: string }) => /backup\/m が利用上限で停止（切り替え先なし）/.test(l.event)));

await runtime.dispose();
console.log(`E2E fallback: OK (${sessions.length} sessions)`);
