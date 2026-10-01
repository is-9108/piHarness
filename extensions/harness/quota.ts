/**
 * プロバイダーの利用上限とモデルのフォールバック（純粋関数）。
 *
 * pi は一時的なエラー（429・overloaded・5xx など）を自分で数回再試行するが、サブスクリプションや利用枠の上限
 * （OpenCode Go の月間上限、ChatGPT サブスクリプションの上限、insufficient_quota など）は再試行せず、そのまま失敗する。
 * piHarness はそのエラーで止まったプロセスを見つけ、プロバイダーを一定時間「上限」として記録し、
 * models の次の候補に切り替えて同じセッションで再開する。上限の記録は以降のプロセスにも効く。
 */

export type LimitKind = "quota" | "transient";

/** 利用枠・課金の上限（解除まで時間がかかる）。pi が再試行しないエラー */
const QUOTA_ERROR = new RegExp(
	[
		"GoUsageLimitError",
		"FreeUsageLimitError",
		"usage.?limit",
		"limit.?reached",
		"available balance",
		"insufficient_quota",
		"out of budget",
		"quota",
		"billing",
		"subscription_sharing_usage_limit_exceeded",
	].join("|"),
	"i",
);

/** 一時的な混雑・レート制限（pi の再試行でも回復しなかったもの） */
const TRANSIENT_ERROR = /overloaded|high demand|rate.?limit|too many requests|\b(429|500|502|503|504|520|524)\b|service.?unavailable/i;

/** 上限で止まったエラーの種類。上限と関係のないエラー（認証・不正なリクエストなど）は undefined */
export function classifyProviderError(message: string | undefined): LimitKind | undefined {
	if (!message) return undefined;
	if (QUOTA_ERROR.test(message)) return "quota";
	if (TRANSIENT_ERROR.test(message)) return "transient";
	return undefined;
}

const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** エラーの本文から解除までの時間を読み取る（"try again in 3h 20m"・"retry after 120 seconds"・ISO 形式の時刻） */
export function parseResetAt(message: string, now: Date): Date | undefined {
	const iso = message.match(/\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)/);
	if (iso) {
		const t = new Date(iso[1]);
		if (!Number.isNaN(t.getTime()) && t.getTime() > now.getTime()) return t;
	}
	const rel = message.match(/(?:in|after)\s+((?:\d+(?:\.\d+)?\s*(?:d|days?|h|hours?|hrs?|m|min|mins|minutes?|s|sec|secs|seconds?)\b[\s,]*)+)/i);
	if (!rel) return undefined;
	let ms = 0;
	for (const [, n, unit] of rel[1].matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)/gi)) {
		const u = unit.toLowerCase();
		const key = u.startsWith("mi") || u === "m" ? "m" : u[0];
		ms += Number(n) * (UNIT_MS[key] ?? 0);
	}
	return ms > 0 ? new Date(now.getTime() + ms) : undefined;
}

export interface ProviderLimit {
	/** この時刻までは、このプロバイダーのモデルを選ばない */
	until: string;
	kind: LimitKind;
	model?: string;
	message: string;
	at: string;
}

export interface ProviderStatus {
	version: 1;
	providers: Record<string, ProviderLimit>;
}

export function emptyStatus(): ProviderStatus {
	return { version: 1, providers: {} };
}

export interface CooldownSettings {
	quotaCooldownMinutes: number;
	transientCooldownMinutes: number;
}

/** 上限に達したプロバイダーを記録する。解除の時刻が本文から読めなければ、種類ごとの既定の時間だけ避ける */
export function recordLimit(
	status: ProviderStatus,
	provider: string,
	kind: LimitKind,
	message: string,
	now: Date,
	cooldown: CooldownSettings,
	model?: string,
): ProviderStatus {
	const minutes = kind === "quota" ? cooldown.quotaCooldownMinutes : cooldown.transientCooldownMinutes;
	const until = parseResetAt(message, now) ?? new Date(now.getTime() + minutes * 60_000);
	return {
		version: 1,
		providers: { ...status.providers, [provider]: { until: until.toISOString(), kind, model, message: message.slice(0, 500), at: now.toISOString() } },
	};
}

/** プロバイダーが上限中なら、解除の時刻を返す */
export function limitedUntil(status: ProviderStatus, provider: string, now: Date): Date | undefined {
	const limit = status.providers[provider];
	if (!limit) return undefined;
	const until = new Date(limit.until);
	return until.getTime() > now.getTime() ? until : undefined;
}

/** 解除済みの記録を取り除く */
export function pruneStatus(status: ProviderStatus, now: Date): ProviderStatus {
	const providers = Object.fromEntries(Object.entries(status.providers).filter(([, l]) => new Date(l.until).getTime() > now.getTime()));
	return { version: 1, providers };
}

/** 上限中のプロバイダーのうち、最も早く解除される時刻 */
export function earliestReset(status: ProviderStatus, providers: string[], now: Date): Date | undefined {
	const times = providers.map((p) => limitedUntil(status, p, now)).filter((t): t is Date => !!t);
	return times.length ? new Date(Math.min(...times.map((t) => t.getTime()))) : undefined;
}

/** 表示用の時刻（ローカル時刻の HH:MM。日付が変わるなら M/D も） */
export function formatUntil(until: Date, now: Date): string {
	const hm = `${String(until.getHours()).padStart(2, "0")}:${String(until.getMinutes()).padStart(2, "0")}`;
	return until.toDateString() === now.toDateString() ? hm : `${until.getMonth() + 1}/${until.getDate()} ${hm}`;
}
