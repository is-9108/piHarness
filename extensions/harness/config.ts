/**
 * 対象プロジェクトの設定 (.pi/harness.json) の読み込みとテストコマンドの自動検出。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Severity } from "./state.ts";

export interface HarnessConfig {
	/** テストスイート全体を実行するシェルコマンド（例: "npm test", "pytest -q"） */
	testCommand?: string;
	/** テスト実行のタイムアウト（秒）。ラズパイでは長めを既定値にしている */
	testTimeoutSec: number;
	/** テスト失敗の修正ループ上限 */
	maxTestLoops: number;
	/** レビューループ上限 */
	maxReviewLoops: number;
	/** ブロッキング（修正必須）とみなす重大度 */
	blockingSeverities: Severity[];
	/** 要件定義書などドキュメントの出力先 */
	docsDir: string;
	/** ハーネスの作業ファイル（プラン・レビュー記録・テストログ）の出力先 */
	workDir: string;
	/** Issue 登録先 (owner/repo)。未指定なら gh がカレントリポジトリから推定 */
	issueRepo?: string;
	/** 登録する全 Issue に付与するラベル */
	issueLabels: string[];
	/** 存在しないラベルを gh label create で作成するか */
	ensureLabels: boolean;
	/** モデルに返すテスト出力の最大行数（全文はログファイルに保存） */
	testOutputLines: number;
}

export const DEFAULT_CONFIG: HarnessConfig = {
	testTimeoutSec: 900,
	maxTestLoops: 3,
	maxReviewLoops: 3,
	blockingSeverities: ["blocker", "major"],
	docsDir: "docs",
	workDir: ".pi/harness",
	issueLabels: [],
	ensureLabels: true,
	testOutputLines: 120,
};

export const CONFIG_PATH = ".pi/harness.json";

export function loadConfig(cwd: string): { config: HarnessConfig; warnings: string[] } {
	const warnings: string[] = [];
	const path = join(cwd, CONFIG_PATH);
	let raw: Partial<HarnessConfig> = {};
	if (existsSync(path)) {
		try {
			raw = JSON.parse(readFileSync(path, "utf8"));
		} catch (e) {
			warnings.push(`${CONFIG_PATH} を読み込めませんでした: ${(e as Error).message}`);
		}
	}
	const config = mergeConfig(raw, warnings);
	if (!config.testCommand) {
		const detected = detectTestCommand(cwd);
		if (detected) config.testCommand = detected;
	}
	return { config, warnings };
}

export function mergeConfig(raw: Partial<HarnessConfig>, warnings: string[] = []): HarnessConfig {
	const c: HarnessConfig = { ...DEFAULT_CONFIG, ...raw };
	for (const key of ["maxTestLoops", "maxReviewLoops", "testTimeoutSec", "testOutputLines"] as const) {
		if (!Number.isInteger(c[key]) || c[key] < 1) {
			warnings.push(`${key} は 1 以上の整数で指定してください。既定値 ${DEFAULT_CONFIG[key]} を使用します。`);
			c[key] = DEFAULT_CONFIG[key];
		}
	}
	const valid: Severity[] = ["blocker", "major", "minor", "nit"];
	if (!Array.isArray(c.blockingSeverities) || !c.blockingSeverities.every((s) => valid.includes(s))) {
		warnings.push(`blockingSeverities が不正です。既定値を使用します。`);
		c.blockingSeverities = DEFAULT_CONFIG.blockingSeverities;
	}
	if (!Array.isArray(c.issueLabels)) c.issueLabels = [];
	return c;
}

/** プロジェクトのファイル構成からテストコマンドを推定する */
export function detectTestCommand(cwd: string): string | undefined {
	const has = (f: string) => existsSync(join(cwd, f));
	if (has("package.json")) {
		try {
			const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
			const test: unknown = pkg?.scripts?.test;
			if (typeof test === "string" && !/no test specified/.test(test)) {
				if (has("pnpm-lock.yaml")) return "pnpm test";
				if (has("yarn.lock")) return "yarn test";
				if (has("bun.lockb") || has("bun.lock")) return "bun test";
				return "npm test";
			}
		} catch {
			// package.json が壊れている場合は他の候補へ
		}
	}
	if (has("Cargo.toml")) return "cargo test";
	if (has("go.mod")) return "go test ./...";
	if (has("pyproject.toml") || has("pytest.ini") || has("setup.cfg") || has("tox.ini")) return "python3 -m pytest -q";
	if (has("Makefile")) {
		try {
			if (/^test:/m.test(readFileSync(join(cwd, "Makefile"), "utf8"))) return "make test";
		} catch {
			// ignore
		}
	}
	return undefined;
}

/** 既存の .pi/harness.json を保ちつつ一部の値を保存する */
export function saveConfigPatch(cwd: string, patch: Partial<HarnessConfig>): void {
	const path = join(cwd, CONFIG_PATH);
	let current: Record<string, unknown> = {};
	if (existsSync(path)) {
		try {
			current = JSON.parse(readFileSync(path, "utf8"));
		} catch {
			current = {};
		}
	}
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`);
}
