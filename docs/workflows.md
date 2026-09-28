# ワークフロー仕様

piHarness が制御する 3 つのフローの仕様です。フェーズ遷移はすべて `extensions/harness/state.ts` の状態機械で検証され、
エージェントは `harness_*` ツール経由でしか進められません。

## 全体像

```mermaid
flowchart LR
  subgraph R[1. 要件定義 /req]
    R1[ヒアリング] --> R2[ドキュメント作成] --> R3{人間の承認}
    R3 -- 修正依頼 --> R2
    R3 -- 承認 --> R4[Issue 登録]
  end
  subgraph I[2. TDD 実装 /impl]
    I1[Issue/コード読込] --> I2[テスト/実装プラン] --> I3{人間の承認}
    I3 -- 修正依頼 --> I2
    I3 -- 承認 --> I4[TDD 実装] --> I5[コードレビュー]
    I5 -- ブロッキング指摘 --> I6[指摘修正] --> I5
    I5 -- 指摘なし --> I7[完了]
  end
  subgraph B[3. バグ修正 /bugfix]
    B1[再現テスト] --> B2[根本原因分析] --> B3[修正・検証]
  end
  R4 -. Issue 番号 .-> I1
  I4 & I6 -. 3 周で解決せず .-> E{{エスカレーション}}
  I5 -. 3 周で指摘が残る .-> E
  E -- ユーザーがバグ修正を選択 --> B1
  B3 -- 合流（フルレビューから） --> I5
```

## 1. 要件定義フロー

| フェーズ | 内容 | 書き込み可能 | 次へ進む方法 |
|---------|------|-------------|-------------|
| `req_clarify` | 仕様が明確になるまで `harness_ask` で質問を繰り返す | `docs/`, `.pi/harness/` | `harness_phase → req_document` |
| `req_document` | 要件定義書・設計概要・Issue 分割案を作成 | 同上 | `harness_request_approval (requirements)`／不明点があれば `req_clarify` へ戻る |
| `req_approval` | **人間の承認ゲート** | 同上 | 承認ダイアログ または `/harness approve / revise / reject` |
| `req_issues` | 機能単位の小さな Issue を登録（受け入れ条件必須・依存関係付き） | 同上 | `harness_create_issues` |
| `req_done` | 完了報告 | 同上 | — |

- 承認前の `harness_create_issues` は拒否されます。bash での `gh issue create` もフロー中はブロックされます。
- `harness_create_issues` は登録前にもう一度ユーザーに確認します（外部への書き込みのため）。
- gh CLI が未インストール/未認証の場合は `docs/issues/NN-<slug>.md` に保存します。

## 2. TDD 実装フロー

| フェーズ | 内容 | 書き込み可能 | 次へ進む方法 |
|---------|------|-------------|-------------|
| `impl_context` | Issue・関連ドキュメント・コードベースを読む | `.pi/harness/` のみ | `harness_phase → impl_plan` |
| `impl_plan` | テストプラン + 実装プランを作成 | `.pi/harness/` のみ | `harness_request_approval (plan)` |
| `impl_plan_approval` | **人間の承認ゲート** | `.pi/harness/` のみ | 承認ダイアログ または `/harness approve` |
| `impl_tdd` | Red → Green → Refactor | 制限なし | 全テスト green かつ未テスト変更なしで `harness_phase → impl_review` |
| `impl_review` | 多角的コードレビュー（1 周目フル / 2 周目以降軽量） | `.pi/harness/` のみ | `harness_record_review` |
| `impl_fix_review` | ブロッキング指摘の修正 | 制限なし | 全テスト green かつ未テスト変更なしで `harness_phase → impl_review` |
| `impl_done` | 完了報告 | `.pi/harness/` のみ | — |

### テストループ

- `harness_run_tests` は設定されたテストスイート **全体** を実行します（結果をエージェントの自己申告に頼らない）。
- `expect: "red"` の失敗は TDD の Red 確認であり、ループ回数に数えません。Red 期待で合格した場合は「テストが要件を捉えていない」と警告します。
- `expect: "green"` の **連続失敗** がループ回数です。合格でリセットされます。
- 連続失敗が `maxTestLoops`（既定 3）に達するとエスカレーションします。
- 最後の合格以降に `edit` / `write` でファイルが変更されると「未テストの変更あり」となり、レビューへ進めません。

### レビューループ

- 重大度 `blocker` / `major`（設定可）の指摘がブロッキングです。`minor` / `nit` は報告のみで完了を妨げません。
- 1 周目はフルレビュー（requirements / correctness / tests / security / performance / maintainability / operability）。
- 2 周目以降は軽量レビュー（前回指摘の解消確認 + 新規差分の重大な問題のみ）。
- レビュー記録は `.pi/harness/reviews/issue-<番号>-round-<N>.md` に保存されます。
- `maxReviewLoops`（既定 3）周してもブロッキング指摘が残るとエスカレーションします。

## エスカレーション

ループ上限に達すると状態は `escalated` になり、コード変更はブロックされます。UI があればその場で選択肢を表示します。

| 選択 | 動作 |
|------|------|
| ループを継続する | カウンタをリセットして元のフェーズへ戻る（レビューループの場合は修正フェーズから、追加で `maxReviewLoops` 周を許可） |
| 独立したバグ修正フローで対応する | 実装フローを退避して `/bugfix` と同じフローを開始 |
| 手動で対応する | フローを一時停止。後で `/harness continue` や `/bugfix` で再開 |
| フローを中止する | フロー終了 |

UI がない場合（RPC/print モード）は停止してユーザーに報告し、コマンドでの判断を待ちます。

## 3. バグ修正フロー

| フェーズ | 内容 | 書き込み可能 | 次へ進む方法 |
|---------|------|-------------|-------------|
| `bug_reproduce` | バグを再現するテストを書き、red を確認 | 制限なし | `harness_phase → bug_analyze` |
| `bug_analyze` | 根本原因分析、バグレポート作成 | `.pi/harness/` のみ | `harness_phase → bug_fix`（再現が不十分なら `bug_reproduce` へ） |
| `bug_fix` | 最小修正、全テスト green | 制限なし | 全テスト green かつ未テスト変更なしで `harness_phase → bug_done`（再分析なら `bug_analyze` へ） |
| `bug_done` | 完了 → 合流 | `.pi/harness/` のみ | 合流先があれば確認後 `impl_review` へ |

- 実装フロー中（エスカレーション中を含む）に起動すると、その Issue とフェーズを退避し、完了後に **`impl_review` から** 合流します。
  バグ修正でコードが変わっているため、レビューカウンタをリセットしてフルレビューから行います（テストは bug_fix の最後で合格済み）。
- バグ修正フロー内の修正ループも `maxTestLoops` で再エスカレーションします。そこから再度 `/bugfix` を選んでも合流先は保持されます。
- 単独で起動した場合（実装フローなし）は、完了で終了します。

## 状態の永続化

- 状態は Pi セッションのカスタムエントリ（`harness-state`）として保存され、セッション再開・ツリー移動（分岐）時に復元されます。
- プラン・レビュー記録・テストログ・バグレポートは `.pi/harness/` 配下のファイルとして残ります。
