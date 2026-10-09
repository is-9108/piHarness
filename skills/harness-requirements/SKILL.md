---
name: harness-requirements
description: piHarness の要件定義書作成（req_document / req_approval）。hearing.md から要件定義書・設計概要・Issue 分割案を作り、人間の承認を得る。
disable-model-invocation: true
---

# 要件定義書作成と承認

## 共通ルール

- このセッションは 1 つのプロセスだけを担当する。前のプロセスの会話は無い。開始メッセージの**入力成果物を最初に読み**、推測で補わない。
- 次のプロセスが必要とすることは**すべて出力成果物に書く**。
- フェーズ遷移は harness_* ツールで行う。承認ゲート・ループ上限を迂回しない。「プロセス完了」と返されたら作業をやめ、成果を 1〜3 文で報告して終了する。
- **重要な設計判断をしたら `harness_record_decision` で ADR を記録する**（対象はツールの説明のとおり）。判断の前に開始メッセージの ADR 一覧で関連するものを確認して従い、変えるなら `supersedes` で置き換える。成果物からは ADR 番号で参照する。

## 手順

1. `hearing.md` を読む。根拠を確かめたいときだけ `qa.md`（質問と回答の生ログ）を参照する。
2. `docs/`（`.pi/harness.json` の `docsDir`）に作成する:

| ファイル | テンプレート |
|---|---|
| `docs/requirements/<slug>.md` 要件定義書（必須） | `templates/requirements.md` |
| `docs/design/<slug>.md` 設計概要（必要なら） | `templates/design.md` |
| `docs/requirements/<slug>-issues.md` Issue 分割案（必須） | `templates/issue-plan.md` |

   - 要件に ID（FR-001, NFR-001…）を振る。Issue 分割は `references/issue-splitting.md` のルールに**厳密に**従う（1 Issue = 1 振る舞い、規模 S/M のみ、受け入れ条件は 5 個以下）。
   - `hearing.md` に無いことを推測で埋めない。1〜2 点の小さな確認なら `harness_ask`。それ以上は **`open-questions.md`** に論点（理由・候補案）を書き、`harness_phase` で `req_clarify` へ差し戻す（書きかけのドキュメントは残してよい）。
3. `harness_request_approval`（`kind: "requirements"`、`summary`: 目的・スコープ・主要な決定・Issue 数と着手順・リスク、`documents`: 作成したファイル）。
   - 修正依頼 → このセッションで反映して再依頼。大きな論点ならヒアリングへ差し戻す。
   - 保留 / UI なし → 作業を止めて `/harness approve` を待つ。
   - 承認 → Issue 登録は新しいセッションで行われる。承認前に Issue を登録しない。
