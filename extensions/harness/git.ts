/**
 * Git 操作のヘルパー。コマンド実行は Run 関数として注入し、Pi なしでも（実際の git リポジトリで）テストできるようにする。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type Run = (cmd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface GitInfo {
	/** 実装開始時点のコミット（レビューの差分基準） */
	base: string;
	/** 開始時にいたブランチ（PR のマージ先） */
	baseBranch?: string;
	/** 作業ブランチ */
	branch?: string;
	/** 完了時に作成したコミット */
	commit?: string;
	pr?: { status: "created" | "skipped" | "failed"; url?: string; error?: string };
}

/** 作業ディレクトリ（成果物・ログ）を git の対象から外す pathspec */
export function excludeSpecs(excludes: string[]): string[] {
	return excludes.filter(Boolean).map((e) => `:(exclude)${e}`);
}

export async function isGitRepo(run: Run): Promise<boolean> {
	const r = await run("git", ["rev-parse", "--is-inside-work-tree"]).catch(() => undefined);
	return r?.code === 0 && r.stdout.trim() === "true";
}

export async function headSha(run: Run): Promise<string | undefined> {
	const r = await run("git", ["rev-parse", "HEAD"]);
	return r.code === 0 ? r.stdout.trim() : undefined;
}

export async function currentBranch(run: Run): Promise<string | undefined> {
	const r = await run("git", ["symbolic-ref", "--quiet", "--short", "HEAD"]);
	return r.code === 0 ? r.stdout.trim() : undefined;
}

/** 未コミットの変更（除外対象を除く）があるか */
export async function dirtyFiles(run: Run, excludes: string[]): Promise<string[]> {
	const r = await run("git", ["status", "--porcelain=v1", "--untracked-files=all", "--", ".", ...excludeSpecs(excludes)]);
	return r.stdout.split("\n").filter(Boolean);
}

/**
 * 作業ツリーの指紋。HEAD・追跡ファイルの差分・未追跡ファイルの内容から計算する。
 * edit/write ツール以外（bash の sed -i など）による変更も検知できる。
 */
export async function fingerprint(run: Run, cwd: string, excludes: string[]): Promise<string | undefined> {
	if (!(await isGitRepo(run))) return undefined;
	const spec = ["--", ".", ...excludeSpecs(excludes)];
	const hash = createHash("sha256");
	const head = (await headSha(run)) ?? "";
	hash.update(`HEAD ${head}\n`);
	// HEAD が無い（初回コミット前）場合はインデックスとの差分で代用
	const diff = head ? await run("git", ["diff", "HEAD", "--binary", ...spec]) : await run("git", ["diff", "--binary", ...spec]);
	hash.update(diff.stdout);
	if (!head) hash.update((await run("git", ["diff", "--cached", "--binary", ...spec])).stdout);
	const untracked = await run("git", ["ls-files", "--others", "--exclude-standard", "-z", ...spec]);
	for (const file of untracked.stdout.split("\0").filter(Boolean).sort()) {
		hash.update(`\0${file}\0`);
		try {
			hash.update(readFileSync(join(cwd, file)));
		} catch {
			hash.update("<unreadable>");
		}
	}
	return hash.digest("hex");
}

/** 作業ブランチ名。タイトルの英数字部分だけを使う（日本語だけのタイトルなら番号のみ） */
export function branchName(prefix: string, issue: { number?: number; title: string; file?: string }): string {
	const ascii = issue.title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/g, "");
	const id = issue.number
		? String(issue.number)
		: (issue.file ?? "local")
				.split("/")
				.pop()!
				.replace(/\.md$/, "")
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, "-")
				.replace(/^-+|-+$/g, "") || "local";
	return `${prefix}${id}${ascii && !id.includes(ascii) ? `-${ascii}` : ""}`;
}

export async function branchExists(run: Run, branch: string): Promise<boolean> {
	return (await run("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
}

/** リポジトリの既定ブランチ（origin/HEAD、無ければローカルの main / master） */
export async function defaultBranch(run: Run): Promise<string | undefined> {
	const r = await run("git", ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
	if (r.code === 0 && r.stdout.trim()) {
		const name = r.stdout.trim().replace(/^origin\//, "");
		if (await branchExists(run, name)) return name;
	}
	for (const name of ["main", "master"]) if (await branchExists(run, name)) return name;
	return undefined;
}

/**
 * 作業ブランチを用意する。既存なら切り替え、無ければ startFrom（省略時は現在のブランチ）から作成する。
 * 差分の基準 (base) は開始元ブランチの先端。既存ブランチの再開時は開始元との merge-base を使う。
 */
export async function prepareBranch(run: Run, branch: string, startFrom?: string): Promise<GitInfo> {
	const current = await currentBranch(run);
	const baseBranch = startFrom ?? current;
	const startHead = (await run("git", ["rev-parse", baseBranch ?? "HEAD"])).stdout.trim() || (await headSha(run));
	if (!startHead) throw new Error("コミットが 1 つもないリポジトリです。最初のコミットを作成してから /impl を実行してください。");
	if (current === branch && !startFrom) {
		// 作業ブランチ上で再開: 既定ブランチとの merge-base を基準にする（PR のマージ先も既定ブランチ）
		const def = await defaultBranch(run);
		if (def && def !== branch) {
			const mb = await run("git", ["merge-base", def, "HEAD"]);
			if (mb.code === 0 && mb.stdout.trim()) return { base: mb.stdout.trim(), baseBranch: def, branch };
		}
		return { base: startHead, branch };
	}
	const exists = await branchExists(run, branch);
	const args = exists ? ["switch", branch] : ["switch", "-c", branch, ...(baseBranch ? [baseBranch] : [])];
	if (current !== branch || !exists) {
		const r = await run("git", args);
		if (r.code !== 0) throw new Error(`ブランチ ${branch} に切り替えられません: ${(r.stderr || r.stdout).trim()}`);
	}
	let base = startHead;
	if (exists) {
		const mb = await run("git", ["merge-base", baseBranch ?? startHead, "HEAD"]);
		if (mb.code === 0 && mb.stdout.trim()) base = mb.stdout.trim();
	}
	return { base, baseBranch, branch };
}

/** 変更をコミットする。コミットするものが無ければ undefined */
export async function commitAll(run: Run, excludes: string[], message: string): Promise<string | undefined> {
	const add = await run("git", ["add", "-A", "--", ".", ...excludeSpecs(excludes)]);
	if (add.code !== 0) throw new Error(`git add に失敗しました: ${(add.stderr || add.stdout).trim()}`);
	const staged = await run("git", ["diff", "--cached", "--quiet"]);
	if (staged.code === 0) return undefined;
	const [subject, ...rest] = message.split("\n");
	const body = rest.join("\n").trim();
	const c = await run("git", ["commit", "-m", subject, ...(body ? ["-m", body] : [])]);
	if (c.code !== 0) {
		const out = (c.stderr || c.stdout).trim();
		const hint = /user\.(name|email)|identity/i.test(out)
			? "\ngit のユーザー情報が未設定です: git config --global user.name \"...\" && git config --global user.email \"...\""
			: "";
		throw new Error(`git commit に失敗しました: ${out}${hint}`);
	}
	return headSha(run);
}

/**
 * base からの差分（名前と状態）と、パッチ本文。
 * git diff は未追跡（新規作成）ファイルを含まないため、未追跡ファイルは全行を追加行として合成する。
 */
export async function diffSince(run: Run, base: string, excludes: string[], cwd?: string): Promise<{ nameStatus: string; patch: string }> {
	const spec = ["--", ".", ...excludeSpecs(excludes)];
	let nameStatus = (await run("git", ["diff", "--name-status", "-M", base, ...spec])).stdout;
	let patch = (await run("git", ["diff", "-U0", "-M", base, ...spec])).stdout;
	if (cwd) {
		const untracked = await run("git", ["ls-files", "--others", "--exclude-standard", "-z", ...spec]);
		for (const file of untracked.stdout.split("\0").filter(Boolean)) {
			let content: string;
			try {
				content = readFileSync(join(cwd, file), "utf8");
			} catch {
				continue;
			}
			nameStatus += `A\t${file}\n`;
			const lines = content.replace(/\n$/, "").split("\n");
			patch += `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}\n`;
		}
	}
	return { nameStatus, patch };
}

/**
 * 作業ツリー全体（未追跡ファイルを含み、.gitignore と除外パスを除く）を git の tree オブジェクトとして保存する。
 * 一時インデックスを使うので、ユーザーのインデックスやブランチには影響しない。
 */
export async function snapshotTree(run: Run, indexFile: string, excludes: string[]): Promise<string | undefined> {
	const script = 'set -e; export GIT_INDEX_FILE="$1"; shift; rm -f "$GIT_INDEX_FILE"; git add -A -- "$@" >/dev/null; git write-tree; rm -f "$GIT_INDEX_FILE"';
	const r = await run("bash", ["-c", script, "_", indexFile, ".", ...excludeSpecs(excludes)]);
	const tree = r.stdout.trim();
	return r.code === 0 && /^[0-9a-f]{40,64}$/.test(tree) ? tree : undefined;
}

/** 2 つのスナップショット間の差分（統計 + パッチ） */
export async function diffTrees(run: Run, from: string, to: string): Promise<string> {
	const stat = (await run("git", ["diff", "--stat", from, to])).stdout;
	const patch = (await run("git", ["diff", "-M", from, to])).stdout;
	return patch.trim() ? `${stat.trim()}\n\n${patch}` : "";
}
