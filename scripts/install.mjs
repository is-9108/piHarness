#!/usr/bin/env node
/**
 * piHarness を全プロジェクト共通で使えるように登録し、プロジェクトの設定を用意するスクリプト（何度実行しても同じ結果になる）。
 *
 * 使い方:
 *   git clone https://github.com/is-9108/piHarness.git ~/piHarness   # 1 か所にだけ clone する
 *   cd ~/projects/my-app
 *   node ~/piHarness/scripts/install.mjs
 *
 * オプション:
 *   --project <dir>   設定を用意するプロジェクト（既定: カレントディレクトリ。ホームと piHarness 自身では用意しない）
 *   --global-only     全プロジェクト共通の登録だけを行う
 *   --uninstall       全プロジェクト共通の登録を外す（各プロジェクトの設定・成果物は残す）
 *   --dry-run         変更内容を表示するだけで書き込まない
 *
 * やること:
 *   1. pi install <piHarness> で、ユーザー設定（~/.pi/agent/settings.json）に登録する（全プロジェクト・全 worktree で読み込まれる）
 *   2. プロジェクトの .pi/settings.json に以前の方式（プロジェクトごとの clone）の登録が残っていれば外す（二重に読み込むとツールが衝突するため）
 *   3. <project>/.pi/harness.json が無ければ雛形を作成（テストコマンドは自動検出）
 *   4. <project>/.gitignore に状態ファイル・テストログなどを追加
 *   5. Node.js / pi / gh の有無を確認して表示
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const harnessRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
	const opts = { project: undefined, globalOnly: false, uninstall: false, dryRun: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--project") opts.project = argv[++i];
		else if (a === "--global-only") opts.globalOnly = true;
		else if (a === "--uninstall") opts.uninstall = true;
		else if (a === "--dry-run") opts.dryRun = true;
		else if (a === "-h" || a === "--help") opts.help = true;
		else throw new Error(`不明な引数: ${a}`);
	}
	return opts;
}

/** pi CLI を実行する（テストでは差し替える） */
export function runPi(args) {
	try {
		const out = execFileSync("pi", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		return { code: 0, out };
	} catch (e) {
		return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` || e.message };
	}
}

/** ディレクトリが piHarness のパッケージか（package.json の name で判定） */
export function isPiHarnessPackage(dir) {
	const file = join(dir, "package.json");
	if (!existsSync(file)) return false;
	try {
		return JSON.parse(readFileSync(file, "utf8")).name === "pi-harness";
	} catch {
		return false;
	}
}

/**
 * プロジェクトの .pi/settings.json から、piHarness を指すローカルパスの登録を外す。
 * 全プロジェクト共通の登録と別の場所の piHarness を二重に読み込むと、ツール名が衝突して動かなくなるため。
 */
export function removeLocalRegistrations(settings, project, isHarness = isPiHarnessPackage) {
	const packages = Array.isArray(settings.packages) ? settings.packages : [];
	const removed = [];
	const kept = packages.filter((p) => {
		const source = typeof p === "string" ? p : p?.source;
		if (typeof source !== "string" || /^(npm|git|https?|ssh):/.test(source)) return true;
		const abs = isAbsolute(source) ? source : resolve(project, ".pi", source);
		if (!isHarness(abs)) return true;
		removed.push(source);
		return false;
	});
	return { settings: removed.length ? { ...settings, packages: kept } : settings, removed };
}

/** .gitignore に足りない行だけを追記した内容を返す */
export function updateGitignore(current, lines) {
	const have = new Set(current.split(/\r?\n/).map((l) => l.trim()));
	const missing = lines.filter((l) => !have.has(l));
	if (missing.length === 0) return { content: current, added: [] };
	const prefix = current && !current.endsWith("\n") ? "\n" : "";
	const block = `${prefix}${current ? "\n" : ""}# piHarness\n${missing.join("\n")}\n`;
	return { content: current + block, added: missing };
}

/** package.json の lint・型チェック系スクリプトを checkCommands の候補にする */
export function detectCheckCommands(project) {
	const file = join(project, "package.json");
	if (!existsSync(file)) return [];
	let scripts;
	try {
		scripts = JSON.parse(readFileSync(file, "utf8")).scripts ?? {};
	} catch {
		return [];
	}
	const runner = existsSync(join(project, "pnpm-lock.yaml")) ? "pnpm" : existsSync(join(project, "yarn.lock")) ? "yarn" : "npm run";
	return ["lint", "typecheck", "type-check", "check-types", "tsc"].filter((name) => typeof scripts[name] === "string").map((name) => `${runner} ${name}`);
}

function readJson(file, fallback) {
	if (!existsSync(file)) return fallback;
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch (e) {
		throw new Error(`${file} を JSON として読み込めません: ${e.message}`);
	}
}

function versionOf(cmd, args = ["--version"]) {
	try {
		return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n")[0];
	} catch {
		return undefined;
	}
}

function checkEnvironment() {
	const lines = [];
	const [major, minor] = process.versions.node.split(".").map(Number);
	const nodeOk = major > 22 || (major === 22 && minor >= 19);
	lines.push(`${nodeOk ? "✓" : "✗"} Node.js ${process.versions.node}${nodeOk ? "" : "（22.19 以上が必要です）"}`);
	const gh = versionOf("gh");
	const ghAuth = gh ? versionOf("gh", ["auth", "status"]) !== undefined : false;
	lines.push(
		!gh
			? "△ gh が見つかりません（Issue は docs/issues/ に Markdown で保存されます）: sudo apt install gh"
			: ghAuth
				? `✓ ${gh}`
				: `△ ${gh}（未ログイン: gh auth login を実行すると Issue を GitHub に登録できます）`,
	);
	return lines;
}

/** 全プロジェクト共通の登録（pi install / pi remove）。pi が無ければ例外 */
function registerGlobal(root, { uninstall, dryRun, pi, log }) {
	const version = pi(["--version"]);
	if (version.code !== 0) {
		throw new Error("pi が見つかりません。先に pi-coding-agent をインストールしてください: npm install -g @earendil-works/pi-coding-agent");
	}
	if (dryRun) {
		log(`- （--dry-run）pi ${uninstall ? "remove" : "install"} ${root} を実行します`);
		return;
	}
	const r = pi([uninstall ? "remove" : "install", root]);
	if (r.code !== 0) throw new Error(`pi ${uninstall ? "remove" : "install"} に失敗しました: ${r.out.trim()}`);
	log(uninstall ? `✓ 全プロジェクト共通の登録を外しました（pi remove ${root}）` : `✓ 全プロジェクト共通で登録しました（pi install ${root}。登録済みなら変わりません）`);
}

/** 設定を用意しないディレクトリ（ホーム・piHarness 自身） */
function isProjectDir(project, root) {
	const p = resolve(project);
	return p !== resolve(root) && p !== resolve(homedir()) && p !== "/";
}

export function install({ project, globalOnly = false, uninstall = false, dryRun = false, root = harnessRoot, log = console.log, pi = runPi }) {
	registerGlobal(root, { uninstall, dryRun, pi, log });
	if (uninstall) {
		log("\n各プロジェクトの .pi/harness.json・成果物（.pi/harness/）は残しています。不要なら手動で削除してください。");
		return { project: undefined };
	}
	project = resolve(project ?? process.cwd());
	if (globalOnly || !isProjectDir(project, root)) {
		log(`\nプロジェクトの設定は用意していません。プロジェクトのルートで node ${join(root, "scripts/install.mjs")} を実行すると用意します。`);
		return { project: undefined };
	}
	if (!existsSync(project)) throw new Error(`プロジェクトが見つかりません: ${project}`);
	const write = (file, content) => {
		if (dryRun) return;
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, content);
	};
	const results = [];

	// 1. 以前の方式（プロジェクトごとの登録）を外す
	const settingsFile = join(project, ".pi", "settings.json");
	if (existsSync(settingsFile)) {
		const { settings, removed } = removeLocalRegistrations(readJson(settingsFile, {}), project);
		if (removed.length) {
			write(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
			results.push(`✓ .pi/settings.json からプロジェクトごとの登録を外しました: ${removed.join(", ")}（全プロジェクト共通の登録と衝突するため）`);
		}
	}
	const oldClone = join(project, ".pi", "piHarness");
	if (existsSync(oldClone) && resolve(oldClone) !== resolve(root) && isPiHarnessPackage(oldClone)) {
		results.push(`△ 以前の方式の clone が残っています。もう使わないので削除できます: rm -rf ${relative(process.cwd(), oldClone) || oldClone}`);
	}

	// 2. .pi/harness.json
	const configFile = join(project, ".pi", "harness.json");
	if (existsSync(configFile)) {
		results.push("- .pi/harness.json は既にあります（変更しません）");
	} else {
		const template = JSON.parse(readFileSync(join(root, "templates", "harness.json"), "utf8"));
		const checks = detectCheckCommands(project);
		if (checks.length) template.checkCommands = checks;
		write(configFile, `${JSON.stringify(template, null, 2)}\n`);
		results.push(
			`✓ .pi/harness.json を作成しました（テストコマンドは未指定なら自動検出されます${checks.length ? `。checkCommands: ${checks.join(", ")}` : ""}）`,
		);
	}

	// 3. .gitignore
	const ignoreFile = join(project, ".gitignore");
	const lines = [".pi/harness/state.json", ".pi/harness/provider-status.json", ".pi/harness/**/logs/", ".pi/harness/**/test-lock/"];
	const current = existsSync(ignoreFile) ? readFileSync(ignoreFile, "utf8") : "";
	const { content, added } = updateGitignore(current, lines);
	if (added.length) write(ignoreFile, content);
	results.push(added.length ? `✓ .gitignore に追加しました: ${added.join(", ")}` : "- .gitignore は設定済みです");

	for (const r of results) log(r);
	log("");
	for (const r of checkEnvironment()) log(r);
	log(`
次のステップ:
  1. プロジェクトのルートで pi を起動してください（worktree でも同じ piHarness が読み込まれます）
  2. /harness config で設定、/harness models でプロセスごとのモデルを確認
  3. やりたいことを話しかけて開始（/req・/impl・/bugfix・/doc でも可）

piHarness の更新（全プロジェクトに反映）: git -C ${root.split(sep).join("/")} pull`);
	if (dryRun) log("\n（--dry-run のため何も書き込んでいません）");
	return { project };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	try {
		const opts = parseArgs(process.argv.slice(2));
		if (opts.help) {
			console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0].replace(/^#!.*\n\/\*\*?/, "").replace(/^ \* ?/gm, ""));
		} else {
			install(opts);
		}
	} catch (e) {
		console.error(`エラー: ${e.message}`);
		process.exit(1);
	}
}
