/**
 * テキスト整形の小さなヘルパー（純粋関数）。
 */

/** 末尾 maxLines 行を残して切り詰める（テスト失敗の要因は末尾に出ることが多い） */
export function tailLines(text: string, maxLines: number): { text: string; truncated: number } {
	const lines = text.replace(/\s+$/, "").split("\n");
	if (lines.length <= maxLines) return { text: lines.join("\n"), truncated: 0 };
	const truncated = lines.length - maxLines;
	return { text: lines.slice(-maxLines).join("\n"), truncated };
}

export function slugify(text: string, max = 40): string {
	const slug = text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, max)
		.replace(/-+$/g, "");
	return slug || "item";
}

export function timestamp(d = new Date()): string {
	return d.toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 23);
}
