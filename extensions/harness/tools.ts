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
] as const;

/** ファイルを書き換える組み込みツール */
const WRITE_TOOLS = ["edit", "write"];

const PROCESS_TOOLS: Record<ProcessKind, { harness: string[]; readOnly?: boolean }> = {
	hearing: { harness: ["harness_status", "harness_ask", "harness_phase"] },
	requirements: { harness: ["harness_status", "harness_ask", "harness_phase", "harness_request_approval"] },
	issues: { harness: ["harness_status", "harness_ask", "harness_create_issues"], readOnly: true },
	plan: { harness: ["harness_status", "harness_ask", "harness_phase", "harness_request_approval"] },
	implement: { harness: ["harness_status", "harness_ask", "harness_phase", "harness_run_tests"] },
	review: { harness: ["harness_status", "harness_record_review"], readOnly: true },
	fix: { harness: ["harness_status", "harness_phase", "harness_run_tests"] },
	bugfix: { harness: ["harness_status", "harness_ask", "harness_phase", "harness_run_tests"] },
};

/**
 * 現在有効なツールから、プロセスに不要な harness ツールと（読み取り専用のプロセスでは）書き込みツールを外す。
 * harness 以外のツール（ユーザーの他の拡張など）はそのまま残す。
 */
export function toolsForProcess(active: string[], registered: string[], proc: ProcessKind): string[] {
	const spec = PROCESS_TOOLS[proc];
	const harness = new Set<string>(HARNESS_TOOLS);
	const kept = active.filter((t) => !harness.has(t) && !(spec.readOnly && WRITE_TOOLS.includes(t)));
	const needed = spec.harness.filter((t) => registered.includes(t));
	return [...new Set([...kept, ...needed])];
}
