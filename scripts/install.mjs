#!/usr/bin/env node
/**
 * piHarness をプロジェクトに組み込むセットアップスクリプト（何度実行しても同じ結果になる）。
 *
 * 使い方（プロジェクトのルートで）:
 *   git clone https://github.com/is-9108/piHarness.git .pi/piHarness
 *   node .pi/piHarness/scripts/install.mjs
 *
 * オプション:
 *   --project <dir>   組み込み先のプロジェクト（既定: clone 先が <dir>/.pi/piHarness なら <dir>、それ以外はカレントディレクトリ）
 *   --uninstall       .pi/settings.json から piHarness の登録を外す（成果物・設定ファイルは残す）
 *   --dry-run         変更内容を表示するだけで書き込まない
 *
 * やること:
 *   1. <project>/.pi/settings.json の packages に clone 先への相対パスを追加（既存の設定は保持）
 *   2. <project>/.pi/harness.json が無ければ雛形を作成（テストコマンドは自動検出）
 *   3. <project>/.gitignore に状態ファイル・テストログ・（サブモジュールでなければ）clone 先を追加
 *   4. Node.js / pi / gh の有無を確認して表示
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const harnessRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
	const opts = { project: undefined, uninstall: false, dryRun: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--project") opts.project = argv[++i];
		else if (a === "--uninstall") opts.uninstall = true;
		else if (a === "--dry-run") opts.dryRun = true;
		else if (a === "-h" || a === "--help") opts.help = true;
		else throw new Error(`不明な引数: ${a}`);
	}
	return opts;
}

/** clone 先が <project>/.pi/<name> ならその <project>、そうでなければカレントディレクトリ */
export function defaultProject(root = harnessRoot, cwd = process.cwd()) {
	const parent = dirname(root);
	if (basename(parent) === ".pi") return dirname(parent);
	return cwd;
}

/** .pi/settings.json から見た piHarness への相対パス（Pi は settings ファイルの場所を基準に解決する） */
export function packageRef(project, root = harnessRoot) {
	const rel = relative(join(project, ".pi"), root).split(sep).join("/");
	if (!rel) return ".";
	return rel.startsWith(".") ? rel : `./${rel}`;
}

function samePackage(entry, ref, project) {
	const source = typeof entry === "string" ? entry : entry?.source;
	if (typeof source !== "string") return false;
	if (/^(npm|git|https?):/.test(source)) return false;
	const abs = isAbsolute(source) ? source : resolve(project, ".pi", source);
	return abs === resolve(project, ".pi", ref);
}

/** settings.json に piHarness を登録（または削除）した結果を返す */
export function updateSettings(settings, ref, project, uninstall = false) {
	const next = { ...settings };
	const packages = Array.isArray(next.packages) ? [...next.packages] : [];
	const exists = packages.some((p) => samePackage(p, ref, project));
	if (uninstall) {
		next.packages = packages.filter((p) => !samePackage(p, ref, project));
		return { settings: next, changed: exists };
	}
	if (exists) return { settings: next, changed: false };
	next.packages = [...packages, ref];
	return { settings: next, changed: true };
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

/** clone 先が .gitmodules に登録されたサブモジュールか */
export function isSubmodule(project, root = harnessRoot) {
	const file = join(project, ".gitmodules");
	if (!existsSync(file)) return false;
	const rel = relative(project, root).split(sep).join("/");
	return readFileSync(file, "utf8")
		.split(/\r?\n/)
		.some((l) => l.trim().replace(/^path\s*=\s*/, "") === rel && /^\s*path\s*=/.test(l));
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
	const pi = versionOf("pi");
	lines.push(pi ? `✓ pi ${pi}` : "✗ pi が見つかりません: npm install -g @earendil-works/pi-coding-agent");
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

export function install({ project, uninstall = false, dryRun = false, root = harnessRoot, log = console.log }) {
	project = resolve(project ?? defaultProject(root));
	if (resolve(project) === resolve(root)) {
		log("piHarness 自身のリポジトリです（.pi/settings.json で既に読み込まれます）。組み込み先のプロジェクトで実行してください。");
		return { changed: false };
	}
	if (!existsSync(project)) throw new Error(`プロジェクトが見つかりません: ${project}`);
	const write = (file, content) => {
		if (dryRun) return;
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, content);
	};
	const ref = packageRef(project, root);
	const results = [];

	// 1. .pi/settings.json
	const settingsFile = join(project, ".pi", "settings.json");
	const { settings, changed } = updateSettings(readJson(settingsFile, {}), ref, project, uninstall);
	if (changed) write(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
	results.push(
		uninstall
			? changed
				? `✓ .pi/settings.json から "${ref}" を削除しました`
				: `- .pi/settings.json に "${ref}" は登録されていません`
			: changed
				? `✓ .pi/settings.json の packages に "${ref}" を追加しました`
				: `- .pi/settings.json には登録済みです（"${ref}"）`,
	);
	if (uninstall) {
		results.forEach((r) => log(r));
		log("\n.pi/harness.json・成果物（.pi/harness/）・clone 先は残しています。不要なら手動で削除してください。");
		return { changed };
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
	const lines = [".pi/harness/state.json", ".pi/harness/**/logs/"];
	const cloneRel = relative(project, root).split(sep).join("/");
	const inside = !cloneRel.startsWith("..") && !isAbsolute(cloneRel);
	if (inside && !isSubmodule(project, root)) lines.push(`${cloneRel}/`);
	const current = existsSync(ignoreFile) ? readFileSync(ignoreFile, "utf8") : "";
	const { content, added } = updateGitignore(current, lines);
	if (added.length) write(ignoreFile, content);
	results.push(added.length ? `✓ .gitignore に追加しました: ${added.join(", ")}` : "- .gitignore は設定済みです");

	for (const r of results) log(r);
	log("");
	for (const r of checkEnvironment()) log(r);
	log(`
次のステップ:
  1. プロジェクトのルートで pi を起動し、プロジェクトを信頼（trust）してください（.pi/settings.json の読み込みに必要）
  2. /harness config で設定、/harness models でプロセスごとのモデルを確認
  3. /req <テーマ> で要件定義、/impl <Issue番号> で実装を開始

piHarness の更新: git -C ${inside ? cloneRel : root} pull`);
	if (dryRun) log("\n（--dry-run のため何も書き込んでいません）");
	return { changed: true };
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
