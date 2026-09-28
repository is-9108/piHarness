/**
 * テストを弱めていないかの検知（純粋関数）。
 * base からの差分を見て、テストファイルの削除・スキップ/フォーカスの追加・アサーションの減少を検出する。
 */

export type IntegrityKind = "deleted_test_file" | "skip_added" | "focus_added" | "assertions_reduced";

export interface IntegrityFinding {
	kind: IntegrityKind;
	file: string;
	detail: string;
}

const TEST_FILE_PATTERNS: RegExp[] = [
	/(^|\/)(test|tests|__tests__|spec|specs)\//,
	/\.(test|spec)\.[cm]?[jt]sx?$/,
	/_test\.(go|py|rb|exs?)$/,
	/(^|\/)test_[^/]*\.py$/,
	/Tests?\.(java|kt|cs|swift)$/,
	/_spec\.rb$/,
];

export function isTestFile(path: string): boolean {
	return TEST_FILE_PATTERNS.some((p) => p.test(path));
}

/** テストを無効化する記述 */
const SKIP_PATTERNS: RegExp[] = [
	/\b(it|test|describe|context|suite)\.skip\b/,
	/\b(xit|xtest|xdescribe|xcontext)\s*\(/,
	/\b(it|test)\.todo\s*\(/,
	/\{\s*skip\s*:\s*true\s*\}/,
	/@pytest\.mark\.(skip|skipif|xfail)\b/,
	/\bpytest\.skip\s*\(/,
	/@unittest\.(skip|skipIf|skipUnless|expectedFailure)\b/,
	/\bt\.Skip(f|Now)?\s*\(/,
	/#\[ignore\]/,
	/@(Disabled|Ignore)\b/,
];

/** 一部のテストだけを実行させる記述（残りのテストが実行されなくなる） */
const FOCUS_PATTERNS: RegExp[] = [/\b(it|test|describe|context|suite)\.only\b/, /\b(fit|fdescribe|fcontext)\s*\(/, /\{\s*only\s*:\s*true\s*\}/];

const ASSERTION = /\b(expect|assert\w*|should|verify)\b|\bt\.(Error|Errorf|Fatal|Fatalf|Fail)\b|\bassert(_eq|_ne)?!/;

interface FileLines {
	added: string[];
	removed: string[];
}

/** unified diff を「ファイルごとの追加行・削除行」に分解する */
export function parsePatch(patch: string): Map<string, FileLines> {
	const files = new Map<string, FileLines>();
	let current: FileLines | undefined;
	for (const line of patch.split("\n")) {
		const header = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
		if (header) {
			current = { added: [], removed: [] };
			files.set(header[2], current);
			continue;
		}
		if (!current || line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+")) current.added.push(line.slice(1));
		else if (line.startsWith("-")) current.removed.push(line.slice(1));
	}
	return files;
}

const count = (lines: string[], patterns: RegExp[]) => lines.filter((l) => patterns.some((p) => p.test(l))).length;

export function analyzeTestDiff(nameStatus: string, patch: string): IntegrityFinding[] {
	const findings: IntegrityFinding[] = [];
	for (const line of nameStatus.split("\n").filter(Boolean)) {
		const [status, path] = line.split("\t");
		if (status === "D" && path && isTestFile(path)) {
			findings.push({ kind: "deleted_test_file", file: path, detail: "テストファイルが削除されています" });
		}
	}
	for (const [file, { added, removed }] of parsePatch(patch)) {
		if (!isTestFile(file)) continue;
		const skips = count(added, SKIP_PATTERNS) - count(removed, SKIP_PATTERNS);
		if (skips > 0) findings.push({ kind: "skip_added", file, detail: `テストのスキップ/無効化が ${skips} 箇所追加されています` });
		const focus = count(added, FOCUS_PATTERNS) - count(removed, FOCUS_PATTERNS);
		if (focus > 0) findings.push({ kind: "focus_added", file, detail: `.only 等で一部のテストだけを実行する記述が ${focus} 箇所追加されています` });
		const lost = count(removed, [ASSERTION]) - count(added, [ASSERTION]);
		if (lost > 0) findings.push({ kind: "assertions_reduced", file, detail: `アサーションが差し引き ${lost} 行減っています` });
	}
	return findings;
}

/** 同じ内容の検出結果を二度確認させないための署名 */
export function signature(findings: IntegrityFinding[]): string {
	return findings
		.map((f) => `${f.kind}:${f.file}:${f.detail}`)
		.sort()
		.join("\n");
}

export function findingsMarkdown(findings: IntegrityFinding[]): string {
	return findings.map((f) => `- [${f.kind}] ${f.file}: ${f.detail}`).join("\n");
}
