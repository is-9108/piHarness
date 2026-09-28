import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emptyRegistry, issueId, nextIssue, progressTable, registerIssues, setStatus } from "../extensions/harness/progress.ts";
import { summarize, sumSession, type UsageFile, upsertSession, usageMarkdown } from "../extensions/harness/usage.ts";

describe("Issue の進み具合", () => {
	const reg = registerIssues(
		emptyRegistry(),
		[
			{ number: 1, title: "基盤" },
			{ number: 2, title: "取得", dependsOn: [0] },
			{ number: 3, title: "保存", dependsOn: [1] },
			{ number: 4, title: "起動スクリプト", dependsOn: [0] },
		],
		".pi/harness/req-x",
		"t0",
	);

	it("依存関係を id で保存する", () => {
		assert.deepEqual(reg.issues.map((i) => [i.id, i.deps]), [["#1", []], ["#2", ["#1"]], ["#3", ["#2"]], ["#4", ["#1"]]]);
		assert.equal(issueId({ file: "docs/issues/01-a.md", title: "a" }), "file:docs/issues/01-a.md");
	});

	it("依存が完了した未着手の Issue を登録順に選ぶ", () => {
		assert.equal(nextIssue(reg).issue?.id, "#1");
		let r = setStatus(reg, { number: 1, title: "基盤" }, "in_progress");
		assert.equal(nextIssue(r).issue, undefined);
		assert.deepEqual(nextIssue(r).inProgress.map((i) => i.id), ["#1"]);
		r = setStatus(r, { number: 1, title: "基盤" }, "done");
		assert.equal(nextIssue(r).issue?.id, "#2");
		r = setStatus(r, { number: 2, title: "取得" }, "done");
		assert.equal(nextIssue(r).issue?.id, "#3");
		assert.deepEqual(nextIssue(reg).blocked.map((b) => [b.issue.id, b.waitingFor]), [["#2", ["#1"]], ["#3", ["#2"]], ["#4", ["#1"]]]);
	});

	it("再登録しても状態は保持し、未登録の Issue は追加する", () => {
		let r = setStatus(reg, { number: 1, title: "基盤" }, "done");
		r = registerIssues(r, [{ number: 1, title: "基盤（改）" }], undefined);
		assert.equal(r.issues[0].status, "done");
		assert.equal(r.issues[0].title, "基盤（改）");
		r = setStatus(r, { number: 99, title: "直接指定" }, "in_progress");
		assert.equal(r.issues.at(-1)?.id, "#99");
		assert.match(progressTable(r), /1\/5 完了[\s\S]*▶ #99 直接指定/);
	});
});

describe("モデル利用量", () => {
	const msg = (provider: string, model: string, input: number, output: number, cost: number) => ({
		type: "message",
		message: { role: "assistant", provider, model, usage: { input, output, cacheRead: 0, cacheWrite: 0, cost: { total: cost } } },
	});

	it("セッションのアシスタントメッセージをモデルごとに合計する", () => {
		const s = sumSession([msg("a", "m1", 10, 5, 0.1), { type: "message", message: { role: "user" } }, msg("a", "m1", 1, 1, 0.01), msg("b", "m2", 3, 3, 0)]);
		assert.deepEqual(s["a/m1"], { calls: 2, input: 11, output: 6, cacheRead: 0, cacheWrite: 0, cost: 0.11 });
		assert.equal(s["b/m2"].calls, 1);
	});

	it("同じセッションは上書きし、プロセス別に集計する", () => {
		let f: UsageFile = { version: 1, sessions: [] };
		f = upsertSession(f, { sessionId: "s1", process: "hearing", models: sumSession([msg("a", "cheap", 100, 10, 0.001)]), updatedAt: "" });
		f = upsertSession(f, { sessionId: "s1", process: "hearing", models: sumSession([msg("a", "cheap", 200, 20, 0.002)]), updatedAt: "" });
		f = upsertSession(f, { sessionId: "s2", process: "requirements", models: sumSession([msg("a", "strong", 50, 50, 0.5)]), updatedAt: "" });
		const { byProcess, total } = summarize(f);
		assert.equal(f.sessions.length, 2);
		assert.equal(byProcess.get("hearing")?.input, 200);
		assert.equal(total.cost, 0.502);
		assert.match(usageMarkdown(f, { hearing: "要件ヒアリング", requirements: "要件定義書作成" }), /要件ヒアリング \| 1 \| 1 \| 200[\s\S]*\*\*\$0\.5020\*\*/);
	});
});
