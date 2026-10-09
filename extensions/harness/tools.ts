/**
 * プロセスごとに有効にするツール（純粋関数）。
 * ツールの定義はリクエストのたびにモデルへ送られるため、使わないツールを外してトークンと無駄な呼び出しを減らす。
 */
import type { ProcessKind } from "./state.ts";

export const HARNESS_TOOLS = [
	"harness_status",
	"harness_ask",
	"harness_phase",
	"harness_request_approval",
	"harness_run_tests",
	"harness_record_review",
	"harness_create_issues",
	"harness_control",
	"harness_request_test_change",
	"harness_record_decision",
] as const;

/** フロー外（通常の会話）で有効にする harness ツール: 状態の確認と、自然言語からのフロー開始だけ */
export const IDLE_HARNESS_TOOLS = ["harness_status", "harness_control"];

/** ファイルを書き換える組み込みツール */
const WRITE_TOOLS = ["edit", "write"];

const PROCESS_TOOLS: Record<ProcessKind, { harness: string[]; readOnly?: boolean }> = {
	hearing: { harness: ["harness_status", "harness_ask", "harness_phase", "harness_control"] },
	requirements: { harness: ["harness_status", "harness_ask", "harness_phase", "harness_request_approval", "harness_record_decision", "harness_control"] },
	issues: { harness: ["harness_status", "harness_ask", "harness_create_issues", "harness_control"], readOnly: true },
	plan: { harness: ["harness_status", "harness_ask", "harness_phase", "harness_request_approval", "harness_record_decision", "harness_control"] },
	implement: { harness: ["harness_status", "harness_ask", "harness_phase", "harness_run_tests", "harness_request_test_change", "harness_record_decision", "harness_control"] },
	review: { harness: ["harness_status", "harness_record_review", "harness_control"], readOnly: true },
	fix: { harness: ["harness_status", "harness_phase", "harness_run_tests", "harness_request_test_change", "harness_record_decision", "harness_control"] },
	bugfix: { harness: ["harness_status", "harness_ask", "harness_phase", "harness_run_tests", "harness_request_test_change", "harness_record_decision", "harness_control"] },
};

/**
 * 現在有効なツールから、プロセスに不要な harness ツールと（読み取り専用のプロセスでは）書き込みツールを外す。
 * harness 以外のツール（ユーザーの他の拡張など）はそのまま残す。
 */
export function toolsForProcess(active: string[], registered: string[], proc: ProcessKind | null): string[] {
	if (!proc) {
		const harness = new Set<string>(HARNESS_TOOLS);
		return [...new Set([...active.filter((t) => !harness.has(t)), ...IDLE_HARNESS_TOOLS.filter((t) => registered.includes(t))])];
	}
	const spec = PROCESS_TOOLS[proc];
	const harness = new Set<string>(HARNESS_TOOLS);
	const kept = active.filter((t) => !harness.has(t) && !(spec.readOnly && WRITE_TOOLS.includes(t)));
	const needed = spec.harness.filter((t) => registered.includes(t));
	return [...new Set([...kept, ...needed])];
}
