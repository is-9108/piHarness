/**
 * GitHub Issue 登録のヘルパー。gh CLI の引数組み立てと出力解析は純粋関数にしてテスト可能にしている。
 */
import { slugify } from "./text.ts";

export interface IssueDraft {
	title: string;
	body: string;
	labels?: string[];
	/** 依存する Issue（同じリクエスト内の 0 始まりインデックス。自分より前のものに限る） */
	dependsOn?: number[];
}

export function validateDrafts(drafts: IssueDraft[]): string[] {
	const errors: string[] = [];
	if (drafts.length === 0) errors.push("issues が空です。");
	drafts.forEach((d, i) => {
		if (!d.title?.trim()) errors.push(`issues[${i}]: title が空です。`);
		if (!d.body?.trim()) errors.push(`issues[${i}]: body が空です。`);
		for (const dep of d.dependsOn ?? []) {
			if (!Number.isInteger(dep) || dep < 0 || dep >= i) {
				errors.push(`issues[${i}]: dependsOn には自分より前の Issue のインデックス (0〜${i - 1}) を指定してください (値: ${dep})。`);
			}
		}
		if (!/受け入れ条件|Acceptance Criteria/i.test(d.body ?? "")) {
			errors.push(`issues[${i}] "${d.title}": 本文に「受け入れ条件」セクションがありません。`);
		}
	});
	return errors;
}

/** 依存 Issue の参照（作成済み番号 or タイトル）を本文末尾に追記する */
export function withDependencies(draft: IssueDraft, created: { number?: number; title: string }[]): string {
	const deps = (draft.dependsOn ?? []).map((i) => created[i]).filter(Boolean);
	if (deps.length === 0) return draft.body;
	const lines = deps.map((d) => `- ${d.number ? `#${d.number}` : d.title}`);
	return `${draft.body.replace(/\s+$/, "")}\n\n## 依存関係\n\n以下の Issue の完了後に着手してください。\n\n${lines.join("\n")}\n`;
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
