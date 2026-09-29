import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HARNESS_TOOLS, toolsForProcess } from "../extensions/harness/tools.ts";

const builtin = ["read", "bash", "edit", "write", "grep"];
const registered = [...builtin, ...HARNESS_TOOLS, "my_other_tool"];
const active = [...builtin, ...HARNESS_TOOLS, "my_other_tool"];

describe("プロセスごとのツール", () => {
	it("ヒアリングは質問・遷移・状態だけ", () => {
		const t = toolsForProcess(active, registered, "hearing");
		assert.deepEqual(t.filter((x) => x.startsWith("harness_")).sort(), ["harness_ask", "harness_control", "harness_phase", "harness_status"]);
		assert.ok(t.includes("write"), "hearing.md を書くので書き込みは残す");
		assert.ok(t.includes("my_other_tool"), "他の拡張のツールは残す");
	});

	it("レビューと Issue 登録は読み取り専用", () => {
		for (const proc of ["review", "issues"] as const) {
			const t = toolsForProcess(active, registered, proc);
			assert.ok(!t.includes("edit") && !t.includes("write"), proc);
			assert.ok(t.includes("read") && t.includes("bash"), proc);
		}
		assert.deepEqual(toolsForProcess(active, registered, "review").filter((x) => x.startsWith("harness_")).sort(), ["harness_control", "harness_record_review", "harness_status"]);
	});

	it("テストの変更申請はテストを書き換えうるプロセスだけ", () => {
		for (const proc of ["implement", "fix", "bugfix"] as const) assert.ok(toolsForProcess(active, registered, proc).includes("harness_request_test_change"), proc);
		for (const proc of ["review", "plan", "hearing"] as const) assert.ok(!toolsForProcess(active, registered, proc).includes("harness_request_test_change"), proc);
	});

	it("フロー外では状態確認と自然言語からの開始だけ（他のツールはそのまま）", () => {
		const t = toolsForProcess(active, registered, null);
		assert.deepEqual(t.filter((x) => x.startsWith("harness_")).sort(), ["harness_control", "harness_status"]);
		assert.ok(t.includes("edit") && t.includes("my_other_tool"));
	});

	it("無効にされていた組み込みツールは勝手に有効にしない。未登録の harness ツールは足さない", () => {
		const t = toolsForProcess(["read", "harness_status"], ["read", "harness_status", "harness_run_tests"], "implement");
		assert.deepEqual(t.sort(), ["harness_run_tests", "harness_status", "read"]);
	});
});
