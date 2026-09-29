/**
 * GitHub Issue 登録のヘルパー。gh CLI の引数組み立てと出力解析は純粋関数にしてテスト可能にしている。
 */
import { slugify } from "./text.ts";

/** Issue 案。本文はテンプレート（templates/issue.md）で組み立てるので、項目ごとに受け取る */
export interface IssueDraft {
	title: string;
	/** なぜこの Issue が必要か（1〜3 文） */
	background: string;
	/** やること */
	inScope: string[];
	/** やらないこと */
	outOfScope?: string[];
	/** テスト可能な受け入れ条件（1 項目 = 1 条件） */
	acceptanceCriteria: string[];
	/** テスト観点: 正常系 */
	testNormal?: string[];
	/** テスト観点: 異常系・境界値 */
	testEdge?: string[];
	/** 参照ドキュメント（要件 ID・設計の該当箇所） */
	references?: string[];
	notes?: string;
	/** 規模の見積もり: S = 〜100 行 / M = 〜300 行 / L = それ以上（既定では L は分割が必要） */
	size?: "S" | "M" | "L";
	labels?: string[];
	/** 依存する Issue（同じリクエスト内の 0 始まりインデックス。自分より前のものに限る） */
	dependsOn?: number[];
}

export interface IssueLimits {
	maxAcceptanceCriteria: number;
	allowedSizes: ("S" | "M" | "L")[];
}

export function validateDrafts(drafts: IssueDraft[], limits?: IssueLimits): string[] {
	const errors: string[] = [];
	if (drafts.length === 0) errors.push("issues が空です。");
	drafts.forEach((d, i) => {
		if (!d.title?.trim()) errors.push(`issues[${i}]: title が空です。`);
		if (!d.background?.trim()) errors.push(`issues[${i}] "${d.title}": background（背景・目的）が空です。`);
		if (!d.inScope?.some((s) => s.trim())) errors.push(`issues[${i}] "${d.title}": inScope（やること）が空です。`);
		const ac = (d.acceptanceCriteria ?? []).filter((c) => c.trim()).length;
		if (ac === 0) errors.push(`issues[${i}] "${d.title}": acceptanceCriteria（受け入れ条件）がありません。`);
		for (const dep of d.dependsOn ?? []) {
			if (!Number.isInteger(dep) || dep < 0 || dep >= i) {
				errors.push(`issues[${i}]: dependsOn には自分より前の Issue のインデックス (0〜${i - 1}) を指定してください (値: ${dep})。`);
			}
		}
		if (limits) {
			if (d.size && !limits.allowedSizes.includes(d.size)) {
				errors.push(`issues[${i}] "${d.title}": 規模 ${d.size} は大きすぎます（許可: ${limits.allowedSizes.join(" / ")}）。より小さな振る舞いに分割してください。`);
			}
			if (ac > limits.maxAcceptanceCriteria) {
				errors.push(`issues[${i}] "${d.title}": 受け入れ条件が ${ac} 個あります（上限 ${limits.maxAcceptanceCriteria}）。1 Issue = 1 振る舞いになるよう分割してください。`);
			}
		}
	});
	return errors;
}

export function ghIssueCreateArgs(title: string, body: string, labels: string[], repo?: string): string[] {
	const args = ["issue", "create", "--title", title, "--body", body];
	for (const l of labels) args.push("--label", l);
	if (repo) args.push("--repo", repo);
	return args;
}

export function ghLabelCreateArgs(label: string, repo?: string): string[] {
	const args = ["label", "create", label, "--force"];
	if (repo) args.push("--repo", repo);
	return args;
}

/** gh issue create の出力から Issue URL と番号を取り出す */
export function parseIssueUrl(stdout: string): { url?: string; number?: number } {
	const m = stdout.match(/https?:\/\/\S+\/issues\/(\d+)/);
	if (!m) return {};
	return { url: m[0], number: Number(m[1]) };
}

/** gh が使えない場合のフォールバック: Markdown ファイルとして保存するときのファイル名 */
export function draftFileName(index: number, title: string): string {
	return `${String(index + 1).padStart(2, "0")}-${slugify(title)}.md`;
}

export function draftMarkdown(draft: IssueDraft, labels: string[], body: string): string {
	const front = labels.length ? `labels: ${labels.join(", ")}\n` : "";
	return `---\ntitle: ${JSON.stringify(draft.title)}\n${front}---\n\n# ${draft.title}\n\n${body.replace(/\s+$/, "")}\n`;
}

/** /impl の引数から Issue 番号を取り出す（"12", "#12", Issue URL に対応） */
export function parseIssueArg(arg: string): number | undefined {
	const t = arg.trim();
	const url = t.match(/\/issues\/(\d+)/);
	if (url) return Number(url[1]);
	const num = t.match(/^#?(\d+)$/);
	if (num) return Number(num[1]);
	return undefined;
}
