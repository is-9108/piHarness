import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { detectTestCommand, loadConfig, mergeConfig, saveConfigPatch } from "../extensions/harness/config.ts";
import { checkBash, checkWrite, isHarnessFile } from "../extensions/harness/guard.ts";
import { buildContext } from "../extensions/harness/guidance.ts";
import {
	ghIssueCreateArgs,
	parseIssueArg,
	parseIssueUrl,
	validateDrafts,
	withDependencies,
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
		const s = startRequirements(initialState(), "t", DEFAULT_LIMITS);
		assert.equal(checkWrite(s, "docs/requirements/a.md", paths).block, false);
		assert.equal(checkWrite(s, "/repo/.pi/harness/x.md", paths).block, false);
		assert.equal(checkWrite(s, "src/index.ts", paths).block, true);
		assert.equal(checkWrite(s, "docs/../src/a.ts", paths).block, true);
	});

	it("プラン承認前はコードを変更できず、承認後の TDD 中は制限しない", () => {
		let s = transition(startImplement(initialState(), { title: "x" }, DEFAULT_LIMITS), "impl_plan");
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
		const s = startRequirements(initialState(), "t", DEFAULT_LIMITS);
		assert.equal(checkBash(s, "gh issue create --title x").block, true);
		assert.equal(checkBash(s, "gh issue list").block, false);
	});

	it("作業ファイル判定", () => {
		assert.equal(isHarnessFile(".pi/harness/logs/a.log", paths), true);
		assert.equal(isHarnessFile("src/a.ts", paths), false);
	});
});

describe("issues", () => {
	const body = "## 背景\nx\n## 受け入れ条件\n- [ ] y";

	it("受け入れ条件の無い Issue・前方以外への依存を拒否する", () => {
		assert.deepEqual(validateDrafts([{ title: "a", body }]), []);
		const errs = validateDrafts([
			{ title: "a", body: "本文のみ" },
			{ title: "b", body, dependsOn: [1] },
		]);
		assert.equal(errs.length, 2);
		assert.match(errs[0], /受け入れ条件/);
		assert.match(errs[1], /dependsOn/);
	});

	it("依存 Issue の番号を本文に追記する", () => {
		const out = withDependencies({ title: "b", body, dependsOn: [0] }, [{ title: "a", number: 12 }]);
		assert.match(out, /## 依存関係[\s\S]*- #12/);
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
		const s = startImplement(initialState(), { number: 3, title: "API" }, DEFAULT_LIMITS);
		const text = buildContext(s, { ...mergeConfig({}), testCommand: "npm test" });
		assert.match(text, /impl_context/);
		assert.match(text, /#3 API/);
		assert.match(text, /npm test/);
		assert.match(text, /impl_plan/);
	});
});
