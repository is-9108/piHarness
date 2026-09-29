import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Run } from "../extensions/harness/git.ts";
import {
	checkLockedWrite,
	findViolations,
	hasViolations,
	isLockable,
	listTestFiles,
	restoreFiles,
	snapshotFiles,
	type TestLock,
	toRel,
} from "../extensions/harness/testlock.ts";

function project(): string {
	const d = mkdtempSync(join(tmpdir(), "pih-lock-"));
	mkdirSync(join(d, "src"), { recursive: true });
	mkdirSync(join(d, "test/__snapshots__"), { recursive: true });
	mkdirSync(join(d, ".pi/harness"), { recursive: true });
	writeFileSync(join(d, "src/a.ts"), "export const a = 1;\n");
	writeFileSync(join(d, "src/a.test.ts"), "expect(a).toBe(1);\n");
	writeFileSync(join(d, "test/b.test.ts"), "expect(b).toBe(2);\n");
	writeFileSync(join(d, "test/__snapshots__/b.test.ts.snap"), "snap\n");
	writeFileSync(join(d, ".pi/harness/x.test.ts"), "harness\n");
	return d;
}

const lockOf = (files: Record<string, string>, mode: TestLock["mode"] = "green"): TestLock => ({ mode, at: "", files, allowed: [] });
const blobs = ".pi/harness/issue-1/test-lock";

describe("テストのロック", () => {
	it("ロックするのはテストファイルだけ（スナップショット・キャッシュ・除外パスは除く）", async () => {
		const d = project();
		assert.deepEqual(await listTestFiles(undefined, d, [".pi/harness"]), ["src/a.test.ts", "test/b.test.ts"]);
		assert.equal(isLockable("tests/__pycache__/test_a.cpython-311.pyc"), false);
		assert.equal(isLockable("tests/test_a.py"), true);
	});

	it("git リポジトリでは未追跡を含み、.gitignore のファイルを除く", async () => {
		const d = project();
		const git = (...args: string[]) => execFileSync("git", args, { cwd: d, encoding: "utf8" });
		git("init", "-q");
		writeFileSync(join(d, ".gitignore"), "test/ignored.test.ts\n");
		writeFileSync(join(d, "test/ignored.test.ts"), "x\n");
		git("add", "src/a.test.ts");
		const run: Run = async (cmd, args) => {
			try {
				return { code: 0, stdout: execFileSync(cmd, args, { cwd: d, encoding: "utf8" }), stderr: "" };
			} catch (e) {
				return { code: 1, stdout: "", stderr: String(e) };
			}
		};
		assert.deepEqual(await listTestFiles(run, d, [".pi/harness"]), ["src/a.test.ts", "test/b.test.ts"]);
	});

	it("bash などでの変更・削除を見つけてロック時の内容に戻す", () => {
		const d = project();
		const files = snapshotFiles(d, ["src/a.test.ts", "test/b.test.ts"], blobs);
		const lock = lockOf(files);
		assert.equal(hasViolations(findViolations(d, lock, ["src/a.test.ts", "test/b.test.ts"])), false);

		writeFileSync(join(d, "src/a.test.ts"), "expect(a).toBe(999);\n");
		rmSync(join(d, "test/b.test.ts"));
		writeFileSync(join(d, "test/c.test.ts"), "new\n");
		const v = findViolations(d, lock, ["src/a.test.ts", "test/c.test.ts"]);
		assert.deepEqual(v, { changed: ["src/a.test.ts"], deleted: ["test/b.test.ts"], added: ["test/c.test.ts"] });

		const r = restoreFiles(d, lock, [...v.changed, ...v.deleted], blobs);
		assert.deepEqual(r, { restored: ["src/a.test.ts", "test/b.test.ts"], failed: [] });
		assert.equal(readFileSync(join(d, "src/a.test.ts"), "utf8"), "expect(a).toBe(1);\n");
		assert.equal(readFileSync(join(d, "test/b.test.ts"), "utf8"), "expect(b).toBe(2);\n");
	});

	it("レビュー以降のロックでは新しいテストファイルの追加は違反にしない。承認済みのファイルは照合しない", () => {
		const d = project();
		const lock = lockOf(snapshotFiles(d, ["src/a.test.ts"], blobs), "review");
		writeFileSync(join(d, "test/c.test.ts"), "new\n");
		assert.equal(hasViolations(findViolations(d, lock, ["src/a.test.ts", "test/c.test.ts"])), false);
		writeFileSync(join(d, "src/a.test.ts"), "changed\n");
		assert.equal(hasViolations(findViolations(d, lock, [])), true);
		assert.equal(hasViolations(findViolations(d, { ...lock, allowed: ["src/a.test.ts"] }, [])), false);
	});

	it("保存した内容が壊れていれば戻さずに失敗として返す", () => {
		const d = project();
		const lock = lockOf(snapshotFiles(d, ["src/a.test.ts"], blobs));
		writeFileSync(join(d, blobs, lock.files["src/a.test.ts"]), "tampered\n");
		writeFileSync(join(d, "src/a.test.ts"), "changed\n");
		assert.deepEqual(restoreFiles(d, lock, ["src/a.test.ts"], blobs), { restored: [], failed: ["src/a.test.ts"] });
		assert.equal(readFileSync(join(d, "src/a.test.ts"), "utf8"), "changed\n");
	});

	it("edit / write のブロック: Green 合格までは全テストファイル、レビュー以降はロックしたファイルだけ", () => {
		const cwd = "/repo";
		const green = lockOf({ "src/a.test.ts": "h" });
		assert.equal(checkLockedWrite(green, "src/a.test.ts", cwd).block, true);
		assert.equal(checkLockedWrite(green, "/repo/test/new.test.ts", cwd).block, true, "Green 合格前はテストの追加も不可");
		assert.equal(checkLockedWrite(green, "src/a.ts", cwd).block, false);
		assert.match(checkLockedWrite(green, "./src/a.test.ts", cwd).reason ?? "", /harness_request_test_change/);

		const review = lockOf({ "src/a.test.ts": "h" }, "review");
		assert.equal(checkLockedWrite(review, "src/a.test.ts", cwd).block, true);
		assert.equal(checkLockedWrite(review, "test/new.test.ts", cwd).block, false, "レビュー以降は新しいテストを追加できる");
		assert.equal(checkLockedWrite({ ...review, allowed: ["src/a.test.ts"] }, "/repo/src/a.test.ts", cwd).block, false, "承認済み");
		assert.equal(checkLockedWrite(undefined, "src/a.test.ts", cwd).block, false);
		assert.equal(toRel("/repo/./src/../src/a.test.ts", cwd), "src/a.test.ts");
	});
});
