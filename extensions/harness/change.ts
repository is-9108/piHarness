/**
 * 設定変更フローの完了前の確認（純粋関数）。
 * テストもレビューも無い代わりに、変更したファイルが承認された計画の範囲かと、JSON が壊れていないかを拡張が確かめる。
 */
import { isAbsolute, normalize, relative, resolve } from "node:path";

/** cwd からの相対パスにそろえる */
function rel(cwd: string, path: string): string {
	return normalize(relative(cwd, isAbsolute(path) ? path : resolve(cwd, path)));
}

/** 承認されたファイル以外の変更 */
export function outOfScope(changed: string[], approved: string[], cwd: string): string[] {
	const allowed = new Set(approved.map((f) => rel(cwd, f)));
	return changed.filter((f) => !allowed.has(rel(cwd, f)));
}

/**
 * JSONC（コメント・末尾のカンマ）を JSON にする。tsconfig.json や .vscode/settings.json はコメントを含むことがあるため。
 * 文字列の中の // や /* は消さない。
 */
export function stripJsonc(text: string): string {
	let out = "";
	let i = 0;
	while (i < text.length) {
		const c = text[i];
		if (c === '"') {
			let j = i + 1;
			while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
			out += text.slice(i, j + 1);
			i = j + 1;
		} else if (c === "/" && text[i + 1] === "/") {
			while (i < text.length && text[i] !== "\n") i++;
		} else if (c === "/" && text[i + 1] === "*") {
			const end = text.indexOf("*/", i + 2);
			i = end < 0 ? text.length : end + 2;
		} else {
			out += c;
			i++;
		}
	}
	return out.replace(/,(\s*[}\]])/g, "$1");
}

/** JSON として読めない .json ファイル（コメント・末尾のカンマは許す）。contents に無いファイル（削除）は対象外 */
export function invalidJson(contents: Record<string, string>): { file: string; error: string }[] {
	const errors: { file: string; error: string }[] = [];
	for (const [file, text] of Object.entries(contents)) {
		if (!/\.json$/i.test(file)) continue;
		try {
			JSON.parse(text);
		} catch {
			try {
				JSON.parse(stripJsonc(text));
			} catch (e) {
				errors.push({ file, error: (e as Error).message });
			}
		}
	}
	return errors;
}
