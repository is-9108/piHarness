/**
 * テスト・チェックの失敗の「指紋」（純粋関数）。
 *
 * テストランナーの出力から失敗を表す行を取り出し、実行ごとに変わる値（数値・時間・パス・色）を取り除いて集合にする。
 * - 同じ失敗の指紋が続けば「修正が進んでいない」とみなし、ループの上限を待たずにエスカレーションする
 * - 実装開始時点（ベースライン）ですでに失敗していたものだけが残っている場合は、判定から除外する
 *
 * JUnit などの構造化出力に頼らず、主なランナー（node:test / vitest / jest / pytest / go test / cargo test / tsc / eslint）の行の形で判定する。
 */
import { createHash } from "node:crypto";

/** 失敗を表す行 */
const FAILURE_LINE =
	/\b(fail(ed|ure|ures|s)?|errors?|not ok|panic(ked)?|traceback|exception|assertion)\b|\b\w+(Error|Exception)\b|✖|✕|✗|×|●|--- FAIL/i;

/** 合格を表す行（失敗の語を含むテスト名でも、合格の行は指紋に入れない） */
const PASS_LINE = /^(✔|✓|√|ok\b|pass(ed)?\b|PASS\b)/i;

/** npm / make などのラッパーが出す行（どのテストが失敗しても同じなので、失敗の区別に使わない） */
const WRAPPER_LINE = /^(\s*(npm (ERR!|error|warn)|pnpm:? |yarn (error|run)|error Command failed|ELIFECYCLE|make(\[\d+\])?: \*\*\*)|> )/i;

/** 失敗の行が見つからないときに使う、出力の末尾の行数 */
const FALLBACK_LINES = 20;

/** 保存する行数の上限（state.json を大きくしないため） */
export const MAX_FAILURE_LINES = 200;

/** 端末の色・カーソル制御 */
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** 実行ごとに変わる値を取り除く */
export function normalizeLine(line: string, cwd?: string): string {
	let s = line.replace(ANSI, "");
	if (cwd) s = s.split(cwd).join(".");
	return s
		.replace(/(?<![\w.~-])(\/[\w.@+-]+){2,}\/?/g, (m) => `…/${m.split("/").filter(Boolean).pop() ?? ""}`) // 絶対パス → 末尾だけ
		.replace(/\b0x[0-9a-f]+\b/gi, "0xN")
		.replace(/\b[0-9a-f]{7,}\b/gi, "HASH")
		.replace(/\d+(\.\d+)?\s?(ms|s|sec|m|min)\b/g, "T")
		.replace(/\d+/g, "N")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * 出力から失敗を表す行を取り出し、正規化して重複を除いた一覧（並べ替え済み）を返す。
 * recognized は、失敗を表す行が見つかったか（見つからなければ出力の末尾で代用している）。
 */
export function analyzeOutput(output: string, cwd?: string): { lines: string[]; recognized: boolean } {
	const lines = output
		.split(/\r?\n/)
		.map((l) => l.replace(ANSI, ""))
		.filter((l) => l.trim() && !WRAPPER_LINE.test(l));
	let picked = lines.filter((l) => FAILURE_LINE.test(l) && !PASS_LINE.test(l.trim()));
	const recognized = picked.length > 0;
	if (!recognized) picked = lines.slice(-FALLBACK_LINES);
	const normalized = [...new Set(picked.map((l) => normalizeLine(l, cwd)).filter(Boolean))].sort();
	return { lines: normalized.slice(0, MAX_FAILURE_LINES), recognized };
}

export function failureLines(output: string, cwd?: string): string[] {
	return analyzeOutput(output, cwd).lines;
}

/** 1 つのコマンドの失敗 */
export interface CommandFailure {
	command: string;
	/** タイムアウト・中断で終わったか */
	killed: boolean;
	lines: string[];
	/** 失敗を表す行が見つかったか（false なら出力の末尾で代用しており、どのテストが失敗したかは区別できない） */
	recognized?: boolean;
}

/** 失敗の指紋（失敗したコマンドと、その失敗の行から計算する） */
export function failureFingerprint(failures: CommandFailure[]): string {
	const key = failures.map((f) => JSON.stringify({ command: f.command, killed: f.killed, lines: f.lines })).sort();
	return createHash("sha256").update(key.join("\n")).digest("hex").slice(0, 16);
}

/**
 * ベースライン（実装開始時点）ですでに失敗していたものだけが残っているか。
 * 失敗を表す行が見つからない（出力が空、どのテストが失敗したか分からない）ときは区別できないので、除外しない（安全側に倒す）。
 * タイムアウトも除外しない。
 */
export function onlyBaselineFailures(current: CommandFailure, baseline: CommandFailure | undefined): boolean {
	if (!baseline) return false;
	if (current.killed || baseline.killed) return false;
	if (!current.recognized || !baseline.recognized) return false;
	if (current.lines.length === 0 || baseline.lines.length === 0) return false;
	const known = new Set(baseline.lines);
	return current.lines.every((l) => known.has(l));
}
