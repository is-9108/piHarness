/**
 * テストファイルのロック。
 *
 * TDD の Red で失敗を確かめたテストは、Green（実装）の間は書き換えられないようにする。
 * レビューへ進んだ後は、レビュー時点のテストを書き換えられないようにする（新しいテストファイルの追加はできる）。
 * 書き換えが必要なときは、理由を示してユーザーの承認を得る（harness_request_test_change）。
 *
 * 守り方は 2 段:
 *   1. edit / write ツールでの書き込みを tool_call でブロックする（checkLockedWrite）
 *   2. bash など別の経路での変更は、テスト実行とフェーズ遷移の前にハッシュで照合し、ロック時の内容に戻す（findViolations / restoreFiles）
 *
 * ロック時の内容は作業ディレクトリの test-lock/<sha256> に保存する（同じ内容は一度だけ書く）。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { excludeSpecs, type Run } from "./git.ts";
import { isTestFile } from "./integrity.ts";

export interface TestLock {
	/** green: Red の確認から Green の合格まで（テストの追加も不可）/ review: レビュー以降（新しいテストファイルの追加は可） */
	mode: "green" | "review";
	at: string;
	/** ロックしたテストファイル（cwd からの相対パス）→ 内容の sha256 */
	files: Record<string, string>;
	/** ユーザーが変更を承認したテストファイル（次にロックし直すまで編集できる） */
	allowed: string[];
}

export interface Violations {
	/** ロック時から内容が変わった */
	changed: string[];
	/** ロック時にあったのに無くなった */
	deleted: string[];
	/** green ロック中に新しく作られたテストファイル */
	added: string[];
}

/** 走査しないディレクトリ（git 管理外のプロジェクト用） */
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "target", ".venv", "venv", "__pycache__", ".pytest_cache", "coverage", ".next", ".cache"]);
const WALK_LIMIT = 20_000;

export function sha256(content: Buffer | string): string {
	return createHash("sha256").update(content).digest("hex");
}

/** ツールに渡されたパスを cwd からの相対パス（/ 区切り）にする */
export function toRel(path: string, cwd: string): string {
	const abs = isAbsolute(path) ? path : resolve(cwd, path);
	return relative(cwd, abs).split(sep).join("/");
}

/** ロックの対象にするテストファイル（テストランナーが書き換えるスナップショットやキャッシュは除く） */
export function isLockable(rel: string): boolean {
	return isTestFile(rel) && !/(^|\/)(__pycache__|__snapshots__|node_modules)\/|\.(pyc|snap)$/.test(rel);
}

function isExcluded(rel: string, excludes: string[]): boolean {
	return excludes.some((e) => {
		const x = e.replace(/\/+$/, "");
		return x && (rel === x || rel.startsWith(`${x}/`));
	});
}

/** プロジェクト内のテストファイル（未追跡を含み、.gitignore と除外パスを除く） */
export async function listTestFiles(run: Run | undefined, cwd: string, excludes: string[]): Promise<string[]> {
	if (run) {
		const r = await run("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ".", ...excludeSpecs(excludes)]).catch(() => undefined);
		if (r?.code === 0) {
			const files = [...new Set(r.stdout.split("\0").filter(Boolean))];
			return files.filter((f) => isLockable(f) && existsSync(join(cwd, f))).sort();
		}
	}
	const out: string[] = [];
	const walk = (dir: string) => {
		if (out.length >= WALK_LIMIT) return;
		let entries: string[];
		try {
			entries = readdirSync(join(cwd, dir));
		} catch {
			return;
		}
		for (const name of entries) {
			const rel = dir ? `${dir}/${name}` : name;
			if (isExcluded(rel, excludes)) continue;
			let st: ReturnType<typeof statSync>;
			try {
				st = statSync(join(cwd, rel));
			} catch {
				continue;
			}
			if (st.isDirectory()) {
				if (!SKIP_DIRS.has(name)) walk(rel);
			} else if (isLockable(rel)) out.push(rel);
		}
	};
	walk("");
	return out.sort();
}

/** テストファイルの内容のハッシュを取り、ロック時の内容を blobDir に保存する */
export function snapshotFiles(cwd: string, files: string[], blobDir: string): Record<string, string> {
	const hashes: Record<string, string> = {};
	mkdirSync(join(cwd, blobDir), { recursive: true });
	for (const f of files) {
		let content: Buffer;
		try {
			content = readFileSync(join(cwd, f));
		} catch {
			continue;
		}
		const h = sha256(content);
		hashes[f] = h;
		const blob = join(cwd, blobDir, h);
		if (!existsSync(blob)) writeFileSync(blob, content);
	}
	return hashes;
}

/** 現在のテストファイルとロックを照合する（承認済みの変更は除く） */
export function findViolations(cwd: string, lock: TestLock, current: string[]): Violations {
	const allowed = new Set(lock.allowed);
	const v: Violations = { changed: [], deleted: [], added: [] };
	for (const [f, h] of Object.entries(lock.files)) {
		if (allowed.has(f)) continue;
		const abs = join(cwd, f);
		if (!existsSync(abs)) {
			v.deleted.push(f);
			continue;
		}
		try {
			if (sha256(readFileSync(abs)) !== h) v.changed.push(f);
		} catch {
			v.changed.push(f);
		}
	}
	if (lock.mode === "green") {
		for (const f of current) if (!(f in lock.files) && !allowed.has(f)) v.added.push(f);
	}
	return v;
}

export function hasViolations(v: Violations): boolean {
	return v.changed.length + v.deleted.length + v.added.length > 0;
}

/** ロック時の内容に戻す。保存した内容が無い・壊れている場合は戻せなかったものとして返す */
export function restoreFiles(cwd: string, lock: TestLock, files: string[], blobDir: string): { restored: string[]; failed: string[] } {
	const restored: string[] = [];
	const failed: string[] = [];
	for (const f of files) {
		const h = lock.files[f];
		const blob = join(cwd, blobDir, h ?? "-");
		try {
			const content = readFileSync(blob);
			if (sha256(content) !== h) throw new Error("hash mismatch");
			mkdirSync(dirname(join(cwd, f)), { recursive: true });
			writeFileSync(join(cwd, f), content);
			restored.push(f);
		} catch {
			failed.push(f);
		}
	}
	return { restored, failed };
}

export function violationsMarkdown(v: Violations): string {
	return [
		...v.changed.map((f) => `- 変更: ${f}`),
		...v.deleted.map((f) => `- 削除: ${f}`),
		...v.added.map((f) => `- 追加: ${f}`),
	].join("\n");
}

/** edit / write でロック中のテストファイルに書き込もうとしていないか（純粋関数） */
export function checkLockedWrite(lock: TestLock | undefined, path: string | undefined, cwd: string): { block: boolean; reason?: string } {
	if (!lock || !path) return { block: false };
	const rel = toRel(path, cwd);
	if (lock.allowed.includes(rel)) return { block: false };
	const locked = rel in lock.files;
	if (!locked && !(lock.mode === "green" && isLockable(rel))) return { block: false };
	const why =
		lock.mode === "green"
			? "Red で失敗を確かめたテストは、Green（実装）が合格するまで変更・追加できません。実装側で合格させてください。"
			: "レビューへ進んだ時点のテストは変更できません（新しいテストファイルの追加はできます）。";
	return {
		block: true,
		reason:
			`[piHarness] テストファイル ${rel} はロックされています。${why}` +
			"テストのほうが誤っている場合は、harness_request_test_change で対象ファイルと理由（根拠となる受け入れ条件）を示してユーザーの承認を得てください。",
	};
}
