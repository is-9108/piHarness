import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import {
	type AdrDraft,
	adrFileName,
	adrFileOf,
	adrVars,
	nextAdrNumber,
	supersededNote,
	updateAdrIndex,
	validateAdr,
} from "../extensions/harness/adr.ts";
import { mergeConfig } from "../extensions/harness/config.ts";
import { checkWrite } from "../extensions/harness/guard.ts";
import { artifactPaths, processIO } from "../extensions/harness/handoff.ts";
import {
	applyApproval,
	beginApproval,
	clearHandoff,
	DEFAULT_LIMITS as L,
	type HarnessState,
	initialState,
	recordAdr,
	recordTestRun,
	startImplement,
	startRequirements,
	transition,
	TransitionError,
	withHandoff,
} from "../extensions/harness/state.ts";
import { renderTemplate } from "../extensions/harness/templates.ts";
import { toolsForProcess } from "../extensions/harness/tools.ts";

const template = readFileSync(join(resolve(import.meta.dirname, "../templates"), "adr.md"), "utf8");

const draft: AdrDraft = {
	title: "計測値の保存に SQLite を使う",
	context: "Pi 5 上で 1 分ごとの計測値を 1 年分保存する（FR-003）。",
	decision: "better-sqlite3 で 1 ファイルの SQLite に保存する。",
	options: [
		{ name: "SQLite", pros: ["集計が速い"], cons: ["ネイティブモジュールのビルドが必要"], chosen: true },
		{ name: "CSV を追記", description: "日ごとのファイル", pros: ["依存なし"], cons: ["集計が遅い", "破損しやすい"] },
	],
	positive: ["期間指定の集計が SQL で書ける"],
	negative: ["arm64 でのビルド時間"],
	related: ["#12", "FR-003"],
};

describe("ADR", () => {
	it("番号は既存の最大 + 1。番号の形のファイルだけを数える", () => {
		assert.equal(nextAdrNumber([]), 1);
		assert.equal(nextAdrNumber(["README.md", "0001-a.md", "0007-b.md", "notes.md"]), 8);
		assert.equal(adrFileName(3, "計測値の保存に SQLite を使う"), "0003-計測値の保存に-sqlite-を使う.md");
		assert.equal(adrFileOf(["0001-a.md", "0002-b.md"], 2), "0002-b.md");
	});

	it("選択肢は 2 つ以上・採用はちょうど 1 つ・置き換え対象は存在すること", () => {
		assert.deepEqual(validateAdr(draft, []), []);
		const errs = validateAdr({ ...draft, options: [{ name: "x", chosen: true }], supersedes: 4 }, ["0001-a.md"]);
		assert.equal(errs.length, 2);
		assert.match(errs[0], /2 つ以上/);
		assert.match(errs[1], /ADR-0004 が見つかりません/);
		assert.match(validateAdr({ ...draft, options: draft.options.map((o) => ({ ...o, chosen: true })) }, [])[0], /ちょうど 1 つ/);
	});

	it("テンプレートで固定の形に組み立てる", () => {
		const md = renderTemplate(template, adrVars({ ...draft, supersedes: 1 }, { number: 2, date: "2026-10-09", process: "プラン作成", workItem: "#12 記録", supersededFile: "0001-a.md" }));
		assert.match(md, /^# ADR-0002: 計測値の保存に SQLite を使う\n/);
		assert.deepEqual(
			md.split("\n").filter((l) => l.startsWith("## ")),
			["## 背景・課題", "## 決定", "## 検討した選択肢", "## 結果・影響", "## 見直す条件"],
		);
		assert.match(md, /\| ステータス \| 採用 \|/);
		assert.match(md, /\| 置き換え \| \[ADR-0001\]\(0001-a\.md\) \|/);
		assert.match(md, /### 1\. SQLite（採用）\n- 利点: 集計が速い\n- 欠点: ネイティブモジュールのビルドが必要/);
		assert.match(md, /### 2\. CSV を追記\n\n日ごとのファイル\n\n- 利点: 依存なし\n- 欠点: 集計が遅い \/ 破損しやすい/);
		assert.match(md, /## 見直す条件\n\nなし/);
		assert.doesNotMatch(md, /\{\{|<!--/);
	});

	it("一覧に追記し、置き換えた ADR の行と本文に印を付ける", () => {
		const first = updateAdrIndex(undefined, { number: 1, file: "0001-a.md", title: "A | B", date: "2026-10-01", workItem: "#3 x" });
		assert.match(first, /^# ADR 一覧/);
		assert.match(first, /\| \[ADR-0001\]\(0001-a\.md\) \| A \\\| B \| 採用 \| 2026-10-01 \| #3 x \|\n$/);
		const second = updateAdrIndex(first, { number: 2, file: "0002-b.md", title: "B", date: "2026-10-09" }, 1);
		assert.match(second, /\| \[ADR-0001\]\(0001-a\.md\) \| A \\\| B \| 置き換え済み（ADR-0002） \| 2026-10-01 \|/);
		assert.match(second, /\| \[ADR-0002\]\(0002-b\.md\) \| B \| 採用 \| 2026-10-09 \| - \|\n$/);
		assert.match(supersededNote(2, "0002-b.md", "2026-10-09"), /\[ADR-0002\]\(0002-b\.md\) で置き換えられました/);
	});
});

describe("ADR とフロー", () => {
	const DIR = ".pi/harness/issue-7";
	const P = artifactPaths(DIR);
	const step = (prev: HarnessState, next: HarnessState) => clearHandoff(withHandoff(prev, next));
	const all = () => true;
	const io = { adrIndex: "docs/adr/README.md" };

	function implementing(): HarnessState {
		let s = step(initialState(), startImplement(initialState(), { number: 7, title: "t" }, L, DIR));
		s = step(s, transition(s, "impl_plan"));
		s = recordAdr(s, "docs/adr/0001-a.md", "a");
		s = step(s, beginApproval(s, "plan", [P.plan]));
		return step(s, applyApproval(s, "plan", "approved", "OK", [P.plan]));
	}

	it("判断を伴うプロセスだけが記録でき、作業ごとに一覧を持つ", () => {
		const s = implementing();
		assert.deepEqual(s.artifacts.adrs, ["docs/adr/0001-a.md"]);
		assert.deepEqual(recordAdr(s, "docs/adr/0001-a.md", "a").artifacts.adrs, ["docs/adr/0001-a.md"], "同じものは重複しない");
		const hearing = step(initialState(), startRequirements(initialState(), "t", L, ".pi/harness/req"));
		assert.throws(() => recordAdr(hearing, "docs/adr/0002-b.md", "b"), TransitionError);
	});

	it("後のプロセスは一覧とこの作業の ADR を参照し、フルレビューでは ADR を入力として検証する", () => {
		const s = implementing();
		const impl = processIO(s, all, io)!;
		assert.ok(impl.references.some((r) => r.path === "docs/adr/0001-a.md"));
		assert.ok(impl.references.some((r) => r.path === "docs/adr/README.md"));
		const green = recordTestRun(s, "green", true, "log.txt").state;
		const review = processIO(transition(green, "impl_review"), all, io)!;
		assert.ok(review.inputs.some((r) => r.path === "docs/adr/0001-a.md"));
		assert.ok(review.references.some((r) => r.path === "docs/adr/README.md"));
		assert.ok(!processIO(s, all)!.references.some((r) => r.path === "docs/adr/README.md"), "ADR を使わない設定では一覧を出さない");
	});

	it("フロー中は ADR ディレクトリを直接編集できない（ツールで記録する）", () => {
		const paths = { cwd: "/r", docsDir: "docs", workDir: ".pi/harness", adrDir: "docs/adr" };
		const s = implementing();
		assert.equal(checkWrite(s, "docs/adr/0001-a.md", paths).block, true);
		assert.match(checkWrite(s, "docs/adr/README.md", paths).reason ?? "", /harness_record_decision/);
		assert.equal(checkWrite(s, "src/a.ts", paths).block, false);
		assert.equal(checkWrite(initialState(), "docs/adr/0001-a.md", paths).block, false, "フロー外では止めない");
	});

	it("記録ツールは判断を伴うプロセスだけに出す", () => {
		const registered = ["harness_record_decision", "harness_status"];
		for (const proc of ["requirements", "plan", "implement", "fix", "bugfix"] as const) {
			assert.ok(toolsForProcess([], registered, proc).includes("harness_record_decision"), proc);
		}
		for (const proc of ["hearing", "issues", "review"] as const) {
			assert.ok(!toolsForProcess([], registered, proc).includes("harness_record_decision"), proc);
		}
	});

	it("設定: 既定は有効で <docsDir>/adr。adrDir で変えられる", () => {
		assert.equal(mergeConfig({}).adr, true);
		assert.equal(mergeConfig({}).adrDir, "docs/adr");
		assert.equal(mergeConfig({ docsDir: "documents" }).adrDir, "documents/adr");
		assert.equal(mergeConfig({ adrDir: "decisions" }).adrDir, "decisions");
		const w: string[] = [];
		assert.equal(mergeConfig({ adr: "yes" } as never, w).adr, true);
		assert.equal(w.length, 1);
	});
});
