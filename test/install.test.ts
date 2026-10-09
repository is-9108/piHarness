import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
// @ts-expect-error プレーンな .mjs（型定義なし）
import { defaultProject, detectCheckCommands, install, packageRef, updateGitignore, updateSettings } from "../scripts/install.mjs";

const repo = resolve(import.meta.dirname, "..");

/** プロジェクト内に piHarness を clone した状態を作る（node_modules・.git は含めない＝実際の clone と同じ） */
function projectWithClone(at = ".pi/piHarness"): { project: string; clone: string } {
	const project = mkdtempSync(join(tmpdir(), "pih-proj-"));
	const clone = join(project, at);
	cpSync(repo, clone, {
		recursive: true,
		filter: (src) => !/[/\\](node_modules|\.git)([/\\]|$)/.test(src.slice(repo.length)),
	});
	return { project, clone };
}

const quiet = () => {};

describe("install スクリプト", () => {
	it("clone 先の位置からプロジェクトと相対パスを決める", () => {
		assert.equal(defaultProject("/p/app/.pi/piHarness", "/elsewhere"), "/p/app");
		assert.equal(defaultProject("/opt/piHarness", "/p/app"), "/p/app");
		assert.equal(packageRef("/p/app", "/p/app/.pi/piHarness"), "./piHarness");
		assert.equal(packageRef("/p/app", "/p/app/tools/piHarness"), "../tools/piHarness");
		assert.equal(packageRef("/p/app", "/home/pi/piHarness"), "../../../home/pi/piHarness");
	});

	it("settings.json の既存設定を保ち、重複登録しない", () => {
		const base = { theme: "dark", packages: ["npm:@x/tools", { source: "./piHarness", skills: [] }] };
		assert.equal(updateSettings(base, "./piHarness", "/p").changed, false, "オブジェクト形式の同じ登録も検出");
		const r = updateSettings({ theme: "dark", packages: ["npm:@x/tools"] }, "./piHarness", "/p");
		assert.deepEqual(r.settings, { theme: "dark", packages: ["npm:@x/tools", "./piHarness"] });
		const u = updateSettings(r.settings, "./piHarness", "/p", true);
		assert.deepEqual(u.settings.packages, ["npm:@x/tools"]);
	});

	it(".gitignore は足りない行だけ追記する", () => {
		const r = updateGitignore("node_modules/\n.pi/harness/state.json\n", [".pi/harness/state.json", ".pi/piHarness/"]);
		assert.deepEqual(r.added, [".pi/piHarness/"]);
		assert.equal(r.content, "node_modules/\n.pi/harness/state.json\n\n# piHarness\n.pi/piHarness/\n");
		assert.deepEqual(updateGitignore(r.content, [".pi/piHarness/"]).added, []);
	});

	it("CLI: .pi/piHarness に clone したプロジェクトを設定し、再実行しても変わらない", () => {
		const { project, clone } = projectWithClone();
		mkdirSync(join(project, ".pi"), { recursive: true });
		writeFileSync(join(project, ".pi/settings.json"), JSON.stringify({ packages: ["npm:@x/tools"] }));
		writeFileSync(join(project, ".gitignore"), "node_modules/\n");
		execFileSync("node", [join(clone, "scripts/install.mjs")], { cwd: "/", stdio: "pipe" });

		const settings = JSON.parse(readFileSync(join(project, ".pi/settings.json"), "utf8"));
		assert.deepEqual(settings.packages, ["npm:@x/tools", "./piHarness"]);
		assert.ok(existsSync(join(project, ".pi/harness.json")));
		const ignore = readFileSync(join(project, ".gitignore"), "utf8");
		assert.match(ignore, /^\.pi\/harness\/state\.json$/m);
		assert.match(ignore, /^\.pi\/harness\/\*\*\/test-lock\/$/m);
		assert.match(ignore, /^\.pi\/harness\/provider-status\.json$/m);
		assert.match(ignore, /^\.pi\/piHarness\/$/m);

		const snapshot = [readFileSync(join(project, ".pi/settings.json"), "utf8"), ignore];
		execFileSync("node", [join(clone, "scripts/install.mjs")], { stdio: "pipe" });
		assert.deepEqual([readFileSync(join(project, ".pi/settings.json"), "utf8"), readFileSync(join(project, ".gitignore"), "utf8")], snapshot);
	});

	it("既存の harness.json は上書きしない。サブモジュールなら clone 先を .gitignore に入れない", () => {
		const { project, clone } = projectWithClone();
		writeFileSync(join(project, ".pi/harness.json"), '{"testCommand":"make check"}');
		writeFileSync(join(project, ".gitmodules"), '[submodule ".pi/piHarness"]\n\tpath = .pi/piHarness\n\turl = https://github.com/is-9108/piHarness.git\n');
		install({ project, root: clone, log: quiet });
		assert.equal(readFileSync(join(project, ".pi/harness.json"), "utf8"), '{"testCommand":"make check"}');
		assert.doesNotMatch(readFileSync(join(project, ".gitignore"), "utf8"), /piHarness\//);
	});

	it("--uninstall で登録だけを外す", () => {
		const { project, clone } = projectWithClone();
		install({ project, root: clone, log: quiet });
		install({ project, root: clone, uninstall: true, log: quiet });
		assert.deepEqual(JSON.parse(readFileSync(join(project, ".pi/settings.json"), "utf8")).packages, []);
		assert.ok(existsSync(join(project, ".pi/harness.json")));
	});

	it("package.json の lint・型チェックを checkCommands に入れる", () => {
		const { project, clone } = projectWithClone();
		writeFileSync(join(project, "package.json"), JSON.stringify({ scripts: { test: "vitest", lint: "eslint .", typecheck: "tsc --noEmit", build: "tsc" } }));
		assert.deepEqual(detectCheckCommands(project), ["npm run lint", "npm run typecheck"]);
		install({ project, root: clone, log: quiet });
		const cfg = JSON.parse(readFileSync(join(project, ".pi/harness.json"), "utf8"));
		assert.deepEqual(cfg.checkCommands, ["npm run lint", "npm run typecheck"]);
		assert.equal(cfg.git.pr, "ask");
	});

	it("--dry-run では何も書き込まない", () => {
		const { project, clone } = projectWithClone();
		install({ project, root: clone, dryRun: true, log: quiet });
		assert.ok(!existsSync(join(project, ".pi/settings.json")));
		assert.ok(!existsSync(join(project, ".gitignore")));
	});

	it("組み込んだプロジェクトで Pi が拡張とスキルを読み込める（clone 側に node_modules が無くても動く）", async () => {
		const { project, clone } = projectWithClone();
		install({ project, root: clone, log: quiet });
		const { DefaultResourceLoader, SettingsManager } = await import("@earendil-works/pi-coding-agent");
		const agentDir = mkdtempSync(join(tmpdir(), "pih-agent-"));
		const loader = new DefaultResourceLoader({
			cwd: project,
			agentDir,
			settingsManager: SettingsManager.create(project, agentDir),
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
			[join(clone, "extensions/harness/index.ts")],
		);
	});
});
