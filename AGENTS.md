# AGENTS.md — piHarness の開発ガイド

pi-coding-agent の拡張 + Skill。要件定義 → TDD 実装 → レビュー（＋バグ修正）を**状態機械とゲートで強制**する。
利用者向けの説明は README.md、仕様は docs/workflows.md、設計の理由は docs/architecture.md。

## 構成

| パス | 役割 |
|---|---|
| `extensions/harness/index.ts` | Pi との接続だけ（ツール・コマンド・イベント）。ロジックは下の純粋モジュールへ |
| `extensions/harness/state.ts` | 状態機械（フェーズ・承認・ループ・エスカレーション・プロセス境界）。**純粋関数** |
| `extensions/harness/handoff.ts` | プロセス間の引き継ぎ（成果物パス・入力/参照/出力・開始メッセージ） |
| `extensions/harness/*.ts` | guard（書き込み制限）/ git / integrity（テスト保護）/ testlock（テストのロック）/ failures（失敗の指紋・ベースライン）/ progress（Issue 進捗）/ usage / tools / compaction / dashboard（TUI 表示）/ templates（Issue・PR・レビュー記録の組み立て）/ config |
| `templates/{issue,pr,review}.md` | 外に出す文書のテンプレート（プロジェクトの `<workDir>/templates/` で上書き可） |
| `skills/harness-*/SKILL.md` | プロセスごとの手順（1 プロセス = 1 スキル、各 2〜3KB に保つ） |
| `scripts/install.mjs` | 他プロジェクトへの組み込み（`.pi/piHarness` に clone して実行） |
| `test/*.test.ts` / `test/e2e/*.ts` | ユニットテスト / 偽モデルで実際の Pi を動かす E2E（natural.ts は確認ダイアログをスクリプトで応答） |

## コマンド

```bash
npm run check      # 型チェック + ユニット + E2E（変更後は必ず全部通す）
npm test           # ユニットのみ（速い）
npm run test:e2e   # E2E のみ
```

Node 22.19+。TypeScript は型除去で直接実行（ビルドなし）。import は `./x.ts` と拡張子付きで書く。

## 守ること

- **判定はエージェントの自己申告に頼らない**: 承認は UI かユーザーのコマンドのみ、テスト合否は拡張が実行した終了コード、変更の有無は git の指紋。テストの書き換えはロックで防ぎ、仕様の解釈はユーザーに決めてもらう（`decisions.md`）。
- **ユーザーは自然言語で操作する**: フローの開始・継続・合流・中止は `harness_control`（実行前に必ず確認ダイアログ）。コマンドは同じ処理（`prepare*` 関数）を呼ぶ代替手段。
- **ロジックは純粋関数に置いてユニットテストする**。`index.ts` は薄く保つ。
- **状態は `.pi/harness/state.json`**。セッション切り替えで拡張は作り直されるため、メモリやセッションエントリに状態を置かない。
- **プロセス（= セッション）間の連携は成果物ファイルだけ**。次のプロセスが必要とする成果物が無ければ遷移を拒否する（`requiredArtifact`）。
- **トークンを増やさない**: スキルは担当プロセスの手順だけ。ツール定義・注入する状態表示・テスト出力は最小限。状態表示は会話から削除しない（キャッシュが壊れる）。
- 利用者に見える文言（ツール結果・通知・スキル・Issue・PR・レビュー記録）は日本語。
- **Issue・PR・レビュー記録はテンプレートで組み立てる**: エージェントからは項目で受け取り、Markdown を自由に書かせない。項目を足すときは `templates.ts` の `*Vars` とテンプレート先頭のコメントを一緒に直す。

## 変更の手順

- **フェーズ / プロセスを足す**: `state.ts`（`Phase`・`PROCESS_OF`・遷移表）→ `handoff.ts`（`processIO`・`skillFor`）→ `tools.ts` → `guard.ts` → スキル追加 → テスト。
- **スキルを足す / 直す**: frontmatter に `disable-model-invocation: true`（拡張が明示的に呼ぶ）。`test/e2e/smoke.ts` と `test/install.test.ts` のスキル一覧も更新。
- **設定を足す**: `config.ts`（型・既定値・検証）→ `templates/harness.json` → README の設定表。
- ドキュメント（README・docs）は挙動を変えたら同じコミットで直す。

## Pi の落とし穴（実装で確認済み）

- `/skill:<名前>` はスキル名の後ろが**空白**でないと展開されない（改行は不可）。
- `ctx.newSession()` はコマンドからしか呼べない → ツールは「次セッション待ち」を記録し、`agent_settled` で `/harness next` を送る。
- `ctx.compact()` はターンの区切りで呼んでも実行が止まらない → `turn_end` で予約し、次のツール呼び出しを止めて `agent_settled` で圧縮。
- 新セッション直後の `pi.setModel()` は認証スナップショットの遅れで失敗することがある → 非同期で認証を確認して再試行（`setModelWhenReady`）。
- `git diff` は未追跡ファイルを含まない → 指紋・テスト保護・スナップショットでは未追跡ファイルも扱う。
- E2E の偽モデルは応答を順番に消費する。ツール呼び出しを足したら応答列と期待値を合わせて直す。
