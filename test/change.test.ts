import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { invalidJson, outOfScope, stripJsonc } from "../extensions/harness/change.ts";
import { stepsLine } from "../extensions/harness/dashboard.ts";
import { checkWrite } from "../extensions/harness/guard.ts";
import { artifactPaths, processIO, skillFor } from "../extensions/harness/handoff.ts";
import {
	applyApproval,
	beginApproval,
	clearHandoff,
	DEFAULT_LIMITS as L,
	type HarnessState,
	initialState,
	isWorking,
	processOf,
	recordTestRun,
	startConfigChange,
	statusLine,
	transition,
	TransitionError,
	withHandoff,
} from "../extensions/harness/state.ts";
import { configPrVars, renderTemplate } from "../extensions/harness/templates.ts";
import { toolsForProcess } from "../extensions/harness/tools.ts";

const DIR = ".pi/harness/config-1";
const P = artifactPaths(DIR);
const step = (prev: HarnessState, next: HarnessState) => clearHandoff(withHandoff(prev, next));

function applying(): HarnessState {
	let s = step(initialState(), startConfigChange(initialState(), "ポートを変える", undefined, L, DIR));
	s = step(s, beginApproval(s, "change", [P.changePlan], ["config.json", ".github/workflows/ci.yml"]));
	return step(s, applyApproval(s, "change", "approved", undefined, [P.changePlan]));
}

describe("設定変更フロー: 状態機械", () => {
	it("計画 → 承認 → 変更 → 完了。1 つのプロセス（セッション）で行い、テストもレビューも無い", () => {
		const start = startConfigChange(initialState(), "ポートを変える", undefined, L, DIR);
		assert.equal(start.flow, "config");
		assert.equal(start.phase, "cfg_plan");
		assert.equal(withHandoff(initialState(), start).pendingHandoff?.to, "config");
		const s = applying();
		assert.equal(s.phase, "cfg_apply");
		assert.deepEqual(s.changeFiles, ["config.json", ".github/workflows/ci.yml"]);
		assert.equal(s.pendingHandoff, undefined, "承認後も同じセッションで続ける");
		assert.throws(() => recordTestRun(s, "green", true), TransitionError);
		const done = transition(s, "cfg_done");
		assert.equal(done.phase, "cfg_done");
		assert.equal(processOf(done), "config");
		assert.equal(isWorking(done), false, "完了したら何も制限しない");
		assert.equal(withHandoff(s, done).pendingHandoff, undefined);
	});

	it("変更するファイルを指定しない計画は承認に出せない", () => {
		const s = step(initialState(), startConfigChange(initialState(), "t", undefined, L, DIR));
		assert.throws(() => beginApproval(s, "change", [P.changePlan]), /files/);
		assert.throws(() => beginApproval(s, "change", [P.changePlan], []), /files/);
	});

	it("修正依頼は計画に戻り、承認待ちでは変更できない", () => {
		let s = step(initialState(), startConfigChange(initialState(), "t", undefined, L, DIR));
		s = beginApproval(s, "change", [P.changePlan], ["a.json"]);
		assert.equal(applyApproval(s, "change", "revise", "x", [P.changePlan]).phase, "cfg_plan");
		assert.throws(() => transition(s, "cfg_done"), TransitionError);
	});

	it("表示・ツール・スキル・入出力", () => {
		const s = applying();
		assert.doesNotMatch(statusLine(s), /test|review/);
		assert.match(stepsLine(s), /✓ 計画 › ✓ 承認 › ▶ 変更 › ○ 完了（コミット・PR）/);
		const tools = toolsForProcess(["write", "edit"], ["harness_run_tests", "harness_record_review", "harness_request_approval", "harness_phase"], "config");
		assert.ok(tools.includes("write") && tools.includes("harness_request_approval") && tools.includes("harness_phase"));
		assert.ok(!tools.includes("harness_run_tests") && !tools.includes("harness_record_review"));
		assert.equal(skillFor(s, "config"), "harness-config");
		assert.ok(processIO(s, () => true)!.inputs.some((i) => i.path === P.changePlan));
	});
});

describe("設定変更フロー: 変更できる範囲", () => {
	const paths = { cwd: "/r", docsDir: "docs", workDir: ".pi/harness" };

	it("計画の承認前は作業ディレクトリだけ、承認後は承認したファイルだけ書ける", () => {
		const planning = step(initialState(), startConfigChange(initialState(), "t", undefined, L, DIR));
		assert.match(checkWrite(planning, "config.json", paths).reason ?? "", /計画が承認されるまで/);
		assert.equal(checkWrite(planning, P.changePlan, paths).block, false);
		const s = applying();
		assert.equal(checkWrite(s, "config.json", paths).block, false);
		assert.equal(checkWrite(s, "/r/.github/workflows/ci.yml", paths).block, false, "絶対パスでも同じファイルなら書ける");
		assert.match(checkWrite(s, "src/app.ts", paths).reason ?? "", /承認された計画のファイルだけ.*config\.json/);
		assert.equal(checkWrite(s, "README.md", paths).block, true, "ドキュメントでも計画に無ければ書けない");
	});

	it("完了前の確認: 承認していないファイルの変更と、壊れた JSON を見つける", () => {
		assert.deepEqual(outOfScope(["config.json", "./src/a.ts"], ["config.json"], "/r"), ["./src/a.ts"]);
		assert.deepEqual(outOfScope(["/r/config.json"], ["config.json"], "/r"), []);
		assert.deepEqual(invalidJson({ "a.json": '{"x": 1}', "b.yml": "x: [", "c.json": '{"x": 1' }).map((e) => e.file), ["c.json"]);
	});

	it("コメント・末尾のカンマ付きの JSON（tsconfig.json など）は壊れているとみなさない", () => {
		const jsonc = '{\n  // コメント "x"\n  "url": "http://example.com/a", /* ブロック */\n  "list": [1, 2,],\n}\n';
		assert.deepEqual(JSON.parse(stripJsonc(jsonc)), { url: "http://example.com/a", list: [1, 2] });
		assert.deepEqual(invalidJson({ "tsconfig.json": jsonc }), []);
	});
});

describe("設定変更フロー: PR 本文", () => {
	it("計画の見出しと git の差分・承認から作る", () => {
		const tpl = readFileSync(join(resolve(import.meta.dirname, "../templates"), "pr-config.md"), "utf8");
		const plan = "# 計画\n\n## 目的\n\n既定のポートを変える。\n\n## 変更内容\n\n- port: 8080 → 9090\n\n## 影響範囲\n\n- src/app.js\n\n## 戻し方\n\n- revert\n";
		const body = renderTemplate(
			tpl,
			configPrVars({
				plan,
				topic: "ポートを変える",
				approvedFiles: ["config.json"],
				changedFiles: ["config.json"],
				approval: { decision: "approved", comment: "OK", at: "2026-10-11T00:00:00.000Z" },
			}),
		);
		assert.deepEqual(
			body.split("\n").filter((l) => l.startsWith("## ")),
			["## 目的", "## 対象", "## 変更内容", "## 変更したファイル", "## 影響範囲", "## 戻し方", "## 承認"],
		);
		assert.match(body, /## 目的\n\n既定のポートを変える。/);
		assert.match(body, /\*\*計画で承認したファイル\*\*\n\n- `config\.json`/);
		assert.match(body, /2026-10-11T00:00:00\.000Z にユーザーが承認（コメント: OK）/);
		assert.doesNotMatch(body, /Closes|\{\{|<!--/);
	});
});
