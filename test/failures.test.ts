import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyzeOutput, type CommandFailure, failureFingerprint, normalizeLine, onlyBaselineFailures } from "../extensions/harness/failures.ts";

const fail = (command: string, output: string, killed = false): CommandFailure => ({ command, killed, ...analyzeOutput(output, "/home/pi/app") });

describe("失敗の行と指紋", () => {
	it("実行ごとに変わる値（時間・数値・絶対パス・色）を取り除く", () => {
		assert.equal(normalizeLine("\u001b[31m✖ adds (12.5ms)\u001b[0m"), "✖ adds (T)");
		assert.equal(normalizeLine("at /home/pi/app/src/a.ts:12:5", "/home/pi/app"), "at ./src/a.ts:N:N");
		assert.equal(normalizeLine("at /usr/lib/node/x.js:1:2"), "at …/x.js:N:N");
		assert.equal(normalizeLine("src/a/b.ts:3 error"), "src/a/b.ts:N error", "相対パスはそのまま");
	});

	it("主なランナーの失敗の行を取り出す（合格の行・npm のラッパーの行は除く）", () => {
		const vitest = [
			"> app@1.0.0 test",
			"> vitest run",
			" ✓ src/ok.test.ts (3 tests) 12ms",
			" FAIL  src/login.test.ts > login > rejects empty password",
			"AssertionError: expected 200 to be 400",
			" Test Files  1 failed | 1 passed (2)",
			"npm error Lifecycle script `test` failed with error:",
			"npm error code 1",
		].join("\n");
		const r = analyzeOutput(vitest);
		assert.equal(r.recognized, true);
		assert.deepEqual(r.lines, [
			"AssertionError: expected N to be N",
			"FAIL src/login.test.ts > login > rejects empty password",
			"Test Files N failed | N passed (N)",
		]);
		const pytest = analyzeOutput("tests/test_a.py::test_ok PASSED\nFAILED tests/test_a.py::test_b - assert 1 == 2\n1 failed, 3 passed in 0.12s");
		assert.deepEqual(pytest.lines, ["FAILED tests/test_a.py::test_b - assert N == N", "N failed, N passed in T"]);
		const go = analyzeOutput("--- FAIL: TestParse (0.00s)\n    parse_test.go:12: got 1\nFAIL\tgithub.com/x/y\t0.004s");
		assert.ok(go.lines.includes("--- FAIL: TestParse (T)"));
	});

	it("失敗の行が無ければ出力の末尾で代用し、recognized を false にする", () => {
		const r = analyzeOutput("> demo@1.0.0 test\n> node check.js\nnpm error code 1\n");
		assert.equal(r.recognized, false);
		assert.deepEqual(r.lines, []);
		assert.equal(analyzeOutput("done\nexit 3").recognized, false);
		assert.deepEqual(analyzeOutput("done\nexit 3").lines, ["done", "exit N"]);
	});

	it("同じ失敗なら時間や行番号が変わっても指紋は同じ。別の失敗なら変わる", () => {
		const a = fail("npm test", "✖ adds (12ms)\nat /home/pi/app/src/a.ts:10:3");
		const b = fail("npm test", "✖ adds (48ms)\nat /home/pi/app/src/a.ts:11:3");
		const c = fail("npm test", "✖ subtracts (12ms)");
		assert.equal(failureFingerprint([a]), failureFingerprint([b]));
		assert.notEqual(failureFingerprint([a]), failureFingerprint([c]));
		assert.notEqual(failureFingerprint([a]), failureFingerprint([{ ...a, command: "npm run lint" }]));
		assert.equal(failureFingerprint([a, c]), failureFingerprint([{ ...c }, { ...a }]), "コマンドの順序によらない");
	});
});

describe("ベースラインの除外", () => {
	const base = fail("npm test", "not ok 3 - legacy parser\n# fail 1");

	it("開始時点と同じ失敗だけなら除外する", () => {
		assert.equal(onlyBaselineFailures(fail("npm test", "not ok 7 - legacy parser\n# fail 1"), base), true);
	});

	it("新しい失敗が加わっていれば除外しない", () => {
		assert.equal(onlyBaselineFailures(fail("npm test", "not ok 3 - legacy parser\nnot ok 4 - new feature\n# fail 2"), base), false);
	});

	it("失敗を特定できない出力・タイムアウト・ベースラインに無いコマンドは除外しない", () => {
		const opaque = fail("npm test", "npm error code 1");
		assert.equal(onlyBaselineFailures(opaque, opaque), false);
		assert.equal(onlyBaselineFailures(fail("npm test", "not ok 3 - legacy parser\n# fail 1", true), base), false);
		assert.equal(onlyBaselineFailures(fail("npm test", "not ok 3 - legacy parser"), undefined), false);
	});
});
