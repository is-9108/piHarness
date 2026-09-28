---
name: harness-review
description: piHarness のフルレビュー（impl_review の 1 周目・合流後）。正しさ・要件・テスト・セキュリティ・性能(Pi 5)・保守性・運用性の多角的レビューを行い harness_record_review で記録する。
disable-model-invocation: true
---

# コードレビュー（フル）

実装者の会話は見えない。**実装レポートの主張を鵜呑みにせず、コードとテストで確かめる。** コードは変更しない（ブロックされる）。

## 共通ルール

- このセッションは 1 つのプロセスだけを担当する。前のプロセスの会話は無い。開始メッセージの**入力成果物を最初に読み**、推測で補わない。
- 次のプロセスが必要とすることは**すべて出力成果物に書く**。
- フェーズ遷移は harness_* ツールで行う。承認ゲート・ループ上限を迂回しない。「プロセス完了」と返されたら作業をやめ、成果を 1〜3 文で報告して終了する。

## 準備

1. 入力成果物を読む。判断基準は `issue.md` の受け入れ条件と `plan.md`。
2. 差分: 開始メッセージの `git diff <基準>`（未コミット含む）と `git status`（新規ファイル）。周辺コード（呼び出し元・先）も読む。必要ならテストを bash で実行。
3. `test-changes.md` があれば、テストの削除・スキップ等の**理由が妥当か必ず検証**し、妥当でなければ `tests` の blocker/major にする（「一時的に」は原則不可）。

## 観点（切り替えるたびに差分を読み直す。詳細: `references/perspectives.md`）

`requirements` 受け入れ条件・スコープ外の混入 / `correctness` 境界値・例外・並行性・リソース / `tests` 振る舞いの検証・異常系・偽陽性 /
`security` 入力検証・インジェクション・秘密情報 / `performance` Pi 5 の CPU・メモリ・書込み・発熱 / `maintainability` 命名・責務・重複・規約 / `operability` ログ・設定・互換性

## 重大度

`blocker` 誤動作・データ破損・脆弱性・何も検証しないテスト / `major` 受け入れ条件未達・重要な異常系の欠落・明確な設計問題・Pi で実用にならない性能 /
`minor` 動作に影響しない改善 / `nit` 好み。blocker/major が修正必須（`blockingSeverities` で変更可）。根拠のある事実だけを指摘し、重大度を水増ししない。

## 記録

`harness_record_review`（`summary`、`findings`: severity・perspective・title・detail・file・line・suggestion。無ければ `[]`）。
修正は別セッションが `review-N.md` だけを見て行うので、`detail` と `suggestion` に根拠・場所・修正案を書く。
指摘なしで完了した場合: 変更概要・受け入れ条件の充足・テスト結果・残した minor/nit・コミット/PR の結果・利用量を報告し、`/impl next` を案内する。
