import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
// @ts-expect-error プレーンな .mjs（型定義なし）
import { detectCheckCommands, install, isPiHarnessPackage, removeLocalRegistrations, updateGitignore } from "../scripts/install.mjs";

const repo = resolve(import.meta.dirname, "..");

/** 1 か所に clone した piHarness（node_modules・.git は含めない＝実際の clone と同じ） */
function cloneHarness(at = join(mkdtempSync(join(tmpdir(), "pih-home-")), "piHarness")): string {
	cpSync(repo, at, {
		recursive: true,
		filter: (src) => !/[/\\](node_modules|\.git)([/\\]|$)/.test(src.slice(repo.length)),
	});
	return at;
}

const project = () => mkdtempSync(join(tmpdir(), "pih-proj-"));

/** pi CLI の代わり。呼ばれた引数を記録する */
function fakePi(available = true) {
	const calls: string[][] = [];
	const pi = (args: string[]) => {
		calls.push(args);
		return available ? { code: 0, out: "" } : { code: 127, out: "not found" };
	};
	return { pi, calls };
}

const quiet = () => {};

describe("install スクリプト（全プロジェクト共通）", () => {
	it("pi install で全プロジェクト共通に登録し、プロジェクトの設定と .gitignore を用意する", () => {
		const root = cloneHarness();
		const dir = project();
		writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
		const { pi, calls } = fakePi();
		install({ project: dir, root, pi, log: quiet });
		assert.deepEqual(calls, [["--version"], ["install", root]]);
		assert.ok(!existsSync(join(dir, ".pi/settings.json")), "プロジェクトには登録しない");
		assert.ok(existsSync(join(dir, ".pi/harness.json")));
		const ignore = readFileSync(join(dir, ".gitignore"), "utf8");
		assert.match(ignore, /^\.pi\/harness\/state\.json$/m);
		assert.match(ignore, /^\.pi\/harness\/\*\*\/test-lock\/$/m);
		assert.doesNotMatch(ignore, /piHarness\//, "clone 先はプロジェクトの外なので .gitignore に入れない");

		const snapshot = [readFileSync(join(dir, ".pi/harness.json"), "utf8"), ignore];
		install({ project: dir, root, pi, log: quiet });
		assert.deepEqual([readFileSync(join(dir, ".pi/harness.json"), "utf8"), readFileSync(join(dir, ".gitignore"), "utf8")], snapshot, "再実行しても変わらない");
	});

	it("以前の方式（プロジェクトごとの clone の登録）を外す。他のパッケージ・設定は残す", () => {
		const root = cloneHarness();
		const dir = project();
		cloneHarness(join(dir, ".pi/piHarness"));
		writeFileSync(join(dir, ".pi/settings.json"), JSON.stringify({ theme: "dark", packages: ["npm:@x/tools", { source: "./piHarness", skills: [] }] }));
		const logs: string[] = [];
		install({ project: dir, root, pi: fakePi().pi, log: (l: string) => logs.push(l) });
		assert.deepEqual(JSON.parse(readFileSync(join(dir, ".pi/settings.json"), "utf8")), { theme: "dark", packages: ["npm:@x/tools"] });
		assert.ok(logs.some((l) => /プロジェクトごとの登録を外しました: \.\/piHarness/.test(l)));
		assert.ok(logs.some((l) => /以前の方式の clone が残っています/.test(l)));
	});

	it("piHarness 以外のローカルパッケージは外さない", () => {
		const other = mkdtempSync(join(tmpdir(), "pih-other-"));
		writeFileSync(join(other, "package.json"), JSON.stringify({ name: "my-tools" }));
		const { settings, removed } = removeLocalRegistrations({ packages: [other, "./missing"] }, "/p");
		assert.deepEqual(removed, []);
		assert.deepEqual(settings.packages, [other, "./missing"]);
		assert.equal(isPiHarnessPackage(repo), true);
	});

	it("ホーム・piHarness 自身・--global-only ではプロジェクトの設定を作らない", () => {
		const root = cloneHarness();
		const self: string[] = [];
		install({ project: root, root, pi: fakePi().pi, log: (l: string) => self.push(l) });
		assert.ok(self.some((l) => /プロジェクトの設定は用意していません/.test(l)), "piHarness 自身には用意しない");
		const dir = project();
		install({ project: dir, root, globalOnly: true, pi: fakePi().pi, log: quiet });
		assert.ok(!existsSync(join(dir, ".pi")));
		const logs: string[] = [];
		install({ project: homedir(), root, dryRun: true, pi: fakePi().pi, log: (l: string) => logs.push(l) });
		assert.ok(logs.some((l) => /プロジェクトの設定は用意していません/.test(l)));
	});

	it("--uninstall は全プロジェクト共通の登録だけを外す", () => {
		const root = cloneHarness();
		const dir = project();
		install({ project: dir, root, pi: fakePi().pi, log: quiet });
		const { pi, calls } = fakePi();
		install({ project: dir, root, uninstall: true, pi, log: quiet });
		assert.deepEqual(calls.at(-1), ["remove", root]);
		assert.ok(existsSync(join(dir, ".pi/harness.json")), "プロジェクトの設定は残す");
	});

	it("pi が無ければ何もせずに止める", () => {
		const dir = project();
		assert.throws(() => install({ project: dir, root: repo, pi: fakePi(false).pi, log: quiet }), /pi が見つかりません/);
		assert.ok(!existsSync(join(dir, ".pi")));
	});

	it("--dry-run では pi も実行せず、何も書き込まない", () => {
		const dir = project();
		const { pi, calls } = fakePi();
		install({ project: dir, root: cloneHarness(), dryRun: true, pi, log: quiet });
		assert.deepEqual(calls, [["--version"]]);
		assert.ok(!existsSync(join(dir, ".pi")));
		assert.ok(!existsSync(join(dir, ".gitignore")));
	});

	it(".gitignore は足りない行だけ追記する", () => {
		const r = updateGitignore("node_modules/\n.pi/harness/state.json\n", [".pi/harness/state.json", ".pi/harness/**/logs/"]);
		assert.deepEqual(r.added, [".pi/harness/**/logs/"]);
		assert.equal(r.content, "node_modules/\n.pi/harness/state.json\n\n# piHarness\n.pi/harness/**/logs/\n");
	});

	it("package.json の lint・型チェックを checkCommands に入れる", () => {
		const dir = project();
		writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest", lint: "eslint .", typecheck: "tsc --noEmit", build: "tsc" } }));
		assert.deepEqual(detectCheckCommands(dir), ["npm run lint", "npm run typecheck"]);
		install({ project: dir, root: cloneHarness(), pi: fakePi().pi, log: quiet });
		const cfg = JSON.parse(readFileSync(join(dir, ".pi/harness.json"), "utf8"));
		assert.deepEqual(cfg.checkCommands, ["npm run lint", "npm run typecheck"]);
		assert.equal(cfg.git.pr, "ask");
	});

	it("ユーザー設定に登録すれば、どのプロジェクト（worktree）でも Pi が拡張とスキルを読み込める（clone 側に node_modules が無くても動く）", async () => {
		const root = cloneHarness();
		const dir = project();
		mkdirSync(join(dir, ".pi"));
		const { DefaultResourceLoader, SettingsManager } = await import("@earendil-works/pi-coding-agent");
		const agentDir = mkdtempSync(join(tmpdir(), "pih-agent-"));
		// pi install <root> が書き込むのと同じユーザー設定
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [root] }));
		const loader = new DefaultResourceLoader({
			cwd: dir,
			agentDir,
			settingsManager: SettingsManager.create(dir, agentDir),
			projectTrusted: true,
		} as never);
		await loader.reload();
		assert.deepEqual(
			loader.getSkills().skills.map((s) => s.name).sort(),
			["harness-bugfix", "harness-doc-fix", "harness-doc-plan", "harness-doc-review", "harness-doc-write", "harness-fix", "harness-hearing", "harness-issues", "harness-plan", "harness-requirements", "harness-review", "harness-review-light", "harness-tdd"],
		);
		const ext = loader.getExtensions();
		assert.deepEqual(ext.errors, []);
		assert.deepEqual(
			ext.extensions.map((e: { path?: string; resolvedPath?: string }) => e.resolvedPath ?? e.path),
			[join(root, "extensions/harness/index.ts")],
		);
	});
});
