/**
 * モデル利用量の集計（純粋関数）。セッションごとにアシスタントメッセージの usage を合計し、
 * 作業ディレクトリの usage.json にセッション ID をキーとして保存する（再集計しても重複しない）。
 */
import type { ProcessKind } from "./state.ts";

export interface UsageTotals {
	calls: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export interface SessionUsage {
	sessionId: string;
	process: ProcessKind;
	/** "provider/model" ごとの合計 */
	models: Record<string, UsageTotals>;
	updatedAt: string;
}

export interface UsageFile {
	version: 1;
	sessions: SessionUsage[];
}

export function emptyTotals(): UsageTotals {
	return { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function add(a: UsageTotals, b: UsageTotals): UsageTotals {
	return {
		calls: a.calls + b.calls,
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		cost: a.cost + b.cost,
	};
}

interface AssistantLike {
	role?: string;
	provider?: string;
	model?: string;
	usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } };
}

/** セッションのエントリからモデルごとの利用量を合計する */
export function sumSession(entries: { type: string; message?: unknown }[]): Record<string, UsageTotals> {
	const out: Record<string, UsageTotals> = {};
	for (const e of entries) {
		if (e.type !== "message") continue;
		const m = e.message as AssistantLike;
		if (m?.role !== "assistant" || !m.usage) continue;
		const key = `${m.provider ?? "?"}/${m.model ?? "?"}`;
		out[key] = add(out[key] ?? emptyTotals(), {
			calls: 1,
			input: m.usage.input ?? 0,
			output: m.usage.output ?? 0,
			cacheRead: m.usage.cacheRead ?? 0,
			cacheWrite: m.usage.cacheWrite ?? 0,
			cost: m.usage.cost?.total ?? 0,
		});
	}
	return out;
}

export function upsertSession(file: UsageFile, session: SessionUsage): UsageFile {
	const sessions = file.sessions.filter((s) => s.sessionId !== session.sessionId);
	return { ...file, sessions: [...sessions, session] };
}

/** プロセス別・モデル別の合計 */
export function summarize(file: UsageFile): { byProcess: Map<ProcessKind, UsageTotals & { sessions: number }>; byModel: Map<string, UsageTotals>; total: UsageTotals } {
	const byProcess = new Map<ProcessKind, UsageTotals & { sessions: number }>();
	const byModel = new Map<string, UsageTotals>();
	let total = emptyTotals();
	for (const s of file.sessions) {
		let sessionTotal = emptyTotals();
		for (const [model, t] of Object.entries(s.models)) {
			byModel.set(model, add(byModel.get(model) ?? emptyTotals(), t));
			sessionTotal = add(sessionTotal, t);
		}
		const prev = byProcess.get(s.process) ?? { ...emptyTotals(), sessions: 0 };
		byProcess.set(s.process, { ...add(prev, sessionTotal), sessions: prev.sessions + 1 });
		total = add(total, sessionTotal);
	}
	return { byProcess, byModel, total };
}

const n = (x: number) => x.toLocaleString("en-US");
const usd = (x: number) => `$${x.toFixed(4)}`;

export function usageMarkdown(file: UsageFile, labels: Record<string, string>): string {
	const { byProcess, byModel, total } = summarize(file);
	if (file.sessions.length === 0) return "利用量の記録はまだありません。";
	const lines = [
		"| プロセス | セッション | 呼び出し | 入力 | 出力 | キャッシュ読込 | 費用 |",
		"|---|---:|---:|---:|---:|---:|---:|",
		...[...byProcess].map(
			([p, t]) => `| ${labels[p] ?? p} | ${t.sessions} | ${t.calls} | ${n(t.input)} | ${n(t.output)} | ${n(t.cacheRead)} | ${usd(t.cost)} |`,
		),
		`| **合計** | ${file.sessions.length} | ${total.calls} | ${n(total.input)} | ${n(total.output)} | ${n(total.cacheRead)} | **${usd(total.cost)}** |`,
		"",
		"| モデル | 呼び出し | 入力 | 出力 | 費用 |",
		"|---|---:|---:|---:|---:|",
		...[...byModel].map(([m, t]) => `| ${m} | ${t.calls} | ${n(t.input)} | ${n(t.output)} | ${usd(t.cost)} |`),
	];
	return lines.join("\n");
}
