import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findModel, mergeConfig, normalizeModels, parseModelRef, resolveProcessModel } from "../extensions/harness/config.ts";

const models = [
	{ provider: "anthropic", id: "claude-opus-5-5" },
	{ provider: "anthropic", id: "claude-sonnet-5" },
	{ provider: "openrouter", id: "claude-sonnet-5" },
	{ provider: "ollama", id: "qwen3:8b" },
];

describe("プロセスごとのモデル設定", () => {
	it("文字列とオブジェクトの両方の書き方を受け付ける", () => {
		const w: string[] = [];
		const m = normalizeModels(
			{
				default: "anthropic/claude-sonnet-5",
				review: { model: "anthropic/claude-opus-5-5", thinking: "high" },
				implement: { thinking: "low" },
				hearing: "google/gemini-flash",
			},
			w,
		);
		assert.deepEqual(w, []);
		assert.deepEqual(m.default, { model: "anthropic/claude-sonnet-5" });
		assert.deepEqual(m.review, { model: "anthropic/claude-opus-5-5", thinking: "high" });
		assert.deepEqual(m.implement, { thinking: "low" });
		assert.deepEqual(m.hearing, { model: "google/gemini-flash" });
	});

	it("不明なプロセス名・不正な思考レベルは警告して無視する", () => {
		const w: string[] = [];
		const m = normalizeModels({ reviw: "x/y", review: { model: "a/b", thinking: "ultra" }, fix: 3 }, w);
		assert.equal(w.length, 3);
		assert.match(w[0], /reviw は不明なプロセス/);
		assert.deepEqual(m, { review: { model: "a/b" } });
	});

	it("プロセス個別の値を優先し、無い項目は default を使う", () => {
		const m = normalizeModels({ default: { model: "anthropic/claude-sonnet-5", thinking: "medium" }, review: { model: "anthropic/claude-opus-5-5" } });
		assert.deepEqual(resolveProcessModel(m, "review"), { model: "anthropic/claude-opus-5-5", thinking: "medium" });
		assert.deepEqual(resolveProcessModel(m, "implement"), { model: "anthropic/claude-sonnet-5", thinking: "medium" });
		assert.deepEqual(resolveProcessModel({}, "plan"), { model: undefined, thinking: undefined });
	});

	it("mergeConfig 経由でも正規化される", () => {
		const c = mergeConfig({ models: { bugfix: "ollama/qwen3:8b" } as never });
		assert.deepEqual(c.models, { bugfix: { model: "ollama/qwen3:8b" } });
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
