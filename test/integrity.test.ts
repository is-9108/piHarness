import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyzeTestDiff, isTestFile, parsePatch, signature } from "../extensions/harness/integrity.ts";

const patch = (file: string, removed: string[], added: string[]) =>
	`diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n${removed.map((l) => `-${l}`).join("\n")}\n${added.map((l) => `+${l}`).join("\n")}\n`;

describe("テストを弱める変更の検知", () => {
	it("テストファイルの判定", () => {
		for (const f of ["test/a.js", "src/__tests__/x.ts", "a.test.ts", "b.spec.jsx", "x_test.go", "tests/test_x.py", "FooTest.java", "a_spec.rb"]) {
			assert.ok(isTestFile(f), f);
		}
		for (const f of ["src/a.ts", "docs/testing.md", "latest.js"]) assert.ok(!isTestFile(f), f);
	});

	it("テストファイルの削除を検知（名前変更は対象外）", () => {
		const f = analyzeTestDiff("D\ttest/a.test.js\nR100\ttest/b.test.js\ttest/c.test.js\nD\tsrc/old.js\n", "");
		assert.deepEqual(f.map((x) => [x.kind, x.file]), [["deleted_test_file", "test/a.test.js"]]);
	});

	it("スキップ・フォーカスの追加を検知し、スキップの解除は問題にしない", () => {
		const f = analyzeTestDiff(
			"",
			patch("a.test.ts", [], ["it.skip('x', () => {})", "describe.only('y', () => {})"]) +
				patch("test_x.py", [], ["@pytest.mark.skip(reason='later')"]) +
				patch("b.test.ts", ["it.skip('x', () => {})"], ["it('x', () => {})"]),
		);
		assert.deepEqual(
			f.map((x) => [x.kind, x.file]),
			[
				["skip_added", "a.test.ts"],
				["focus_added", "a.test.ts"],
				["skip_added", "test_x.py"],
			],
		);
	});

	it("アサーションの減少を検知（テスト以外のファイルは対象外）", () => {
		const f = analyzeTestDiff(
			"",
			patch("a.test.ts", ["  expect(a).toBe(1);", "  expect(b).toBe(2);"], ["  expect(a).toBe(1);"]) +
				patch("src/a.ts", ["assert(x)"], []),
		);
		assert.deepEqual(f.map((x) => [x.kind, x.file, x.detail]), [["assertions_reduced", "a.test.ts", "アサーションが差し引き 1 行減っています"]]);
		assert.deepEqual(analyzeTestDiff("", patch("a.test.ts", ["expect(a).toBe(1)"], ["expect(a).toEqual(1)"])), [], "書き換えは問題にしない");
	});

	it("パッチの分解と署名", () => {
		const files = parsePatch(patch("a.test.ts", ["old"], ["new"]));
		assert.deepEqual(files.get("a.test.ts"), { added: ["new"], removed: ["old"] });
		const a = analyzeTestDiff("D\ttest/x.js\n", "");
		assert.equal(signature(a), signature([...a]));
	});
});
