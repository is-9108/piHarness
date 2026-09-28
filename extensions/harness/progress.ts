/**
 * 登録した Issue の進み具合（純粋関数）。プロジェクト単位で .pi/harness/issues.json に保存する。
 * 依存関係から「次に着手できる Issue」を選ぶ。
 */

export type IssueStatus = "open" | "in_progress" | "done";

export interface TrackedIssue {
	/** "#12"（GitHub）または "file:docs/issues/01-x.md"（Markdown 保存時） */
	id: string;
	title: string;
	number?: number;
	url?: string;
	file?: string;
	/** 依存する Issue の id */
	deps: string[];
	status: IssueStatus;
	/** 登録元の要件定義の作業ディレクトリ */
	source?: string;
	updatedAt: string;
	pr?: string;
}

export interface IssueRegistry {
	version: 1;
	issues: TrackedIssue[];
}

export function emptyRegistry(): IssueRegistry {
	return { version: 1, issues: [] };
}

export function issueId(ref: { number?: number; file?: string; title: string }): string {
	if (ref.number) return `#${ref.number}`;
	if (ref.file) return `file:${ref.file}`;
	return `title:${ref.title}`;
}

/**
 * 要件定義で登録した Issue を追加する。deps は同じ登録内の 0 始まりインデックス（harness_create_issues の dependsOn）。
 * 既に同じ id があれば情報を更新する（状態は保持）。
 */
export function registerIssues(
	reg: IssueRegistry,
	created: { number?: number; url?: string; file?: string; title: string; dependsOn?: number[] }[],
	source: string | undefined,
	now = new Date().toISOString(),
): IssueRegistry {
	const ids = created.map((c) => issueId(c));
	const issues = [...reg.issues];
	created.forEach((c, i) => {
		const entry: TrackedIssue = {
			id: ids[i],
			title: c.title,
			number: c.number,
			url: c.url,
			file: c.file,
			deps: (c.dependsOn ?? []).map((d) => ids[d]).filter(Boolean),
			status: "open",
			source,
			updatedAt: now,
		};
		const at = issues.findIndex((x) => x.id === entry.id);
		if (at >= 0) issues[at] = { ...entry, status: issues[at].status, pr: issues[at].pr };
		else issues.push(entry);
	});
	return { ...reg, issues };
}

/** 状態を更新する。未登録の Issue（/impl で直接指定したもの）は追加する */
export function setStatus(
	reg: IssueRegistry,
	ref: { number?: number; file?: string; title: string; url?: string },
	status: IssueStatus,
	extra: { pr?: string } = {},
	now = new Date().toISOString(),
): IssueRegistry {
	const id = issueId(ref);
	const issues = [...reg.issues];
	const at = issues.findIndex((x) => x.id === id);
	if (at >= 0) issues[at] = { ...issues[at], status, updatedAt: now, ...extra };
	else issues.push({ id, title: ref.title, number: ref.number, url: ref.url, file: ref.file, deps: [], status, updatedAt: now, ...extra });
	return { ...reg, issues };
}

export interface NextIssue {
	issue?: TrackedIssue;
	/** 依存が終わっていないため着手できない Issue と、その未完了の依存 */
	blocked: { issue: TrackedIssue; waitingFor: string[] }[];
	inProgress: TrackedIssue[];
}

/** 登録順に見て、未着手かつ依存がすべて完了している最初の Issue */
export function nextIssue(reg: IssueRegistry): NextIssue {
	const done = new Set(reg.issues.filter((i) => i.status === "done").map((i) => i.id));
	const blocked: NextIssue["blocked"] = [];
	let issue: TrackedIssue | undefined;
	for (const i of reg.issues) {
		if (i.status !== "open") continue;
		// 未登録の依存（手動で消した等）も完了扱いにしない
		const waitingFor = i.deps.filter((d) => !done.has(d));
		if (waitingFor.length === 0) {
			issue ??= i;
		} else {
			blocked.push({ issue: i, waitingFor });
		}
	}
	return { issue, blocked, inProgress: reg.issues.filter((i) => i.status === "in_progress") };
}

export function progressTable(reg: IssueRegistry): string {
	if (reg.issues.length === 0) return "登録された Issue はありません（/req で要件定義から登録できます）。";
	const mark = { open: "○", in_progress: "▶", done: "✓" } as const;
	const { issue: next } = nextIssue(reg);
	const done = reg.issues.filter((i) => i.status === "done").length;
	const lines = reg.issues.map(
		(i) =>
			`${mark[i.status]} ${i.id.startsWith("#") ? i.id : i.file ?? i.id} ${i.title}` +
			(i.deps.length ? `（依存: ${i.deps.join(", ")}）` : "") +
			(next?.id === i.id ? "  ← 次" : ""),
	);
	return `Issue の進み具合: ${done}/${reg.issues.length} 完了\n${lines.join("\n")}`;
}
