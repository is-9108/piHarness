---
name: harness-review
description: 実装フローのコードレビュー手順。1周目は正しさ・要件充足・テスト・セキュリティ・性能(Raspberry Pi)・保守性の多角的フルレビュー、2周目以降は前回指摘の解消確認と差分中心の軽量レビューを行い、harness_record_review で記録する。impl_review フェーズで使う。
---

# コードレビュー（piHarness）

レビュー中はコードを変更しません（拡張がブロックします）。レビュー結果は必ず `harness_record_review` で記録します。
現在の周回とモード（フル / 軽量）は `harness_status` で確認できます（review 0 周実施済み = 次はフルレビュー）。

## 準備

1. 対象 Issue の受け入れ条件と承認済みプラン（`.pi/harness/plans/issue-<番号>.md`）を確認する。
2. 差分を取得する: `git status` / `git diff`（未コミットの変更）と、必要なら `git diff <base>...HEAD`。
3. 変更されたファイルは差分だけでなく周辺のコードも読む（呼び出し元・呼び出し先）。

## 1 周目: フルレビュー（多角的）

観点ごとに独立して見直す（1 つの観点に引きずられないよう、観点を切り替えるたびに差分を最初から読み直す）。詳細なチェック項目は `references/perspectives.md`。

| 観点 (perspective) | 見るもの |
|-------------------|---------|
| `requirements` | 受け入れ条件をすべて満たすか。スコープ外の変更が混ざっていないか |
| `correctness` | ロジック誤り、境界値、null/空、例外処理、並行性、リソースリーク |
| `tests` | テストが振る舞いを検証しているか。異常系・境界値。テストが実装の写しになっていないか。偽陽性 |
| `security` | 入力検証、コマンド/SQL インジェクション、パス操作、秘密情報の扱い、権限 |
| `performance` | Raspberry Pi 上での CPU/メモリ/SD カード書込み、不要なポーリング、巨大なデータの全読込 |
| `maintainability` | 命名、責務分割、重複、既存の規約・パターンとの一貫性、コメントの過不足 |
| `operability` | ログ、エラーメッセージ、設定、起動/停止（systemd）、後方互換性 |

## 2 周目以降: 軽量レビュー

時間をかけすぎないこと。以下だけを確認する:

1. 前回のブロッキング指摘（`.pi/harness/reviews/` の前回記録）がそれぞれ解消されたか。
2. 前回レビュー以降の差分に、新たな blocker/major が入っていないか（`correctness` / `tests` / `security` を中心に）。
3. 前回 minor/nit だった指摘は再掲しない。新規の minor/nit も原則記録しない。

## 重大度の基準

| severity | 基準 | 扱い |
|----------|------|-----|
| `blocker` | 誤動作・データ破損・セキュリティ脆弱性・テストが実質的に何も検証していない | 修正必須 |
| `major` | 受け入れ条件の未達、重要な異常系の欠落、明確な設計上の問題、ラズパイで実用にならない性能 | 修正必須 |
| `minor` | 改善したほうがよいが動作に影響しない | 報告のみ |
| `nit` | 好み・軽微なスタイル | 報告のみ |

（ブロッキング扱いの重大度は `.pi/harness.json` の `blockingSeverities` で変更可能）

指摘は「根拠のある事実」に限る。確信が無いものは実際にコードを読むかテストを書いて確認してから指摘する。重大度を水増し・過小評価しない。

## 記録

`harness_record_review` を呼ぶ:
- `summary`: 全体所見（良い点・懸念点を簡潔に）
- `findings`: `{severity, perspective, title, detail, file, line, suggestion}` の配列（無ければ `[]`）

結果:
- ブロッキング指摘なし → 実装完了（`impl_done`）。
- ブロッキング指摘あり → `impl_fix_review`。指摘を修正 → `harness_run_tests`（green）→ `harness_phase` で `impl_review` → 軽量レビュー。
- 3 周してもブロッキング指摘が残る → ユーザーへエスカレーション。ユーザーの選択に従う。
