import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findModel, mergeConfig, normalizeGit, normalizeModels, parseModelRef, resolveProcessModel } from "../extensions/harness/config.ts";

const models = [
	{ provider: "anthropic", id: "claude-opus-5-5" },
	{ provider: "anthropic", id: "claude-sonnet-5" },
	{ provider: "openrouter", id: "claude-sonnet-5" },
	{ provider: "ollama", id: "qwen3:8b" },
];

describe("プロセスごとのモデル設定", () => {
	it("文字列・配列（フォールバック）・オブジェクトの書き方を受け付ける", () => {
		const w: string[] = [];
		const m = normalizeModels(
			{
				default: "anthropic/claude-sonnet-5",
				review: { model: ["anthropic/claude-opus-5-5", "openrouter/claude-sonnet-5"], thinking: "high" },
				implement: { thinking: "low" },
				hearing: ["google/gemini-flash", "ollama/qwen3:8b"],
				review_light: "anthropic/claude-sonnet-5",
			},
			w,
		);
		assert.deepEqual(w, []);
		assert.deepEqual(m.default, { model: ["anthropic/claude-sonnet-5"] });
		assert.deepEqual(m.review, { model: ["anthropic/claude-opus-5-5", "openrouter/claude-sonnet-5"], thinking: "high" });
		assert.deepEqual(m.implement, { thinking: "low" });
		assert.deepEqual(m.hearing, { model: ["google/gemini-flash", "ollama/qwen3:8b"] });
		assert.deepEqual(m.review_light, { model: ["anthropic/claude-sonnet-5"] });
	});

	it("不明なキー・不正な思考レベル・不正なモデル指定は警告して無視する", () => {
		const w: string[] = [];
		const m = normalizeModels({ reviw: "x/y", review: { model: "a/b", thinking: "ultra" }, fix: 3, plan: { model: [1] } }, w);
		assert.equal(w.length, 4);
		assert.match(w[0], /reviw は不明なプロセス/);
		assert.deepEqual(m, { review: { model: ["a/b"] } });
	});

	it("レビューの周回別キー → プロセス → default の順に項目ごとに決める", () => {
		const m = normalizeModels({
			default: { model: "anthropic/claude-sonnet-5", thinking: "medium" },
			review: { model: "anthropic/claude-opus-5-5", thinking: "high" },
			review_light: { model: "ollama/qwen3:8b" },
		});
		assert.deepEqual(resolveProcessModel(m, "review", "review_full"), { model: ["anthropic/claude-opus-5-5"], thinking: "high" });
		assert.deepEqual(resolveProcessModel(m, "review", "review_light"), { model: ["ollama/qwen3:8b"], thinking: "high" });
		assert.deepEqual(resolveProcessModel(m, "implement"), { model: ["anthropic/claude-sonnet-5"], thinking: "medium" });
		assert.deepEqual(resolveProcessModel({}, "plan"), { model: undefined, thinking: undefined });
	});

	it("mergeConfig 経由でも正規化される", () => {
		const c = mergeConfig({ models: { bugfix: "ollama/qwen3:8b" } as never });
		assert.deepEqual(c.models, { bugfix: { model: ["ollama/qwen3:8b"] } });
		assert.deepEqual(mergeConfig({}).models, {});
	});

	it("provider/model-id と model-id のみの指定で検索できる", () => {
		assert.deepEqual(parseModelRef("ollama/qwen3:8b"), { provider: "ollama", id: "qwen3:8b" });
		assert.deepEqual(parseModelRef("claude-opus-5-5"), { id: "claude-opus-5-5" });
		assert.equal(findModel("openrouter/claude-sonnet-5", models).model?.provider, "openrouter");
		assert.equal(findModel("claude-opus-5-5", models).model?.provider, "anthropic");
		assert.match(findModel("claude-sonnet-5", models).error ?? "", /複数のプロバイダー/);
		assert.match(findModel("anthropic/nope", models).error ?? "", /見つかりません/);
	});
});

describe("Git・チェック設定", () => {
	it("git 設定の既定値と検証", () => {
		assert.deepEqual(normalizeGit(undefined), {
			enabled: true,
			branchPrefix: "issue-",
			commit: true,
			commitArtifacts: false,
			pr: "ask",
			draft: false,
			dirtyStart: "ask",
			pullBase: true,
		});
		const w: string[] = [];
		const g = normalizeGit({ pr: "always", draft: "yes", branchPrefix: "feat/", dirtyStart: "refuse" }, w);
		assert.equal(w.length, 2);
		assert.equal(g.pr, "ask");
		assert.equal(g.branchPrefix, "feat/");
		assert.equal(g.dirtyStart, "refuse");
		assert.equal(normalizeGit({ branchPrefix: "bad prefix" }, w).branchPrefix, "issue-");
		assert.equal(normalizeGit({ pullBase: false }).pullBase, false);
	});

	it("checkCommands は文字列の配列のみ", () => {
		const w: string[] = [];
		assert.deepEqual(mergeConfig({ checkCommands: ["npm run lint", "npx tsc --noEmit"] }).checkCommands, ["npm run lint", "npx tsc --noEmit"]);
		assert.deepEqual(mergeConfig({ checkCommands: "npm run lint" as never }, w).checkCommands, []);
		assert.equal(w.length, 1);
		assert.equal(mergeConfig({}).testIntegrity, true);
	});
});
