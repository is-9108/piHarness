/**
 * しきい値による自動圧縮の判断と、圧縮時に残すべき内容の指示（純粋関数）。
 * Pi の既定の自動圧縮はコンテキスト上限の直前で動くため、長い TDD セッションでは応答が遅く・高くなってから圧縮される。
 * piHarness は設定した割合（既定 60%）で早めに圧縮し、圧縮後はプロセスのスキルと成果物の一覧を送り直して作業を再開させる。
 */
import type { HarnessState, Phase } from "./state.ts";

/** 人間の判断待ちなど、圧縮しても意味がない（作業していない）フェーズ */
const IDLE_PHASES: Phase[] = ["req_approval", "impl_plan_approval", "escalated", "impl_done", "req_done", "bug_done", "doc_outline_approval", "doc_done", "idle"];

export interface CompactionSettings {
	enabled: boolean;
	/** コンテキストウィンドウに対する使用率（%）がこれ以上になったら圧縮する */
	thresholdPercent: number;
}

export function shouldCompact(
	s: HarnessState,
	usage: { percent: number | null } | undefined,
	settings: CompactionSettings,
	compacting: boolean,
): boolean {
	if (!settings.enabled || compacting || !s.flow || s.pendingHandoff) return false;
	if (IDLE_PHASES.includes(s.phase)) return false;
	if (!usage || usage.percent === null) return false;
	return usage.percent >= settings.thresholdPercent;
}

/** 圧縮（要約）時の指示: 再開に必要な作業状態を落とさない。スキル本文と成果物の内容は再送・再読できるので要約しない */
export function compactionInstructions(s: HarnessState): string {
	return [
		"piHarness のワークフロー中のセッションです。要約には次を必ず残してください:",
		`- プロセスとフェーズ（現在: ${s.phase}）、作業ディレクトリ ${s.itemDir ?? "-"}`,
		"- 完了したテストケース / 実装ステップと、残っているもの（plan.md の番号で）",
		"- 直近のテスト結果、失敗している場合はエラー内容・原因の仮説・試した修正（同じ修正を繰り返さないため）",
		"- 変更・作成したファイルとその目的",
		"- 未解決のレビュー指摘・ユーザーからの指示や回答",
		"スキルの手順・成果物ファイルの内容・ツール定義は再送または再読できるので要約に含めないでください。",
	].join("\n");
}
