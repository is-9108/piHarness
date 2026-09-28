# piHarness

[pi-coding-agent](https://pi.dev) 用のワークフロー制御拡張（TypeScript Extension）と Skill 群です。
AI エージェントに次の 3 つのフローを「手順書」だけでなく **状態機械とゲートで強制** させます。

| フロー | 開始 | 概要 |
|-------|------|------|
| 1. 要件定義 | `/req <テーマ>` | 仕様が明確になるまで質問 → 要件定義書・設計概要・Issue 分割案 → **人間の承認ゲート** → 機能単位の小さな GitHub Issue を登録 |
| 2. TDD 実装 | `/impl <Issue番号>` | Issue とコードベースを読込 → テストプラン/実装プラン → **人間の承認** → Red/Green/Refactor → テスト修正ループ（最大 3 周）→ 多角的コードレビューループ（最大 3 周、2 周目以降は軽量）|
| 3. バグ修正 | `/bugfix <説明>` | エスカレーション時にユーザー判断で起動。再現テスト → 根本原因分析 → 修正 → 検証 → **実装フローへ合流** |

ループ上限に達するとエージェントは自走をやめ、ユーザーに判断（ループ継続 / バグ修正フロー / 手動対応 / 中止）を求めます。

**各プロセス（要件定義 / Issue 登録 / プラン作成 / TDD 実装 / レビュー / 指摘修正 / バグ修正）は独立したセッションで実行され、
プロセス間の連携は成果物の md ファイル（`plan.md`, `implementation.md`, `review-N.md`, `fix-N.md`, `bug-N.md` など）だけで行います。**
プロセスが完了すると自動で次のセッションが開始されます。

詳しいフロー図と仕様は [docs/workflows.md](docs/workflows.md)、設計は [docs/architecture.md](docs/architecture.md) を参照してください。

## 必要なもの（Raspberry Pi）

- Raspberry Pi 5（arm64 / Cortex-A76。メモリ 8GB 以上推奨）+ Raspberry Pi OS 64-bit（Bookworm 以降）
- ストレージは SD カードより NVMe SSD（M.2 HAT）推奨: `npm install` やテストの I/O が速く、書き込み寿命の心配も減ります
- Node.js **22.19 以上**（pi-coding-agent の要件）
- pi-coding-agent: `npm install -g @earendil-works/pi-coding-agent`
- GitHub CLI（Issue 登録・取得に使用。無くても動作し、その場合 Issue は `docs/issues/` に Markdown で保存）
  ```bash
  sudo apt install gh
  gh auth login
  ```

Node.js のインストール例:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # v22.19 以上であること
```

## インストール

### A. 他のプロジェクトで使う（推奨）

```bash
git clone https://github.com/is-9108/piHarness.git ~/piHarness
pi install ~/piHarness            # 全プロジェクトで有効（~/.pi/agent/settings.json に登録）
# または対象プロジェクト内で
pi install -l ~/piHarness         # そのプロジェクトのみ（.pi/settings.json に登録）
```

### B. このリポジトリ内で試す

`.pi/settings.json` がこのパッケージを読み込むよう設定済みです。リポジトリ直下で `pi` を起動し、プロジェクトを信頼（trust）してください。

### C. 一時的に読み込む

```bash
pi -e ~/piHarness/extensions/harness/index.ts
```

## 使い方

```text
/req 温度センサーの値を記録して見られるようにしたい
  → 質問に答える → 承認ダイアログで「承認する」 → Issue 登録の確認

/impl 12
  → プランを確認して承認 → あとは自動で TDD・テスト・レビュー（プロセスごとに新しいセッション）
  → 3 周で解決しなければエスカレーションダイアログ

/bugfix センサー未接続時に例外で落ちる
  → 完了後、実装フロー（コードレビュー）へ合流
```

### コマンド

| コマンド | 説明 |
|---------|------|
| `/req [テーマ]` | 要件定義フローを開始 |
| `/impl <番号 \| URL>` | TDD 実装フローを開始（`gh issue view` で本文を取得） |
| `/bugfix [説明]` | バグ修正フローを開始（実装フロー中/エスカレーション中なら完了後に合流） |
| `/harness status` | 現在のフロー・フェーズ・プロセスの入出力成果物・ループ回数・最近のイベント |
| `/harness next [指示]` | 次のプロセス（または中断中の現在のプロセス）を新しいセッションで開始（`autoHandoff: false` 時や pi 再起動後） |
| `/harness approve [コメント]` | 承認待ちのドキュメント/プランを承認（ダイアログを閉じた場合や RPC 利用時） |
| `/harness revise <修正内容>` | 修正を依頼 |
| `/harness reject` | 却下してフローを中止 |
| `/harness continue [指示]` | エスカレーション後、カウンタをリセットしてループを継続（新しいセッション） |
| `/harness rejoin` | 保留したバグ修正フローの結果を実装フローへ合流 |
| `/harness abort` | フローを中止 |
| `/harness config` | 有効な設定を表示 |

### エージェント用ツール（拡張が登録）

| ツール | 役割 |
|-------|------|
| `harness_status` | 状態と次にやることを取得 |
| `harness_ask` | ユーザーへの質問（選択肢 + 自由入力） |
| `harness_phase` | フェーズ遷移（許可された遷移のみ。テスト合格が条件のものあり） |
| `harness_request_approval` | 人間の承認ゲート（要件定義 / プラン） |
| `harness_run_tests` | テストスイート全体を実行してテストループを進める（red/green 期待） |
| `harness_record_review` | レビュー結果を記録してレビューループを進める |
| `harness_create_issues` | 承認後に Issue を登録（受け入れ条件必須・依存関係付き） |

### Skill

| Skill | 内容 |
|-------|------|
| `harness-requirements` | ヒアリングのチェックリスト、要件定義書/設計概要/Issue 分割案テンプレート、Issue 分割ルール |
| `harness-tdd` | Issue・コード読込、プランテンプレート、TDD サイクル、失敗時の分析手順 |
| `harness-review` | 多角的フルレビュー / 軽量レビューの手順、重大度基準、観点チェックリスト |
| `harness-bugfix` | 再現 → 根本原因分析 → 修正 → 合流、バグレポートテンプレート |

## 設定（対象プロジェクトの `.pi/harness.json`）

すべて任意です。未指定の場合は既定値、テストコマンドはプロジェクト構成から自動検出します
（`package.json` の test スクリプト / `Cargo.toml` / `go.mod` / `pyproject.toml` / `Makefile` の test ターゲット）。

```json
{
  "testCommand": "npm test",
  "testTimeoutSec": 900,
  "maxTestLoops": 3,
  "maxReviewLoops": 3,
  "blockingSeverities": ["blocker", "major"],
  "docsDir": "docs",
  "workDir": ".pi/harness",
  "issueRepo": "owner/repo",
  "issueLabels": [],
  "ensureLabels": true,
  "testOutputLines": 120,
  "autoHandoff": true
}
```

| キー | 既定値 | 説明 |
|------|-------|------|
| `testCommand` | 自動検出 | テストスイート全体を実行するコマンド。未検出時は初回実行時に質問して保存 |
| `testTimeoutSec` | 900 | テストのタイムアウト（ラズパイ向けに長め） |
| `maxTestLoops` | 3 | テスト失敗の修正ループ上限 |
| `maxReviewLoops` | 3 | レビューループ上限 |
| `blockingSeverities` | blocker, major | 修正必須とみなす重大度 |
| `docsDir` | docs | 要件定義書などの出力先 |
| `workDir` | .pi/harness | 状態ファイルと、作業項目ごとの成果物（プラン・実装レポート・レビュー記録・テストログ・バグレポート）の出力先 |
| `issueRepo` | カレントリポジトリ | Issue 登録先 |
| `issueLabels` | [] | 全 Issue に付与するラベル |
| `ensureLabels` | true | 存在しないラベルを自動作成 |
| `testOutputLines` | 120 | モデルに渡すテスト出力の末尾行数（全文はログに保存） |
| `autoHandoff` | true | プロセス完了時に自動で新しいセッションを開始する。false なら `/harness next` で手動開始 |

成果物の md ファイルは Issue ごとの作業記録としてコミットしても構いません。状態ファイルとテストログは `.gitignore` を推奨します:

```gitignore
.pi/harness/state.json
.pi/harness/**/logs/
```

## 開発

```bash
npm install
npm run typecheck   # tsc
npm test            # 状態機械・ガード・設定・Issue ヘルパーのユニットテスト (node --test)
npm run test:e2e    # 偽モデルで実際の Pi セッションランタイムを動かし、3 フローとセッション切り替えを通す E2E
npm run check       # 上記すべて
```

ラズパイでの `npm install` はネイティブモジュールのビルドを含む場合があるため、時間がかかることがあります（`typescript` と pi 本体は開発時の型チェック・E2E 用で、拡張の実行には不要です）。
