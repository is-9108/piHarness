import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { branchName, diffTrees, snapshotTree, commitAll, currentBranch, diffSince, dirtyFiles, fingerprint, isGitRepo, prepareBranch, pullBaseBranch, type Run } from "../extensions/harness/git.ts";

function repo(): { dir: string; run: Run; git: (...a: string[]) => string } {
	const dir = mkdtempSync(join(tmpdir(), "pih-git-"));
	const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" }).trim();
	git("init", "-q", "-b", "main");
	git("config", "user.name", "t");
	git("config", "user.email", "t@example.com");
	writeFileSync(join(dir, "a.js"), "1\n");
	mkdirSync(join(dir, "test"));
	writeFileSync(join(dir, "test/a.test.js"), "it('a', () => { expect(1).toBe(1); });\n");
	git("add", "-A");
	git("commit", "-q", "-m", "init");
	const run: Run = async (cmd, args) => {
		const r = spawnSync(cmd, args, { cwd: dir, encoding: "utf8" });
		return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
	};
	return { dir, run, git };
}

const EX = [".pi/harness"];

/** origin（bare）と、そこから clone した利用者の作業リポジトリ・別の開発者のリポジトリ */
function withOrigin() {
	const me = repo();
	const origin = mkdtempSync(join(tmpdir(), "pih-origin-"));
	execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
	me.git("remote", "add", "origin", origin);
	me.git("push", "-q", "-u", "origin", "main");
	const other = mkdtempSync(join(tmpdir(), "pih-other-"));
	execFileSync("git", ["clone", "-q", origin, other]);
	const og = (...a: string[]) => execFileSync("git", a, { cwd: other, encoding: "utf8" }).trim();
	og("config", "user.name", "o");
	og("config", "user.email", "o@example.com");
	const pushFromOther = (file: string) => {
		writeFileSync(join(other, file), `${file}\n`);
		og("add", "-A");
		og("commit", "-q", "-m", file);
		og("push", "-q", "origin", "main");
		return og("rev-parse", "HEAD");
	};
	return { ...me, pushFromOther };
}

describe("git", () => {
	it("作業ツリーの指紋は bash 等での変更・新規ファイルで変わり、除外ディレクトリの変更では変わらない", async () => {
		const { dir, run } = repo();
		const fp0 = await fingerprint(run, dir, EX);
		assert.ok(fp0);
		assert.equal(await fingerprint(run, dir, EX), fp0, "変更が無ければ同じ");
		mkdirSync(join(dir, ".pi/harness/logs"), { recursive: true });
		writeFileSync(join(dir, ".pi/harness/logs/t.log"), "log");
		assert.equal(await fingerprint(run, dir, EX), fp0, "成果物ディレクトリは対象外");
		appendFileSync(join(dir, "a.js"), "2\n");
		const fp1 = await fingerprint(run, dir, EX);
		assert.notEqual(fp1, fp0);
		writeFileSync(join(dir, "new.js"), "x");
		const fp2 = await fingerprint(run, dir, EX);
		assert.notEqual(fp2, fp1, "未追跡ファイルの追加も検知");
		writeFileSync(join(dir, "new.js"), "y");
		assert.notEqual(await fingerprint(run, dir, EX), fp2, "未追跡ファイルの内容変更も検知");
	});

	it("git リポジトリでなければ指紋は undefined", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pih-nogit-"));
		const run: Run = async (cmd, args) => {
			const r = spawnSync(cmd, args, { cwd: dir, encoding: "utf8" });
			return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
		};
		assert.equal(await isGitRepo(run), false);
		assert.equal(await fingerprint(run, dir, EX), undefined);
	});

	it("作業ブランチの作成・再開と差分の基準", async () => {
		const { dir, run, git } = repo();
		const base = git("rev-parse", "HEAD");
		const info = await prepareBranch(run, "issue-3-login");
		assert.deepEqual(info, { base, baseBranch: "main", branch: "issue-3-login" });
		assert.equal(await currentBranch(run), "issue-3-login");
		writeFileSync(join(dir, "b.js"), "b");
		git("add", "-A");
		git("commit", "-q", "-m", "wip");
		git("switch", "-q", "main");
		const again = await prepareBranch(run, "issue-3-login");
		assert.equal(again.base, base, "既存ブランチの再開では main との merge-base を基準にする");
		assert.equal(await currentBranch(run), "issue-3-login");
	});

	it("別の作業ブランチ上からでも指定したブランチ（既定ブランチ）から作成し、同じブランチでの再開は既定ブランチ基準", async () => {
		const { dir, run, git } = repo();
		const mainHead = git("rev-parse", "HEAD");
		await prepareBranch(run, "issue-1");
		writeFileSync(join(dir, "one.js"), "1");
		git("add", "-A");
		git("commit", "-q", "-m", "one");
		const info = await prepareBranch(run, "issue-2", "main");
		assert.deepEqual(info, { base: mainHead, baseBranch: "main", branch: "issue-2" });
		assert.equal(git("merge-base", "HEAD", "main"), mainHead);
		assert.equal(git("rev-parse", "HEAD"), mainHead, "issue-1 の変更を含まない");
		git("switch", "-q", "issue-1");
		const resume = await prepareBranch(run, "issue-1");
		assert.deepEqual(resume, { base: mainHead, baseBranch: "main", branch: "issue-1" });
	});

	it("開始元ブランチを origin から pull する（main 上でも別ブランチ上でも）", async () => {
		const { run, git, pushFromOther } = withOrigin();
		assert.equal((await pullBaseBranch(run, "main")).status, "up-to-date");
		const remote1 = pushFromOther("b.js");
		const r1 = await pullBaseBranch(run, "main");
		assert.equal(r1.status, "updated");
		assert.equal(git("rev-parse", "main"), remote1, "main 上では pull --ff-only");
		git("switch", "-q", "-c", "issue-1");
		const remote2 = pushFromOther("c.js");
		assert.equal((await pullBaseBranch(run, "main")).status, "updated");
		assert.equal(git("rev-parse", "main"), remote2, "別ブランチ上でもローカルの main を進める");
		assert.equal(git("rev-parse", "--abbrev-ref", "HEAD"), "issue-1", "現在のブランチは変えない");
		const info = await prepareBranch(run, "issue-2", "main");
		assert.equal(info.base, remote2, "最新の main から作業ブランチを作る");
	});

	it("origin が無ければ何もせず、早送りできなければ失敗を返す", async () => {
		assert.equal((await pullBaseBranch(repo().run, "main")).status, "no-remote");
		const { run, git, dir, pushFromOther } = withOrigin();
		pushFromOther("b.js");
		writeFileSync(join(dir, "local.js"), "x\n");
		git("add", "-A");
		git("commit", "-q", "-m", "local only");
		const r = await pullBaseBranch(run, "main");
		assert.equal(r.status, "failed");
		assert.match(r.status === "failed" ? r.error : "", /origin と揃えて/);
	});

	it("ブランチ名は英数字のタイトルだけを使う", () => {
		assert.equal(branchName("issue-", { number: 12, title: "Add login API" }), "issue-12-add-login-api");
		assert.equal(branchName("issue-", { number: 12, title: "ログイン API を追加" }), "issue-12-api");
		assert.equal(branchName("issue-", { number: 7, title: "温度ロガー" }), "issue-7");
		assert.equal(branchName("feat/", { file: "docs/issues/01-センサー読み取り.md", title: "センサー読み取り" }), "feat/01");
	});

	it("除外ディレクトリを含めずにコミットし、変更が無ければ何もしない", async () => {
		const { dir, run, git } = repo();
		mkdirSync(join(dir, ".pi/harness/issue-1"), { recursive: true });
		writeFileSync(join(dir, ".pi/harness/issue-1/plan.md"), "plan");
		assert.equal(await commitAll(run, EX, "nothing"), undefined);
		writeFileSync(join(dir, "a.js"), "changed\n");
		const sha = await commitAll(run, EX, "Add a (#1)\n\nCloses #1");
		assert.equal(sha, git("rev-parse", "HEAD"));
		assert.equal(git("log", "-1", "--format=%s"), "Add a (#1)");
		assert.match(git("log", "-1", "--format=%b"), /Closes #1/);
		assert.deepEqual(await dirtyFiles(run, EX), []);
		assert.match(git("status", "--porcelain"), /\.pi\//, "成果物は未コミットのまま");
	});

	it("作業ツリーのスナップショット間の差分（未追跡ファイルを含み、インデックスは汚さない）", async () => {
		const { dir, run, git } = repo();
		const idx = join(dir, "..", `idx-${Date.now()}`);
		writeFileSync(join(dir, "a.js"), "v1\n");
		const t1 = await snapshotTree(run, idx, EX);
		assert.match(t1 ?? "", /^[0-9a-f]{40}$/);
		assert.equal(await snapshotTree(run, idx, EX), t1, "変更が無ければ同じ tree");
		writeFileSync(join(dir, "a.js"), "v2\n");
		writeFileSync(join(dir, "new.js"), "n\n");
		mkdirSync(join(dir, ".pi/harness"), { recursive: true });
		writeFileSync(join(dir, ".pi/harness/x.md"), "x");
		const t2 = await snapshotTree(run, idx, EX);
		const d = await diffTrees(run, t1!, t2!);
		assert.match(d, /^-v1$/m);
		assert.match(d, /^\+v2$/m);
		assert.match(d, /new\.js/);
		assert.doesNotMatch(d, /\.pi\/harness/);
		assert.equal(await diffTrees(run, t2!, t2!), "");
		assert.equal(git("diff", "--cached", "--name-only"), "", "ユーザーのインデックスは変わらない");
	});

	it("base からの差分に未追跡ファイルと削除を含める", async () => {
		const { dir, run, git } = repo();
		const base = git("rev-parse", "HEAD");
		rmSync(join(dir, "test/a.test.js"));
		writeFileSync(join(dir, "test/b.test.js"), "it.skip('b', () => {});\n");
		const { nameStatus, patch } = await diffSince(run, base, EX, dir);
		assert.match(nameStatus, /^D\ttest\/a\.test\.js$/m);
		assert.match(nameStatus, /^A\ttest\/b\.test\.js$/m);
		assert.match(patch, /^\+it\.skip\('b'/m);
	});
});
