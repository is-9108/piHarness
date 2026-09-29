---
name: harness-issues
description: piHarness の Issue 登録（req_issues）。承認済みの Issue 分割案から、機能単位の小さな GitHub Issue を登録する。
disable-model-invocation: true
---

# Issue 登録

## 共通ルール

- このセッションは 1 つのプロセスだけを担当する。前のプロセスの会話は無い。開始メッセージの**入力成果物を最初に読み**、推測で補わない。
- 次のプロセスが必要とすることは**すべて出力成果物に書く**。
- フェーズ遷移は harness_* ツールで行う。承認ゲート・ループ上限を迂回しない。「プロセス完了」と返されたら作業をやめ、成果を 1〜3 文で報告して終了する。

## 手順

1. 承認済みの Issue 分割案と要件定義書を読む（`hearing.md` は必要なときだけ）。承認コメントがあれば反映する。
2. `harness_create_issues` で登録する:
   - 1 Issue = 1 振る舞い。本文は項目（`background`・`inScope`・`outOfScope`・`acceptanceCriteria`・`testNormal`・`testEdge`・`references`・`notes`）で渡し、拡張がテンプレートで組み立てる。**Issue 本文だけで実装に着手できる**ように書く（実装も別セッションで本文だけを読む）。
   - タイトル・各項目は**日本語**。受け入れ条件は 1 項目 = 1 条件（番号 AC-1… は拡張が付ける）。
   - `size` は S（〜100 行）か M（〜300 行）。L 相当・受け入れ条件が多すぎるものは拒否されるので分割する（ルール: `../harness-requirements/references/issue-splitting.md`）。
   - 依存は `dependsOn`（配列内の前方インデックス）。着手順に並べる。
3. 登録結果（番号・タイトル・依存）と推奨着手順を報告し、`/impl next` で次の Issue から実装を始められること、`/harness issues` で進み具合を見られることを伝える。
