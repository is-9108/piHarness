/**
 * ADR（Architecture Decision Record: 重要な設計判断の記録）。純粋関数。
 * エージェントからは項目で受け取り、本文はテンプレート（templates/adr.md）で組み立てる。
 * 一覧（<adrDir>/README.md）は拡張が管理し、後のプロセスはまず一覧を見て関連する ADR だけを読む。
 */
import { slugify } from "./text.ts";

export interface AdrOption {
	name: string;
	description?: string;
	pros?: string[];
	cons?: string[];
	/** 採用した選択肢（ちょうど 1 つ） */
	chosen?: boolean;
}

export interface AdrDraft {
	title: string;
	/** 背景・課題（なぜ決める必要があったか） */
	context: string;
	/** 決定内容 */
	decision: string;
	/** 検討した選択肢（採用したものを含めて 2 つ以上。「現状維持」も選択肢になる） */
	options: AdrOption[];
	/** 良い影響 */
	positive?: string[];
	/** 悪い影響・トレードオフ */
	negative?: string[];
	/** この決定を見直す条件 */
	revisit?: string;
	/** 関連（Issue・要件 ID・ファイル） */
	related?: string[];
	/** 置き換える既存の ADR の番号 */
	supersedes?: number;
}

const NONE = "なし";

export function adrId(n: number): string {
	return `ADR-${String(n).padStart(4, "0")}`;
}

export function adrFileName(n: number, title: string): string {
	return `${String(n).padStart(4, "0")}-${slugify(title, 40)}.md`;
}

/** ADR ディレクトリのファイル名から次の番号を決める（0001-xxx.md の形だけを数える） */
export function nextAdrNumber(files: string[]): number {
	const nums = files.map((f) => f.match(/^(\d{4})-.*\.md$/)?.[1]).filter(Boolean).map(Number);
	return nums.length ? Math.max(...nums) + 1 : 1;
}

/** 既存の ADR 番号に対応するファイル名 */
export function adrFileOf(files: string[], n: number): string | undefined {
	const prefix = `${String(n).padStart(4, "0")}-`;
	return files.find((f) => f.startsWith(prefix) && f.endsWith(".md"));
}

export function validateAdr(d: AdrDraft, existing: string[]): string[] {
	const errors: string[] = [];
	if (!d.title?.trim()) errors.push("title が空です。");
	if (!d.context?.trim()) errors.push("context（背景・課題）が空です。");
	if (!d.decision?.trim()) errors.push("decision（決定）が空です。");
	const options = d.options ?? [];
	if (options.length < 2) errors.push("options には採用しなかった案も含めて 2 つ以上書いてください（「現状維持」「何もしない」も選択肢です）。");
	if (options.some((o) => !o.name?.trim())) errors.push("options の name が空です。");
	const chosen = options.filter((o) => o.chosen).length;
	if (chosen !== 1) errors.push(`options のうち採用したもの（chosen: true）をちょうど 1 つにしてください（現在 ${chosen} 個）。`);
	if (d.supersedes !== undefined && !adrFileOf(existing, d.supersedes)) errors.push(`置き換え対象の ${adrId(d.supersedes)} が見つかりません。`);
	return errors;
}

function bullets(items: string[] | undefined): string {
	const list = (items ?? []).map((s) => s.trim()).filter(Boolean);
	return list.length ? list.map((s) => `- ${s}`).join("\n") : NONE;
}

function optionsMarkdown(options: AdrOption[]): string {
	return options
		.map((o, i) =>
			[
				`### ${i + 1}. ${o.name.trim()}${o.chosen ? "（採用）" : ""}`,
				o.description?.trim() ? `\n${o.description.trim()}\n` : "",
				`- 利点: ${(o.pros ?? []).filter((s) => s.trim()).join(" / ") || NONE}`,
				`- 欠点: ${(o.cons ?? []).filter((s) => s.trim()).join(" / ") || NONE}`,
			]
				.filter((l) => l !== "")
				.join("\n"),
		)
		.join("\n\n");
}

export function adrVars(
	d: AdrDraft,
	args: { number: number; date: string; process: string; workItem?: string; supersededFile?: string },
): Record<string, string> {
	return {
		number: String(args.number).padStart(4, "0"),
		title: d.title.trim(),
		status: "採用",
		date: args.date,
		process: args.process,
		workItem: args.workItem ?? "",
		related: bullets(d.related).replace(/\n/g, "<br>"),
		supersedes: d.supersedes !== undefined ? `[${adrId(d.supersedes)}](${args.supersededFile ?? ""})` : NONE,
		context: d.context,
		decision: d.decision,
		options: optionsMarkdown(d.options),
		positive: bullets(d.positive),
		negative: bullets(d.negative),
		revisit: d.revisit ?? "",
	};
}

const INDEX_HEADER = [
	"# ADR 一覧",
	"",
	"重要な設計判断の記録です。piHarness の `harness_record_decision` が追記します（直接編集しないでください）。",
	"判断の前に、関連する ADR がないかこの一覧で確認します。",
	"",
	"| 番号 | タイトル | ステータス | 日付 | 記録した作業 |",
	"|---|---|---|---|---|",
].join("\n");

export interface AdrIndexRow {
	number: number;
	file: string;
	title: string;
	date: string;
	workItem?: string;
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

/** 一覧に 1 行追加する。置き換えた ADR の行はステータスを「置き換え済み」にする */
export function updateAdrIndex(index: string | undefined, row: AdrIndexRow, supersedes?: number): string {
	let text = index?.trim() ? index.replace(/\s+$/, "") : INDEX_HEADER;
	if (supersedes !== undefined) {
		const id = adrId(supersedes);
		text = text
			.split("\n")
			.map((l) => {
				if (!l.startsWith(`| [${id}]`)) return l;
				const cols = l.split(/(?<!\\)\|/);
				// ["", 番号, タイトル, ステータス, 日付, 作業, ""]
				if (cols.length >= 5) cols[3] = ` 置き換え済み（${adrId(row.number)}） `;
				return cols.join("|");
			})
			.join("\n");
	}
	const line = `| [${adrId(row.number)}](${row.file}) | ${cell(row.title)} | 採用 | ${row.date} | ${cell(row.workItem ?? "-")} |`;
	return `${text}\n${line}\n`;
}

/** 置き換えられた ADR の末尾に付ける注記 */
export function supersededNote(by: number, file: string, date: string): string {
	return `\n---\n\n> **置き換え済み（${date}）:** この決定は [${adrId(by)}](${file}) で置き換えられました。\n`;
}
