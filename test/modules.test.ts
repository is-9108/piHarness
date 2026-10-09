import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { detectTestCommand, loadConfig, mergeConfig, saveConfigPatch } from "../extensions/harness/config.ts";
import { checkBash, checkOtherTool, checkWrite, isHarnessFile, mayModify } from "../extensions/harness/guard.ts";
import { buildContext } from "../extensions/harness/guidance.ts";
import {
	ghIssueCreateArgs,
	parseIssueArg,
	parseIssueUrl,
	validateDrafts,
	draftFileName,
} from "../extensions/harness/issues.ts";
import { DEFAULT_LIMITS, initialState, startImplement, startRequirements, transition } from "../extensions/harness/state.ts";
import { slugify, tailLines } from "../extensions/harness/text.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "pih-"));
const paths = { cwd: "/repo", docsDir: "docs", workDir: ".pi/harness" };

describe("config", () => {
	it("package.json の test スクリプトを検出する", () => {
		const d = tmp();
		writeFileSync(join(d, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
		assert.equal(detectTestCommand(d), "npm test");
		writeFileSync(join(d, "pnpm-lock.yaml"), "");
		assert.equal(detectTestCommand(d), "pnpm test");
	});

	it("npm init 既定の test スクリプトは無視し pytest を検出する", () => {
		const d = tmp();
		writeFileSync(join(d, "package.json"), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
		writeFileSync(join(d, "pyproject.toml"), "");
		assert.equal(detectTestCommand(d), "python3 -m pytest -q");
	});

	it("同じ失敗・flaky・ベースライン・テストのロックの設定", () => {
		const d = mergeConfig({});
		assert.deepEqual([d.sameFailureLimit, d.flakyRetries, d.baseline, d.testLock], [2, 1, true, true]);
		const off = mergeConfig({ sameFailureLimit: 0, flakyRetries: 0, baseline: false, testLock: false });
		assert.deepEqual([off.sameFailureLimit, off.flakyRetries, off.baseline, off.testLock], [0, 0, false, false]);
		const w: string[] = [];
		const bad = mergeConfig({ sameFailureLimit: 1, flakyRetries: 9, testLock: "yes" as never }, w);
		assert.deepEqual([bad.sameFailureLimit, bad.flakyRetries, bad.testLock], [2, 1, true]);
		assert.equal(w.length, 3);
	});

	it("利用上限でのモデルの切り替えの設定", () => {
		assert.deepEqual(mergeConfig({}).fallback, { enabled: true, quotaCooldownMinutes: 60, transientCooldownMinutes: 10 });
		assert.deepEqual(mergeConfig({ fallback: { enabled: false, quotaCooldownMinutes: 180 } as never }).fallback, {
			enabled: false,
			quotaCooldownMinutes: 180,
			transientCooldownMinutes: 10,
		});
		const w: string[] = [];
		assert.equal(mergeConfig({ fallback: { quotaCooldownMinutes: 0 } as never }, w).fallback.quotaCooldownMinutes, 60);
		assert.equal(w.length, 1);
	});

	it("不正な値は既定値に戻して警告する", () => {
		const w: string[] = [];
		const c = mergeConfig({ maxTestLoops: 0, blockingSeverities: ["fatal" as never] }, w);
		assert.equal(c.maxTestLoops, 3);
		assert.deepEqual(c.blockingSeverities, ["blocker", "major"]);
		assert.equal(w.length, 2);
	});

	it("harness.json を読み込み、パッチ保存で既存値を保持する", () => {
		const d = tmp();
		mkdirSync(join(d, ".pi"));
		writeFileSync(join(d, ".pi/harness.json"), JSON.stringify({ maxReviewLoops: 2, docsDir: "documents" }));
		saveConfigPatch(d, { testCommand: "make check" });
		const { config } = loadConfig(d);
		assert.equal(config.maxReviewLoops, 2);
		assert.equal(config.docsDir, "documents");
		assert.equal(config.testCommand, "make check");
		assert.match(readFileSync(join(d, ".pi/harness.json"), "utf8"), /make check/);
	});
});

describe("guard", () => {
	it("要件定義中は docs と作業ディレクトリのみ書き込める", () => {
		const s = startRequirements(initialState(), "t", DEFAULT_LIMITS, ".pi/harness/req-x");
		assert.equal(checkWrite(s, "docs/requirements/a.md", paths).block, false);
		assert.equal(checkWrite(s, "/repo/.pi/harness/x.md", paths).block, false);
		assert.equal(checkWrite(s, "src/index.ts", paths).block, true);
		assert.equal(checkWrite(s, "docs/../src/a.ts", paths).block, true);
	});

	it("プラン承認前はコードを変更できず、承認後の TDD 中は制限しない", () => {
		let s = transition(startImplement(initialState(), { title: "x" }, DEFAULT_LIMITS, ".pi/harness/issue-1"), "impl_plan");
		assert.equal(checkWrite(s, "src/a.ts", paths).block, true);
		assert.equal(checkWrite(s, ".pi/harness/plans/p.md", paths).block, false);
		s = { ...s, phase: "impl_tdd" };
		assert.equal(checkWrite(s, "src/a.ts", paths).block, false);
	});

	it("フロー外では制限しない", () => {
		assert.equal(checkWrite(initialState(), "src/a.ts", paths).block, false);
		assert.equal(checkBash(initialState(), "gh issue create -t x").block, false);
	});

	it("フロー中の gh issue create は専用ツールへ誘導する", () => {
		const s = startRequirements(initialState(), "t", DEFAULT_LIMITS, ".pi/harness/req-x");
		assert.equal(checkBash(s, "gh issue create --title x").block, true);
		assert.equal(checkBash(s, "gh issue list").block, false);
	});

	it("仕様の確認待ちの間はコードを変更できない", () => {
		const s = { ...startImplement(initialState(), { title: "x" }, DEFAULT_LIMITS, ".pi/harness/issue-1"), phase: "impl_spec_gap" as const };
		assert.equal(checkWrite(s, "src/a.ts", paths).block, true);
		assert.match(checkWrite(s, "src/a.ts", paths).reason ?? "", /仕様の確認/);
		assert.equal(checkWrite(s, ".pi/harness/issue-1/notes.md", paths).block, false);
	});

	it("MCP ツールなど名前で検査できないツールは、読み取り専用と宣言されたものだけ書き込み制限中に使える", () => {
		assert.equal(mayModify({ name: "mcp__fs__write_file" }), true, "注釈の無い MCP ツールは MCP の既定どおり書き換えうる");
		assert.equal(mayModify({ name: "mcp__fs__read_file", annotations: { readOnlyHint: true } }), false);
		assert.equal(mayModify({ name: "my_tool", annotations: { readOnlyHint: false } }), true);
		assert.equal(mayModify({ name: "my_tool" }), false, "注釈を宣言していない他の拡張のツールは判断できないので許可");
		for (const name of ["read", "bash", "edit", "write", "codemode", "tool_search", "harness_phase"]) assert.equal(mayModify({ name }), false, name);

		const plan = transition(startImplement(initialState(), { title: "x" }, DEFAULT_LIMITS, ".pi/harness/issue-1"), "impl_plan");
		const d = checkOtherTool(plan, { name: "mcp__fs__write_file" }, paths);
		assert.equal(d.block, true);
		assert.match(d.reason ?? "", /プランが承認されるまで[\s\S]*readOnlyHint/);
		assert.equal(checkOtherTool(plan, { name: "mcp__fs__read_file", annotations: { readOnlyHint: true } }, paths).block, false);
		assert.equal(checkOtherTool({ ...plan, phase: "impl_tdd" }, { name: "mcp__fs__write_file" }, paths).block, false, "TDD 中は制限しない");
		assert.equal(checkOtherTool(initialState(), { name: "mcp__fs__write_file" }, paths).block, false, "フロー外では制限しない");
	});

	it("作業ファイル判定", () => {
		assert.equal(isHarnessFile(".pi/harness/logs/a.log", paths), true);
		assert.equal(isHarnessFile("src/a.ts", paths), false);
	});
});

describe("issues", () => {
	const draft = { title: "a", background: "x", inScope: ["x"], acceptanceCriteria: ["y"] };

	it("必須項目の無い Issue・前方以外への依存を拒否する", () => {
		assert.deepEqual(validateDrafts([draft]), []);
		const errs = validateDrafts([
			{ ...draft, acceptanceCriteria: [] },
			{ ...draft, title: "b", dependsOn: [1] },
			{ ...draft, title: "c", background: " ", inScope: [] },
		]);
		assert.equal(errs.length, 4);
		assert.match(errs[0], /受け入れ条件/);
		assert.match(errs[1], /dependsOn/);
		assert.match(errs[2], /background/);
		assert.match(errs[3], /inScope/);
	});

	it("gh 引数と URL 解析", () => {
		assert.deepEqual(ghIssueCreateArgs("t", "b", ["feat"], "o/r"), [
			"issue", "create", "--title", "t", "--body", "b", "--label", "feat", "--repo", "o/r",
		]);
		assert.deepEqual(parseIssueUrl("Creating issue\nhttps://github.com/o/r/issues/42\n"), {
			url: "https://github.com/o/r/issues/42",
			number: 42,
		});
		assert.deepEqual(parseIssueUrl("error"), {});
	});

	it("/impl の引数解析", () => {
		assert.equal(parseIssueArg("12"), 12);
		assert.equal(parseIssueArg("#7"), 7);
		assert.equal(parseIssueArg("https://github.com/o/r/issues/99"), 99);
		assert.equal(parseIssueArg("abc"), undefined);
	});

	it("Markdown ファイル名", () => {
		assert.equal(draftFileName(0, "ログイン API を追加"), "01-ログイン-api-を追加.md");
	});
});

describe("text / guidance", () => {
	it("末尾の行を残して切り詰める", () => {
		const r = tailLines("1\n2\n3\n4\n", 2);
		assert.deepEqual(r, { text: "3\n4", truncated: 2 });
	});

	it("slugify", () => {
		assert.equal(slugify("  Hello, World!  "), "hello-world");
		assert.equal(slugify("!!!"), "item");
	});

	it("コンテキストに現在フェーズと次の行動を含める", () => {
		const s = startImplement(initialState(), { number: 3, title: "API" }, DEFAULT_LIMITS, ".pi/harness/issue-1");
		const text = buildContext(s, { ...mergeConfig({}), testCommand: "npm test" });
		assert.match(text, /impl_context/);
		assert.match(text, /#3 API/);
		assert.match(text, /npm test/);
		assert.match(text, /impl_plan/);
	});

	it("同じ失敗の回数・ベースライン・テストのロック・回答待ちの仕様の確認を伝える", () => {
		const base = startImplement(initialState(), { number: 3, title: "API" }, DEFAULT_LIMITS, ".pi/harness/issue-1");
		const s = {
			...base,
			phase: "impl_tdd" as const,
			test: { ...base.test, failures: 1, failureHistory: ["a"] },
			baseline: { at: "", commands: ["npm test"], failures: [{ command: "npm test", killed: false, lines: [], recognized: true }] },
			testLock: { mode: "green" as const, at: "", files: { "a.test.ts": "h" }, allowed: [] },
		};
		const text = buildContext(s, mergeConfig({}));
		assert.match(text, /同じ失敗: 1\/2 回/);
		assert.match(text, /ベースライン（開始時点ですでに失敗。同じ失敗だけなら判定から除外）: npm test/);
		assert.match(text, /テストのロック: Red で確かめたテスト（1 ファイル）は Green の合格まで変更・追加できない/);
		const gap = { ...base, phase: "impl_spec_gap" as const, specGaps: [{ id: "Q1", criterion: "AC-1", question: "q?", interpretations: ["a", "b"], round: 1 }] };
		assert.match(buildContext(gap, mergeConfig({})), /回答待ちの仕様の確認:\n- Q1 \[AC-1\] q\?（解釈: a \/ b）[\s\S]*answer_spec_gap/);
	});
});
