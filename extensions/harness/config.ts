/**
 * 対象プロジェクトの設定 (.pi/harness.json) の読み込みとテストコマンドの自動検出。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProcessKind, Severity } from "./state.ts";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevelName = (typeof THINKING_LEVELS)[number];

export const PROCESS_KINDS: ProcessKind[] = ["hearing", "requirements", "issues", "plan", "implement", "review", "fix", "bugfix"];

/** プロセスで使うモデル。model は "provider/model-id"（または一意なら "model-id" のみ） */
export interface ProcessModelSetting {
	model?: string;
	thinking?: ThinkingLevelName;
}

export type ModelSettings = Partial<Record<ProcessKind | "default", ProcessModelSetting>>;

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
	/** プロセス完了時に自動で新しいセッションを開始するか（false なら /harness next で手動開始） */
	autoHandoff: boolean;
	/** プロセスごとのモデル・思考レベル（未指定のプロセスは default、それも無ければ Pi の既定モデル） */
	models: ModelSettings;
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
	autoHandoff: true,
	models: {},
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
	if (typeof c.autoHandoff !== "boolean") c.autoHandoff = DEFAULT_CONFIG.autoHandoff;
	c.models = normalizeModels(raw.models as unknown, warnings);
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

/**
 * models 設定を正規化する。値は "provider/model-id" の文字列か { model, thinking }。
 */
export function normalizeModels(raw: unknown, warnings: string[] = []): ModelSettings {
	if (raw === undefined || raw === null) return {};
	if (typeof raw !== "object" || Array.isArray(raw)) {
		warnings.push("models はオブジェクトで指定してください。無視します。");
		return {};
	}
	const out: ModelSettings = {};
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		if (key !== "default" && !PROCESS_KINDS.includes(key as ProcessKind)) {
			warnings.push(`models.${key} は不明なプロセスです（指定可能: default, ${PROCESS_KINDS.join(", ")}）。無視します。`);
			continue;
		}
		const setting: ProcessModelSetting = {};
		if (typeof value === "string") {
			setting.model = value.trim();
		} else if (value && typeof value === "object" && !Array.isArray(value)) {
			const v = value as { model?: unknown; thinking?: unknown };
			if (typeof v.model === "string" && v.model.trim()) setting.model = v.model.trim();
			else if (v.model !== undefined) warnings.push(`models.${key}.model は文字列で指定してください。`);
			if (typeof v.thinking === "string" && (THINKING_LEVELS as readonly string[]).includes(v.thinking)) {
				setting.thinking = v.thinking as ThinkingLevelName;
			} else if (v.thinking !== undefined) {
				warnings.push(`models.${key}.thinking は ${THINKING_LEVELS.join(" / ")} のいずれかで指定してください。`);
			}
		} else {
			warnings.push(`models.${key} は "provider/model-id" か { "model": ..., "thinking": ... } で指定してください。`);
			continue;
		}
		if (setting.model || setting.thinking) out[key as ProcessKind | "default"] = setting;
	}
	return out;
}

/** プロセスに適用する設定（プロセス個別の値を優先し、無い項目は default を使う） */
export function resolveProcessModel(models: ModelSettings, process: ProcessKind): ProcessModelSetting {
	const d = models.default ?? {};
	const p = models[process] ?? {};
	return { model: p.model ?? d.model, thinking: p.thinking ?? d.thinking };
}

/** "provider/model-id" を分解する。"/" を含まない場合は model-id のみ */
export function parseModelRef(ref: string): { provider?: string; id: string } {
	const i = ref.indexOf("/");
	if (i <= 0) return { id: ref };
	return { provider: ref.slice(0, i), id: ref.slice(i + 1) };
}

/** 候補の中からモデル参照に一致するものを探す。model-id のみの指定で複数一致した場合は曖昧としてエラー */
export function findModel<M extends { provider: string; id: string }>(
	ref: string,
	candidates: readonly M[],
): { model?: M; error?: string } {
	const { provider, id } = parseModelRef(ref);
	const hits = candidates.filter((m) => m.id === id && (!provider || m.provider === provider));
	if (hits.length === 1) return { model: hits[0] };
	if (hits.length === 0) return { error: `モデル ${ref} が見つかりません（利用可能なモデルは pi --list-models で確認できます）。` };
	return { error: `モデル ${ref} が複数のプロバイダーに存在します。"provider/model-id" で指定してください（候補: ${hits.map((m) => `${m.provider}/${m.id}`).join(", ")}）。` };
}
