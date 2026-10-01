/**
 * 対象プロジェクトの設定 (.pi/harness.json) の読み込みとテストコマンドの自動検出。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProcessKind, Severity } from "./state.ts";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevelName = (typeof THINKING_LEVELS)[number];

export const PROCESS_KINDS: ProcessKind[] = ["hearing", "requirements", "issues", "plan", "implement", "review", "fix", "bugfix"];

/** レビューのフル（1 周目）/ 軽量（2 周目以降）だけ別に指定するためのキー */
export const REVIEW_VARIANTS = ["review_full", "review_light"] as const;
export type ReviewVariant = (typeof REVIEW_VARIANTS)[number];
export type ModelKey = ProcessKind | ReviewVariant | "default";
export const MODEL_KEYS: ModelKey[] = ["default", ...PROCESS_KINDS, ...REVIEW_VARIANTS];

/**
 * プロセスで使うモデル。model は "provider/model-id"（または一意なら "model-id" のみ）の候補リスト。
 * 先頭から順に、見つかって認証が設定されている最初のモデルを使う（フォールバック）。
 */
export interface ProcessModelSetting {
	model?: string[];
	thinking?: ThinkingLevelName;
}

export type ModelSettings = Partial<Record<ModelKey, ProcessModelSetting>>;

export interface GitSettings {
	/** Git 連携を使うか（git リポジトリでない場合は自動的に無効） */
	enabled: boolean;
	/** 作業ブランチ名の接頭辞 */
	branchPrefix: string;
	/** 作業ブランチの作成元（= PR のマージ先）。未指定なら現在のブランチ。ただし別の作業ブランチ上なら既定ブランチ */
	baseBranch?: string;
	/** 実装完了時に変更をコミットするか */
	commit: boolean;
	/** 成果物（workDir 配下の md）もコミットに含めるか */
	commitArtifacts: boolean;
	/** PR の作成: ask = 確認してから作成 / auto = 確認なしで作成 / off = 作成しない */
	pr: "ask" | "auto" | "off";
	/** ドラフト PR として作成するか */
	draft: boolean;
	/** 未コミットの変更がある状態で /impl を開始するときの扱い: ask = 確認 / allow = そのまま / refuse = 中止 */
	dirtyStart: "ask" | "allow" | "refuse";
	/** 実装開始前に開始元ブランチ（main など）を origin から pull する */
	pullBase: boolean;
}

export interface HarnessConfig {
	/** テストスイート全体を実行するシェルコマンド（例: "npm test", "pytest -q"） */
	testCommand?: string;
	/** テストと一緒に実行して合格を必須にするチェック（lint・型チェックなど）。green 判定のときだけ実行する */
	checkCommands: string[];
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
	/** Git 連携（作業ブランチ・差分の基準・完了時のコミットと PR） */
	git: GitSettings;
	/** テストを弱める変更（テスト削除・スキップ追加・アサーション減少）を検知して理由の記録を求めるか */
	testIntegrity: boolean;
	/** 同じ失敗（失敗の指紋が同じ）がこの回数続いたら、maxTestLoops を待たずにエスカレーションする。0 で無効 */
	sameFailureLimit: number;
	/** green 期待で失敗したコマンドを再実行する回数。再実行で合格したものは flaky として記録し、ループ回数に数えない。0 で無効 */
	flakyRetries: number;
	/** 実装開始時点でテストとチェックを実行し、もともと失敗しているものを判定から除外する */
	baseline: boolean;
	/** Red で失敗を確かめたテストを Green の合格までロックし、レビュー以降はレビュー時点のテストをロックする */
	testLock: boolean;
	/** プロバイダーの利用上限で止まったとき、models の次の候補に切り替えて同じセッションで再開する */
	fallback: FallbackSettings;
	/** しきい値による自動圧縮 */
	compaction: { enabled: boolean; thresholdPercent: number };
	/** TUI の入力欄の上にダッシュボード（工程・いまの作業・ブランチ・トークン等）を表示するか */
	dashboard: boolean;
	/** Issue・プランの大きさの上限（1 セッションで扱える大きさに保つ） */
	issueLimits: { maxAcceptanceCriteria: number; allowedSizes: IssueSize[]; maxPlanTestCases: number };
}

export type IssueSize = "S" | "M" | "L";

export interface FallbackSettings {
	enabled: boolean;
	/** 利用枠・課金の上限のとき、解除の時刻が分からなければこの時間（分）だけそのプロバイダーを避ける */
	quotaCooldownMinutes: number;
	/** 一時的な混雑・レート制限（pi の再試行でも回復しなかったもの）のときに避ける時間（分） */
	transientCooldownMinutes: number;
}

export const DEFAULT_FALLBACK: FallbackSettings = { enabled: true, quotaCooldownMinutes: 60, transientCooldownMinutes: 10 };

export const DEFAULT_GIT: GitSettings = {
	enabled: true,
	branchPrefix: "issue-",
	commit: true,
	commitArtifacts: false,
	pr: "ask",
	draft: false,
	dirtyStart: "ask",
	pullBase: true,
};

export const DEFAULT_CONFIG: HarnessConfig = {
	checkCommands: [],
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
	git: DEFAULT_GIT,
	testIntegrity: true,
	sameFailureLimit: 2,
	flakyRetries: 1,
	baseline: true,
	testLock: true,
	fallback: DEFAULT_FALLBACK,
	compaction: { enabled: true, thresholdPercent: 60 },
	dashboard: true,
	issueLimits: { maxAcceptanceCriteria: 5, allowedSizes: ["S", "M"], maxPlanTestCases: 12 },
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
	if (!Array.isArray(c.checkCommands) || !c.checkCommands.every((x) => typeof x === "string" && x.trim())) {
		if (raw.checkCommands !== undefined) warnings.push("checkCommands はコマンド文字列の配列で指定してください。無視します。");
		c.checkCommands = [];
	}
	c.git = normalizeGit(raw.git as unknown, warnings);
	if (typeof c.testIntegrity !== "boolean") c.testIntegrity = DEFAULT_CONFIG.testIntegrity;
	for (const key of ["baseline", "testLock"] as const) {
		if (typeof c[key] !== "boolean") {
			if (raw[key] !== undefined) warnings.push(`${key} は true / false で指定してください。既定値を使用します。`);
			c[key] = DEFAULT_CONFIG[key];
		}
	}
	if (!Number.isInteger(c.sameFailureLimit) || c.sameFailureLimit < 0 || c.sameFailureLimit === 1) {
		warnings.push(`sameFailureLimit は 0（無効）または 2 以上の整数で指定してください。既定値 ${DEFAULT_CONFIG.sameFailureLimit} を使用します。`);
		c.sameFailureLimit = DEFAULT_CONFIG.sameFailureLimit;
	}
	if (!Number.isInteger(c.flakyRetries) || c.flakyRetries < 0 || c.flakyRetries > 5) {
		warnings.push(`flakyRetries は 0〜5 の整数で指定してください。既定値 ${DEFAULT_CONFIG.flakyRetries} を使用します。`);
		c.flakyRetries = DEFAULT_CONFIG.flakyRetries;
	}
	c.compaction = normalizeCompaction(raw.compaction as unknown, warnings);
	c.fallback = normalizeFallback(raw.fallback as unknown, warnings);
	if (typeof c.dashboard !== "boolean") c.dashboard = DEFAULT_CONFIG.dashboard;
	c.issueLimits = normalizeIssueLimits(raw.issueLimits as unknown, warnings);
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

export function normalizeCompaction(raw: unknown, warnings: string[] = []): HarnessConfig["compaction"] {
	const out = { ...DEFAULT_CONFIG.compaction };
	if (raw === undefined || raw === null) return out;
	if (typeof raw !== "object" || Array.isArray(raw)) {
		warnings.push("compaction はオブジェクトで指定してください。既定値を使用します。");
		return out;
	}
	const r = raw as Record<string, unknown>;
	if (r.enabled !== undefined) {
		if (typeof r.enabled === "boolean") out.enabled = r.enabled;
		else warnings.push("compaction.enabled は true / false で指定してください。");
	}
	if (r.thresholdPercent !== undefined) {
		const n = r.thresholdPercent;
		if (typeof n === "number" && n >= 20 && n <= 95) out.thresholdPercent = n;
		else warnings.push("compaction.thresholdPercent は 20〜95 の数値で指定してください。");
	}
	return out;
}

export function normalizeFallback(raw: unknown, warnings: string[] = []): FallbackSettings {
	const out = { ...DEFAULT_FALLBACK };
	if (raw === undefined || raw === null) return out;
	if (typeof raw !== "object" || Array.isArray(raw)) {
		warnings.push("fallback はオブジェクトで指定してください。既定値を使用します。");
		return out;
	}
	const r = raw as Record<string, unknown>;
	if (r.enabled !== undefined) {
		if (typeof r.enabled === "boolean") out.enabled = r.enabled;
		else warnings.push("fallback.enabled は true / false で指定してください。");
	}
	for (const key of ["quotaCooldownMinutes", "transientCooldownMinutes"] as const) {
		if (r[key] === undefined) continue;
		if (Number.isInteger(r[key]) && (r[key] as number) >= 1) out[key] = r[key] as number;
		else warnings.push(`fallback.${key} は 1 以上の整数（分）で指定してください。`);
	}
	return out;
}

export function normalizeIssueLimits(raw: unknown, warnings: string[] = []): HarnessConfig["issueLimits"] {
	const out = { ...DEFAULT_CONFIG.issueLimits, allowedSizes: [...DEFAULT_CONFIG.issueLimits.allowedSizes] };
	if (raw === undefined || raw === null) return out;
	if (typeof raw !== "object" || Array.isArray(raw)) {
		warnings.push("issueLimits はオブジェクトで指定してください。既定値を使用します。");
		return out;
	}
	const r = raw as Record<string, unknown>;
	for (const key of ["maxAcceptanceCriteria", "maxPlanTestCases"] as const) {
		if (r[key] === undefined) continue;
		if (Number.isInteger(r[key]) && (r[key] as number) >= 1) out[key] = r[key] as number;
		else warnings.push(`issueLimits.${key} は 1 以上の整数で指定してください。`);
	}
	if (r.allowedSizes !== undefined) {
		const v = r.allowedSizes;
		if (Array.isArray(v) && v.length && v.every((x) => x === "S" || x === "M" || x === "L")) out.allowedSizes = v as IssueSize[];
		else warnings.push('issueLimits.allowedSizes は ["S", "M"] のように S / M / L の配列で指定してください。');
	}
	return out;
}

export function normalizeGit(raw: unknown, warnings: string[] = []): GitSettings {
	if (raw === undefined || raw === null) return { ...DEFAULT_GIT };
	if (typeof raw !== "object" || Array.isArray(raw)) {
		warnings.push("git はオブジェクトで指定してください。既定値を使用します。");
		return { ...DEFAULT_GIT };
	}
	const r = raw as Record<string, unknown>;
	const g: GitSettings = { ...DEFAULT_GIT };
	for (const key of ["enabled", "commit", "commitArtifacts", "draft", "pullBase"] as const) {
		if (r[key] === undefined) continue;
		if (typeof r[key] === "boolean") g[key] = r[key] as boolean;
		else warnings.push(`git.${key} は true / false で指定してください。`);
	}
	if (r.branchPrefix !== undefined) {
		if (typeof r.branchPrefix === "string" && /^[\w./-]*$/.test(r.branchPrefix)) g.branchPrefix = r.branchPrefix;
		else warnings.push("git.branchPrefix は英数字・/・-・_・. で指定してください。");
	}
	if (r.baseBranch !== undefined) {
		if (typeof r.baseBranch === "string" && /^[\w./-]+$/.test(r.baseBranch)) g.baseBranch = r.baseBranch;
		else warnings.push("git.baseBranch はブランチ名で指定してください。");
	}
	if (r.pr !== undefined) {
		if (r.pr === "ask" || r.pr === "auto" || r.pr === "off") g.pr = r.pr;
		else warnings.push('git.pr は "ask" / "auto" / "off" のいずれかで指定してください。');
	}
	if (r.dirtyStart !== undefined) {
		if (r.dirtyStart === "ask" || r.dirtyStart === "allow" || r.dirtyStart === "refuse") g.dirtyStart = r.dirtyStart;
		else warnings.push('git.dirtyStart は "ask" / "allow" / "refuse" のいずれかで指定してください。');
	}
	return g;
}

/**
 * models 設定を正規化する。値は "provider/model-id"・その配列（フォールバック候補）・{ model, thinking } のいずれか。
 */
export function normalizeModels(raw: unknown, warnings: string[] = []): ModelSettings {
	if (raw === undefined || raw === null) return {};
	if (typeof raw !== "object" || Array.isArray(raw)) {
		warnings.push("models はオブジェクトで指定してください。無視します。");
		return {};
	}
	const toList = (v: unknown, key: string): string[] | undefined => {
		const list = typeof v === "string" ? [v] : Array.isArray(v) ? v : undefined;
		if (!list || !list.every((x) => typeof x === "string" && x.trim())) {
			warnings.push(`models.${key}.model は "provider/model-id" またはその配列で指定してください。`);
			return undefined;
		}
		return list.map((x: string) => x.trim());
	};
	const out: ModelSettings = {};
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		if (!MODEL_KEYS.includes(key as ModelKey)) {
			warnings.push(`models.${key} は不明なプロセスです（指定可能: ${MODEL_KEYS.join(", ")}）。無視します。`);
			continue;
		}
		const setting: ProcessModelSetting = {};
		if (typeof value === "string" || Array.isArray(value)) {
			setting.model = toList(value, key);
		} else if (value && typeof value === "object") {
			const v = value as { model?: unknown; thinking?: unknown };
			if (v.model !== undefined) setting.model = toList(v.model, key);
			if (typeof v.thinking === "string" && (THINKING_LEVELS as readonly string[]).includes(v.thinking)) {
				setting.thinking = v.thinking as ThinkingLevelName;
			} else if (v.thinking !== undefined) {
				warnings.push(`models.${key}.thinking は ${THINKING_LEVELS.join(" / ")} のいずれかで指定してください。`);
			}
		} else {
			warnings.push(`models.${key} は "provider/model-id"・その配列・{ "model": ..., "thinking": ... } のいずれかで指定してください。`);
			continue;
		}
		if (setting.model || setting.thinking) out[key as ModelKey] = setting;
	}
	return out;
}

/**
 * プロセスに適用する設定。優先順位は レビューの周回別キー（review_full / review_light）→ プロセス → default で、項目ごとに決める。
 */
export function resolveProcessModel(models: ModelSettings, process: ProcessKind, variant?: ReviewVariant): ProcessModelSetting {
	const chain = [variant ? models[variant] : undefined, models[process], models.default].filter(Boolean) as ProcessModelSetting[];
	return { model: chain.find((c) => c.model)?.model, thinking: chain.find((c) => c.thinking)?.thinking };
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
