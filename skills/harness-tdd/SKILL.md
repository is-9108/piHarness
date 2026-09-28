---
name: harness-tdd
description: TDDベースの実装フロー。GitHub Issueとコードベースを読み込み、テストプランと実装プランを作成して人間の承認を得てから、Red→Green→Refactorで実装する。テスト失敗は原因分析→修正→再テストを最大3周、その後多角的コードレビューを最大3周行う。/impl 実行時やIssueを実装するときに使う。
---

# TDD 実装フロー（piHarness）

piHarness 拡張がフェーズ・承認・ループ回数を管理しています。現在の状態は `harness_status` で確認できます。
**承認ゲートとループ上限を迂回しないこと**（テストを弱める・スキップする・削除して合格させるのも迂回です）。

```
impl_context → impl_plan → impl_plan_approval ─(承認)→ impl_tdd ─(全テスト green)→ impl_review ─(指摘なし)→ impl_done
                   ▲              │                    │  ▲                        │   ▲
                   └──(修正依頼)───┘                    └──┘ 失敗: 分析→修正→再テスト    ▼   │ 軽量レビュー
                                                       (連続3回失敗でエスカレーション)   impl_fix_review
                                                                              (3周しても指摘が残ればエスカレーション)
```

## 1. Issue とコードベースの読み込み（impl_context）

まだコードを変更してはいけません（拡張が `.pi/harness/` 以外への書き込みをブロックします）。

1. Issue 本文（背景・スコープ・**受け入れ条件**・テスト観点・参照ドキュメント）を読む。本文が渡されていなければ `gh issue view <番号>` または `docs/issues/` を読む。
2. 参照されている要件定義書・設計書（`docs/requirements/`, `docs/design/`）を読む。
3. コードベースを調査する:
   - ディレクトリ構成、エントリポイント、変更対象になりそうなモジュールと呼び出し元
   - 既存テストの場所・フレームワーク・命名規則・モックの流儀
   - Lint/フォーマッタ設定、コーディング規約（AGENTS.md / CONTRIBUTING.md 等）
   - テストコマンド（`/harness config` で確認できる testCommand）
4. Issue の記述が曖昧・矛盾している場合は `harness_ask` でユーザーに確認する。
5. `harness_phase` で `impl_plan` へ（note に調査結果の要約）。

## 2. テストプランと実装プラン（impl_plan）

`templates/plan.md` に従い `.pi/harness/plans/issue-<番号>.md` を作成する。

- **テストプラン**: 受け入れ条件ごとにテストケースを列挙（正常系・異常系・境界値）。テストの種類（ユニット/結合）、置き場所、モック対象を明記。
- **実装プラン**: 変更ファイル・追加する関数/クラス・手順（テストケースとの対応）。Raspberry Pi 上での性能・メモリへの影響も記載。
- **スコープ外**: Issue の範囲外で気づいたことは書き出すだけにして実装しない。

`harness_request_approval`（`kind: "plan"`, `documents: [".pi/harness/plans/issue-<番号>.md"]`）で承認を依頼する。
- 修正依頼 → 反映して再依頼。
- 保留 / UI なし → 作業を止めて `/harness approve` を待つ。

## 3. TDD 実装（impl_tdd）

承認されたプランのテストケースを 1 つずつ次のサイクルで進める:

1. **Red**: 失敗するテストを 1 つ書く → `harness_run_tests`（`expect: "red"`）。
   - 失敗理由が「未実装」によるものであることを確認する（構文エラーや import ミスによる失敗は Red とみなさない）。
   - 合格してしまったら、テストが振る舞いを捉えていない。テストを見直す。
2. **Green**: テストを通す最小限の実装を行う → `harness_run_tests`（`expect: "green"`）。
3. **Refactor**: 重複除去・命名改善。振る舞いは変えない → `harness_run_tests`（`expect: "green"`）。

個別テストだけを速く回したい場合は bash で直接実行してよい（ラズパイでは有効）。ただしループ判定・フェーズ遷移に使われるのは `harness_run_tests`（スイート全体）の結果のみ。

### テスト失敗時のループ（最大 3 周）

`expect: "green"` での失敗は修正ループとして数えられます。毎回、以下を**明示的に書いてから**修正する:

1. 失敗したテスト名とエラーメッセージ（ログは `.pi/harness/logs/` に全文あり）
2. 根本原因の仮説（なぜそうなるか）と、それを確かめる方法
3. 仮説の確認結果
4. 最小限の修正内容 → `harness_run_tests` を再実行（`reason` に 1〜4 の要約）

同じ修正を繰り返さないこと。前回の仮説が外れたら別の角度から分析する。
**連続 3 回失敗するとユーザーへエスカレーション**されます。表示された選択（ループ継続 / バグ修正フロー / 手動対応 / 中止）に従い、手動対応・中止の場合は作業を止めて状況を報告します。

### 完了条件

プランの全テストケースが実装済みで、最後の `harness_run_tests`（green）が合格し、その後ファイルを変更していないこと。
→ `harness_phase` で `impl_review` へ。

## 4. コードレビュー（impl_review / impl_fix_review）

skill `harness-review` の SKILL.md を読み、その手順でレビューして `harness_record_review` で記録する。

- 1 周目: 多角的なフルレビュー。
- ブロッキング指摘（blocker/major）があれば `impl_fix_review` へ → 指摘を修正 → `harness_run_tests`（green。ここでもテスト失敗ループは最大 3 周）→ `harness_phase` で `impl_review` → **2 周目以降は軽量レビュー**。
- ブロッキング指摘が無くなれば `impl_done`。
- **3 周してもブロッキング指摘が残る場合はユーザーへエスカレーション**されます。

## 5. 完了報告（impl_done）

以下をユーザーに報告する:
- 変更したファイルと概要、Issue の受け入れ条件ごとの充足状況
- テスト結果（最終実行ログのパス）
- レビュー結果（`.pi/harness/reviews/`）と、残した minor/nit 指摘（必要なら別 Issue 化を提案）
- コミットや PR 作成はユーザーの指示があった場合のみ行う

## バグ修正フローからの合流

エスカレーション後にユーザーがバグ修正フロー（`harness-bugfix`）を選んだ場合、完了後に `impl_review` へ合流します。バグ修正でコードが変わっているため、合流後はフルレビューから再開します。
