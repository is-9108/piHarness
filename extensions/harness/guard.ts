/**
 * フェーズに応じたツール実行ガード（純粋関数）。
 * 承認ゲートを通過する前にプロダクションコードを書き換えることを防ぐ。
 */
import { isAbsolute, relative, resolve } from "node:path";
import type { HarnessState, Phase } from "./state.ts";

export interface GuardPaths {
	cwd: string;
	docsDir: string;
	workDir: string;
}

/** フェーズごとに書き込みを許可するディレクトリ。undefined = 制限なし */
function writableRoots(phase: Phase, p: GuardPaths): string[] | undefined {
	switch (phase) {
		case "req_clarify":
		case "req_document":
		case "req_approval":
		case "req_issues":
		case "req_done":
			return [p.docsDir, p.workDir];
		case "impl_context":
		case "impl_plan":
		case "impl_plan_approval":
		case "impl_review":
		case "impl_spec_gap":
		case "impl_done":
		case "escalated":
		case "bug_analyze":
		case "bug_done":
			return [p.workDir];
		default:
			return undefined;
	}
}

export function isInside(path: string, root: string, cwd: string): boolean {
	const abs = isAbsolute(path) ? path : resolve(cwd, path);
	const rootAbs = isAbsolute(root) ? root : resolve(cwd, root);
	const rel = relative(rootAbs, abs);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export interface GuardDecision {
	block: boolean;
	reason?: string;
}

const WHY: Partial<Record<Phase, string>> = {
	req_clarify: "要件定義フロー中はドキュメント以外を変更できません。",
	req_document: "要件定義フロー中はドキュメント以外を変更できません。",
	req_approval: "要件定義の承認待ちです。",
	impl_context: "テスト/実装プランが承認されるまでコードは変更できません。",
	impl_plan: "テスト/実装プランが承認されるまでコードは変更できません。",
	impl_plan_approval: "テスト/実装プランの承認待ちです。",
	impl_review: "レビュー中はコードを変更できません。harness_record_review で指摘を記録してから修正してください。",
	impl_spec_gap: "仕様の確認（ユーザーの回答）待ちです。",
	impl_done: "実装フローは完了しています。",
	escalated: "ユーザーへエスカレーション中です。ユーザーの判断を待ってください。",
	bug_analyze: "原因分析中はコードを変更できません。分析後 harness_phase で bug_fix へ進んでください。",
	bug_done: "バグ修正フローは完了しています。",
};

export const STATE_FILE = "state.json";

export function checkWrite(state: HarnessState, path: string | undefined, p: GuardPaths): GuardDecision {
	if (path && isInside(path, `${p.workDir}/${STATE_FILE}`, p.cwd)) {
		return { block: true, reason: "[piHarness] ワークフロー状態ファイルは直接編集できません。harness_* ツールを使用してください。" };
	}
	if (!state.flow || state.phase === "idle" || !path) return { block: false };
	const roots = writableRoots(state.phase, p);
	if (!roots) return { block: false };
	if (roots.some((r) => isInside(path, r, p.cwd))) return { block: false };
	return {
		block: true,
		reason: `[piHarness] ${WHY[state.phase] ?? ""} 現在のフェーズ: ${state.phase}。書き込み可能: ${roots.join(", ")}/ 配下のみ。(対象: ${path})`,
	};
}

/** harness の作業ディレクトリ配下かどうか（dirty 判定から除外する） */
export function isHarnessFile(path: string | undefined, p: GuardPaths): boolean {
	return !!path && (isInside(path, p.workDir, p.cwd) || isInside(path, p.docsDir, p.cwd));
}

/**
 * 名前ごとに個別の検査をしている、またはファイルを書き換えない組み込みのツール。
 * edit / write はパスで、bash / powershell はコマンドで検査する。codemode のスクリプトが呼ぶツールは、1 つずつ tool_call を通る。
 */
const BUILTIN_TOOLS = new Set(["read", "grep", "find", "ls", "bash", "powershell", "edit", "write", "codemode", "tool_search"]);

/** ツールの情報（pi.getAllTools() から取れるもの）。annotations は MCP ツールの注釈と同じ意味 */
export interface ToolMeta {
	name: string;
	annotations?: { readOnlyHint?: boolean };
}

/**
 * 組み込み・harness 以外のツール（MCP ツールや他の拡張のツール）が、ファイルなどを書き換えうるか。
 * - annotations があれば readOnlyHint で判断する
 * - MCP ツール（mcp__<サーバー>__<ツール>）は、annotations が無ければ MCP の既定どおり書き換えうるとみなす
 * - annotations を宣言していない他の拡張のツールは判断できないため、書き換えないものとして扱う
 */
export function mayModify(tool: ToolMeta): boolean {
	if (BUILTIN_TOOLS.has(tool.name) || tool.name.startsWith("harness_")) return false;
	if (tool.annotations) return tool.annotations.readOnlyHint !== true;
	return tool.name.startsWith("mcp__");
}

/**
 * 書き込みを制限しているフェーズ（承認前・レビュー中など）で、ファイルを書き換えうるツールをブロックする。
 * MCP ツールは既定で codemode のスクリプトからいつでも呼べるため、有効なツールを絞るだけでは防げない。
 */
export function checkOtherTool(state: HarnessState, tool: ToolMeta, p: GuardPaths): GuardDecision {
	if (!state.flow || state.phase === "idle" || !mayModify(tool)) return { block: false };
	const roots = writableRoots(state.phase, p);
	if (!roots) return { block: false };
	return {
		block: true,
		reason:
			`[piHarness] ${WHY[state.phase] ?? ""} 現在のフェーズ: ${state.phase}。` +
			`${tool.name} は読み取り専用（readOnlyHint）と宣言されていないため、このフェーズでは使えません。成果物の作成には write を使ってください。`,
	};
}

const ISSUE_CREATE = /\bgh\s+issue\s+create\b/;

export function checkBash(state: HarnessState, command: string | undefined): GuardDecision {
	if (!command || !state.flow) return { block: false };
	if (ISSUE_CREATE.test(command)) {
		return {
			block: true,
			reason: "[piHarness] Issue の登録は harness_create_issues ツールを使用してください（承認ゲートと分割ルールを適用するため）。",
		};
	}
	return { block: false };
}
