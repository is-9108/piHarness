---
name: harness-tdd
description: piHarness の TDD 実装（impl_tdd）。承認済みの plan.md に従い Red→Green→Refactor で実装し、implementation.md を書く。
disable-model-invocation: true
---

# TDD 実装

## 共通ルール

- このセッションは 1 つのプロセスだけを担当する。前のプロセスの会話は無い。開始メッセージの**入力成果物を最初に読み**、推測で補わない。
- 次のプロセスが必要とすることは**すべて出力成果物に書く**。
- フェーズ遷移は harness_* ツールで行う。承認ゲート・ループ上限を迂回しない。「プロセス完了」と返されたら作業をやめ、成果を 1〜3 文で報告して終了する。
- **自分でコミット・push・ブランチ操作をしない**（完了時に拡張が行う）。自分の変更は開始メッセージの `git diff <基準>` で確認できる。

## サイクル（テストケースごと）

1. **Red**: 失敗するテストを 1 つ書く → `harness_run_tests`（`expect: "red"`）。失敗理由が「未実装」であること（構文/import エラーは不可）。合格したらテストを見直す。
2. **Green**: 最小限の実装 → `harness_run_tests`（`expect: "green"`）。
3. **Refactor**: 振る舞いを変えずに整理 → `expect: "green"`。

- 個別テストは bash で回してよいが、判定に使われるのは `harness_run_tests`（全体 + `checkCommands` の lint/型チェック）だけ。合格時の出力は要約のみ返る（全文は logs/）。
- 合格後にファイルを変更すると（bash 経由も含む）再テストが必要。
- テストファイルの削除・スキップ/`.only` の追加・アサーション減少はレビューへの遷移で止められる。意図しないなら戻す。正当な場合だけ `harness_phase` の `testChangeReason` に理由を書く（レビューで検証される）。

## 失敗時（連続 3 回でユーザーへエスカレーション）

修正の前に必ず書く: 1) 失敗したテストとエラー 2) 根本原因の仮説と確認方法 3) 確認結果 4) 最小限の修正 → 再実行（`reason` に要約）。
同じ修正を繰り返さない。エスカレーションされたら表示された選択に従う（手動対応・中止なら止めて報告）。

## 完了

全テストケース実装済み・最後の green 合格後に未変更なら、`templates/implementation.md` に従い **`implementation.md`** を日本語で書き（レビューはこれと差分だけを見る。**見出しは変えない**: PR 本文に使われる）、`harness_phase` で `impl_review` へ。
