# piHarness

[pi-coding-agent](https://pi.dev) 用のワークフロー制御拡張（TypeScript Extension）と Skill 群です。
AI エージェントに次の 4 つのフローを「手順書」だけでなく **状態機械とゲートで強制** させます。

| フロー | 開始 | 概要 |
|-------|------|------|
| 1. 要件定義 | `/req <テーマ>` | 仕様が明確になるまで質問（ヒアリング）→ 要件定義書・設計概要・Issue 分割案 → **人間の承認ゲート** → 機能単位の小さな GitHub Issue を登録（ヒアリング / 要件定義書作成 / Issue 登録は別セッション） |
| 2. TDD 実装 | `/impl <Issue番号>` | Issue とコードベースを読込 → テストプラン/実装プラン → **人間の承認** → Red/Green/Refactor（Red で確かめたテストは**ロック**）→ テスト修正ループ（最大 3 周。**同じ失敗が 2 回続けば早めに止める**）→ 多角的コードレビューループ（最大 3 周、2 周目以降は軽量。**仕様の曖昧さはループに数えずすぐ人に聞く**）|
| 3. バグ修正 | `/bugfix <説明>` | エスカレーション時にユーザー判断で起動。再現テスト → 根本原因分析 → 修正 → 検証 → **実装フローへ合流** |
| 4. ドキュメント作成 | `/doc <テーマ \| Issue>` | ドキュメントだけを書く・直す（**テストは無い**）。情報源を読んで構成案 → **人間の承認** → 執筆（**ドキュメント以外は変更できない**）→ ドキュメントの観点でのレビューループ（最大 3 周）→ コミット・PR |

ループ上限に達するとエージェントは自走をやめ、ユーザーに判断（ループ継続 / バグ修正フロー / 手動対応 / 中止）を求めます。

**各プロセス（要件ヒアリング / 要件定義書作成 / Issue 登録 / プラン作成 / TDD 実装 / レビュー / 指摘修正 / バグ修正 / ドキュメントの構成案・執筆・レビュー・指摘修正）は独立したセッションで実行され、
プロセス間の連携は成果物の md ファイル（`plan.md`, `implementation.md`, `review-N.md`, `fix-N.md`, `bug-N.md` など）だけで行います。**
プロセスが完了すると自動で次のセッションが開始されます。

詳しいフロー図と仕様は [docs/workflows.md](docs/workflows.md)、設計は [docs/architecture.md](docs/architecture.md) を参照してください。

## 必要なもの（Raspberry Pi）

- Raspberry Pi 5（arm64 / Cortex-A76。メモリ 8GB 以上推奨）+ Raspberry Pi OS 64-bit（Bookworm 以降）
- ストレージは SD カードより NVMe SSD（M.2 HAT）推奨: `npm install` やテストの I/O が速く、書き込み寿命の心配も減ります
- Node.js **22.19 以上**（pi-coding-agent の要件）
- pi-coding-agent **1.0 以降を推奨**（0.99 以降で動作）: `npm install -g @earendil-works/pi-coding-agent`（0.99 で組み込みになった MCP・codemode への対策を含みます。詳しくは [docs/architecture.md](docs/architecture.md#codemode-と-mcppi-099-以降)）
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

piHarness は **1 か所に clone して、全プロジェクト共通で使います**（Pi のユーザー設定に登録）。
どのプロジェクトでも、そのプロジェクトの git worktree でも、同じ piHarness が読み込まれます。
プロジェクトごとに clone する必要はありません。

### 1. piHarness を入れる（初回のみ）

```bash
git clone https://github.com/is-9108/piHarness.git ~/piHarness
node ~/piHarness/scripts/install.mjs --global-only   # pi install ~/piHarness と同じ
pi list                                              # User packages に ~/piHarness が表示されれば OK
```

### 2. プロジェクトで使えるようにする（プロジェクトごとに 1 回）

```bash
cd ~/projects/my-app
node ~/piHarness/scripts/install.mjs     # .pi/harness.json と .gitignore を用意（1 の登録も、まだなら行う）
git add .pi/harness.json .gitignore
git commit -m "piHarness の設定を追加"     # コミットしておくと、worktree や他の人の clone でも同じ設定になる
pi                                       # 起動して話しかける
```

セットアップスクリプトは次のことを行います。何度実行しても結果は同じです。

| 対象 | 内容 |
|------|------|
| Pi のユーザー設定 | `pi install ~/piHarness` で登録（`~/.pi/agent/settings.json`。登録済みなら変わらない） |
| `.pi/settings.json` | 以前の方式（プロジェクトごとの clone）の登録が残っていれば外す（別の場所の piHarness を二重に読み込むとツールが衝突するため）。それ以外の設定は保持 |
| `.pi/harness.json` | 無ければ雛形を作成（あれば変更しない）。プロジェクトごとのテストコマンド・モデルはここで設定 |
| `.gitignore` | `.pi/harness/state.json`, `.pi/harness/provider-status.json`, `.pi/harness/**/logs/`, `.pi/harness/**/test-lock/` を追加 |
| 環境チェック | Node.js 22.19 以上・gh（ログイン状態）を確認して表示（pi が無ければ止まる） |

オプション: `--global-only`（登録だけ）/ `--uninstall`（登録を外す）/ `--dry-run`（変更内容の表示だけ）/ `--project <dir>`（カレントディレクトリ以外のプロジェクト）。

### worktree で使う

追加の作業はいりません。`git worktree add` で作った worktree で `pi` を起動すれば、そのまま使えます。
`.pi/harness.json` をコミットしていない場合だけ、worktree の中で `node ~/piHarness/scripts/install.mjs` を実行してください。

### 更新・取り外し

```bash
git -C ~/piHarness pull                           # 更新（全プロジェクトに反映。pi 起動中なら /reload）
node ~/piHarness/scripts/install.mjs --uninstall  # 取り外し（全プロジェクト共通の登録を外す。各プロジェクトの設定・成果物は残る）
```

### 以前の方式（プロジェクトごとの `.pi/piHarness/`）から移行する

以前の方式の登録が残ったまま全プロジェクト共通で入れると、piHarness が 2 つ読み込まれてツールが衝突し、動かなくなります。
各プロジェクトで次を実行してください。

```bash
cd ~/projects/my-app
node ~/piHarness/scripts/install.mjs   # .pi/settings.json の古い登録（"./piHarness"）を外す
rm -rf .pi/piHarness                   # 古い clone を削除
# .gitignore の「.pi/piHarness/」の行も削除する
```

`.pi/harness.json`・成果物（`.pi/harness/`）・ADR などはそのまま使えます。

補足:

- **プロジェクトごとに独立:** ワークフローの状態（`.pi/harness/state.json`）・成果物・設定（`.pi/harness.json`）はプロジェクトごと、worktree ごとに独立しています。
  別の worktree で別の Issue を同時に進められます（`issues.json` も worktree ごとなので、新しい worktree では `/impl 12` のように番号を指定してください）。
- **worktree と `main` の pull:** `main` が別の worktree（元の作業ツリーなど）で使われているとローカルの `main` は進められないため、`origin/main` を取得してそこから作業ブランチを作ります（PR のマージ先は `main` のまま）。
- **本体は編集できない:** エージェントは piHarness 本体（`~/piHarness/`）を編集できません（拡張がブロックします）。
- **MCP ツール:** プラン承認前やレビュー中など書き込みを制限している間は、読み取り専用（`readOnlyHint`）と宣言された MCP ツールだけが使えます。
- **依存パッケージは不要:** `~/piHarness` で `npm install` する必要はありません。必要なパッケージは Pi 本体が提供します。

### 一時的に読み込む

```bash
pi -e ~/piHarness/extensions/harness/index.ts
```

### piHarness 自体の開発

このリポジトリの `.pi/settings.json` が自分自身を読み込むよう設定されています。リポジトリ直下で `pi` を起動し、プロジェクトを信頼してください。
全プロジェクト共通で登録している clone と**別の場所**で開発すると、2 つの piHarness が読み込まれてツールが衝突します。登録している clone（`~/piHarness`）で開発するか、開発中は `node scripts/install.mjs --uninstall` で登録を外してください。

## 使い方

pi（TUI）を起動して、**やりたいことを普通の言葉で話しかけてください。** コマンドは不要です。
フローの開始・切り替え・中止の前には**必ず確認ダイアログ**が出て、「はい」を選んだときだけ実行されます。

| 話しかける例 | 起きること |
|---|---|
| 「温度センサーの値を記録して見られるようにしたい」 | 要件定義を開始（確認後、新しいセッションでヒアリング → 要件定義書 → 承認 → Issue 登録） |
| 「Issue 12 を実装して」「次の Issue をやって」 | TDD 実装を開始（確認後、プラン作成 → 承認 → 実装 → テスト → レビュー） |
| 「センサー未接続で落ちるのを直したい」 | バグ修正を開始（実装中なら完了後にレビューへ合流） |
| 「導入手順のドキュメントを書いて」「README を直したい」 | ドキュメント作成を開始（確認後、構成案 → 承認 → 執筆 → レビュー。テストは無い） |
| 「承認します」「ここを直して」（承認待ちのとき） | 承認ダイアログをもう一度出して確定（チャットの発言だけでは承認にならない） |
| 「空のときは 400 で」（仕様の確認を聞かれたとき） | 回答ダイアログをもう一度出して確定 → 決まった解釈でレビューを続ける |
| 「ループを続けて」「バグ修正して」（エスカレーション後） | 確認のうえループ継続 / バグ修正フローへ |
| 「今どうなってる？」「Issue の進み具合は？」「どれくらい使った？」 | 状態・進み具合・利用量を表示（確認なし） |
| 「やめたい」 | 確認のうえフローを中止（成果物は残る） |

### 画面の見方（ダッシュボード）

入力欄の上に、いまの状況が常に表示されます（例: Issue の TDD 実装中）。

```text
🧭 TDD 実装 │ #12 ログイン API │ ⎇ issue-12-login-api                      ← フロー・対象・ブランチ
✓ 読込 › ✓ プラン › ✓ 承認 › ▶ TDD 実装 › ○ レビュー › ○ 完了              ← 作業全体のどこにいるか
▶ いま 🧪 テスト実行中（Green: 全体 + チェック） │ 次: Red → Green → Refactor  ← いま何をしているか・次に何をするか
テスト修正 1/3 │ レビュー 0/3（次: フル） │ 直近のテスト FAIL                ← ループ回数・直近の結果
このセッション 入 12.3k / 出 1.2k $0.042 │ 作業合計 158.0k $0.520（3 セッション） │ コンテキスト 51%（圧縮 60%） │ anthropic/claude-sonnet-5 · medium
```

- **いま:** 読込・編集・テスト実行・質問・承認待ちなどを、ツールの動きに合わせて更新します（作業中の表示にも出ます）。
- **トークン:** 「このセッション」と、同じ Issue / 要件定義の全セッションの「作業合計」（費用込み）を表示します。
- **コンテキスト使用率:** 自動圧縮のしきい値に近づくと黄色、超えると赤になります。
- **色分け:** エスカレーション中は工程が ⚠ で赤く表示され、どう伝えればよいかも表示します。
- **非表示にする:** 何も進めていないときは「待機中」と現在のブランチ・話しかけ方を表示します。`.pi/harness.json` の `"dashboard": false` で非表示にできます（ステータス行の 1 行表示になります）。
- **pi 1.0 のフルスクリーン表示:** pi 1.0 から TUI は既定でフルスクリーンになりました。テストのログなどを端末のスクロールバックで見返したい場合や、表示が崩れる場合は、pi の設定 `tuiMode` を `"regular"` にするか `pi --tui-mode regular` で起動してください。

コマンドでも同じ操作ができます（RPC など確認ダイアログを出せない環境ではコマンドを使います）。

```text
/req <テーマ>        /impl <番号 | URL | docs/issues/*.md | next>        /bugfix <説明>        /doc <テーマ | Issue>
```

### コマンド

| コマンド | 説明 |
|---------|------|
| `/req [テーマ]` | 要件定義フローを開始 |
| `/impl <番号 \| URL \| docs/issues/*.md>` | TDD 実装フローを開始（作業ブランチを作成。GitHub の Issue は `gh issue view` で本文を取得） |
| `/impl next` | 依存関係から次に着手できる Issue を選んで開始 |
| `/bugfix [説明]` | バグ修正フローを開始（実装フロー中/エスカレーション中なら完了後に合流） |
| `/doc [テーマ \| 番号 \| URL \| docs/issues/*.md]` | ドキュメント作成フローを開始（Issue として解釈できればその Issue、できなければテーマとして扱う） |
| `/harness status` | 現在のフロー・フェーズ・プロセスの入出力成果物・ループ回数・最近のイベント |
| `/harness next [指示]` | 次のプロセス（または中断中の現在のプロセス）を新しいセッションで開始（`autoHandoff: false` 時や pi 再起動後） |
| `/harness approve [コメント]` | 承認待ちのドキュメント/プランを承認（ダイアログを閉じた場合や RPC 利用時） |
| `/harness revise <修正内容>` | 修正を依頼 |
| `/harness answer [回答]` | レビューで見つかった仕様の確認に回答（回答待ちの先頭の質問。回答を省くとダイアログ） |
| `/harness reject` | 却下してフローを中止 |
| `/harness continue [指示]` | エスカレーション後、カウンタをリセットしてループを継続（新しいセッション） |
| `/harness rejoin` | 保留したバグ修正フローの結果を実装フローへ合流 |
| `/harness abort` | フローを中止 |
| `/harness issues` | 登録した Issue の進み具合（完了 / 実装中 / 依存待ち / 次の候補） |
| `/harness pr` | 完了した実装の PR を作成（`git.pr: ask` で見送った場合や失敗時の再試行） |
| `/harness usage [作業ディレクトリ]` | プロセス別・モデル別のトークン数と費用 |
| `/harness models` | 各プロセスに適用されるモデル・思考レベル・フォールバック順を表示 |
| `/harness config` | 有効な設定を表示 |

### エージェント用ツール（拡張が登録）

| ツール | 役割 |
|-------|------|
| `harness_control` | 自然言語の依頼からフローを開始・操作（開始・継続・合流・中止。必ず確認ダイアログを出す） |
| `harness_status` | 状態と次にやること / Issue の進み具合 / 利用量を取得 |
| `harness_ask` | ユーザーへの質問（選択肢 + 自由入力） |
| `harness_phase` | フェーズ遷移（許可された遷移のみ。テスト合格が条件のものあり） |
| `harness_request_approval` | 人間の承認ゲート（要件定義 / プラン） |
| `harness_run_tests` | テストスイート全体を実行してテストループを進める（red/green 期待） |
| `harness_record_review` | レビュー結果を記録してレビューループを進める（仕様の曖昧さはユーザーに確認） |
| `harness_request_test_change` | ロック中のテストの変更をユーザーに申請する（承認されたファイルだけ編集できる） |
| `harness_record_decision` | 重要な設計判断を ADR として記録する（テンプレートで組み立て、一覧を更新） |
| `harness_create_issues` | 承認後に Issue を登録（受け入れ条件必須・依存関係付き） |

### Skill

| Skill | 内容 |
|-------|------|
| `harness-hearing` | 要件ヒアリング（質問の観点、hearing.md テンプレート） |
| `harness-requirements` | 要件定義書・設計概要・Issue 分割案の作成と承認（テンプレート、Issue 分割ルール） |
| `harness-issues` | Issue 登録（Issue 本文テンプレート） |
| `harness-plan` | Issue・コード読込とテスト/実装プラン（plan.md テンプレート） |
| `harness-tdd` | TDD 実装（Red/Green/Refactor、失敗時の分析、implementation.md テンプレート） |
| `harness-review` | フルレビュー（観点、重大度、観点チェックリスト） |
| `harness-review-light` | 軽量レビュー（前回指摘の解消と差分の確認） |
| `harness-fix` | レビュー指摘の修正（fix-N.md テンプレート） |
| `harness-bugfix` | バグ修正（再現 → 根本原因分析 → 修正 → 合流、バグレポートテンプレート） |
| `harness-doc-plan` | ドキュメントの構成案（読者・目的・ファイル・章立てと根拠、outline.md テンプレート） |
| `harness-doc-write` | ドキュメント執筆（実物で確かめて書く、doc-report.md テンプレート） |
| `harness-doc-review` | ドキュメントレビュー（正確さ・網羅性・分かりやすさ・構成・一貫性・手順と例・リンク） |
| `harness-doc-fix` | ドキュメントのレビュー指摘修正（fix-N.md テンプレート） |

各スキルは piHarness が新しいセッションの開始時に呼び出します（モデルが自分で選ぶ一覧には載せていません）。

## 設定（対象プロジェクトの `.pi/harness.json`）

すべて任意です。未指定の場合は既定値、テストコマンドはプロジェクト構成から自動検出します
（`package.json` の test スクリプト / `Cargo.toml` / `go.mod` / `pyproject.toml` / `Makefile` の test ターゲット）。

```json
{
  "testCommand": "npm test",
  "checkCommands": ["npm run lint", "npm run typecheck"],
  "testTimeoutSec": 900,
  "maxTestLoops": 3,
  "maxReviewLoops": 3,
  "blockingSeverities": ["blocker", "major"],
  "docsDir": "docs",
  "workDir": ".pi/harness",
  "adr": true,
  "adrDir": "docs/adr",
  "issueRepo": "owner/repo",
  "issueLabels": [],
  "ensureLabels": true,
  "testOutputLines": 120,
  "autoHandoff": true,
  "testIntegrity": true,
  "testLock": true,
  "baseline": true,
  "flakyRetries": 1,
  "sameFailureLimit": 2,
  "dashboard": true,
  "compaction": { "enabled": true, "thresholdPercent": 60 },
  "issueLimits": { "maxAcceptanceCriteria": 5, "allowedSizes": ["S", "M"], "maxPlanTestCases": 12 },
  "git": {
    "enabled": true,
    "branchPrefix": "issue-",
    "baseBranch": "main",
    "commit": true,
    "commitArtifacts": false,
    "pr": "ask",
    "draft": false,
    "dirtyStart": "ask",
    "pullBase": true
  },
  "models": {
    "default": "anthropic/claude-sonnet-5",
    "hearing": { "model": ["google/gemini-flash-latest", "ollama/qwen3:8b"], "thinking": "low" },
    "requirements": { "model": "anthropic/claude-opus-5-5", "thinking": "high" },
    "review_full": { "model": "anthropic/claude-opus-5-5", "thinking": "high" },
    "review_light": { "model": "anthropic/claude-sonnet-5", "thinking": "medium" },
    "implement": { "thinking": "medium" }
  }
}
```

| キー | 既定値 | 説明 |
|------|-------|------|
| `testCommand` | 自動検出 | テストスイート全体を実行するコマンド。未検出時は初回実行時に質問して保存 |
| `checkCommands` | []（セットアップ時に package.json の lint / typecheck を検出） | green 判定でテストと一緒に実行し、合格を必須にするチェック（lint・型チェックなど） |
| `testTimeoutSec` | 900 | テスト・チェック 1 コマンドあたりのタイムアウト（ラズパイ向けに長め） |
| `maxTestLoops` | 3 | テスト失敗の修正ループ上限 |
| `maxReviewLoops` | 3 | レビューループ上限 |
| `blockingSeverities` | blocker, major | 修正必須とみなす重大度 |
| `docsDir` | docs | 要件定義書などの出力先 |
| `adr` | true | 重要な設計判断を ADR として記録する（下記） |
| `adrDir` | `<docsDir>/adr` | ADR とその一覧（README.md）の出力先 |
| `workDir` | .pi/harness | 状態ファイルと、作業項目ごとの成果物（プラン・実装レポート・レビュー記録・テストログ・バグレポート）の出力先 |
| `issueRepo` | カレントリポジトリ | Issue 登録・PR 作成先 |
| `issueLabels` | [] | 全 Issue に付与するラベル |
| `ensureLabels` | true | 存在しないラベルを自動作成 |
| `testOutputLines` | 120 | モデルに渡すテスト出力の末尾行数（全文はログに保存） |
| `autoHandoff` | true | プロセス完了時に自動で新しいセッションを開始する。false なら `/harness next` で手動開始 |
| `testIntegrity` | true | テストを弱める変更を検知して理由の記録を求める（下記） |
| `testLock` | true | Red で確かめたテストを Green の合格までロックし、レビュー以降はレビュー時点のテストをロックする（下記） |
| `baseline` | true | 実装開始時点でテストとチェックを実行し、もともと失敗しているものを判定から除外する（下記） |
| `flakyRetries` | 1 | green 期待で失敗したコマンドを再実行する回数。再実行で合格したものは不安定なテストとして記録し、ループに数えない。0 で無効 |
| `sameFailureLimit` | 2 | 同じ失敗がこの回数続いたら、`maxTestLoops` を待たずにエスカレーションする。0 で無効 |
| `dashboard` | true | 入力欄の上にダッシュボード（工程・いまの作業・ブランチ・トークン等）を表示 |
| `compaction` | 有効・60% | コンテキスト使用率がしきい値を超えたら区切りで圧縮し、スキルと成果物の一覧を送り直して再開（下記） |
| `issueLimits` | AC 5 個・S/M・テスト 12 件 | Issue とプランの大きさの上限（下記） |
| `git` | 下記 | Git 連携（作業ブランチ・差分の基準・コミット・PR） |
| `models` | {} | プロセスごとのモデル・思考レベル（下記） |
| `fallback` | 有効・60 分・10 分 | 利用上限で止まったときに models の次の候補へ切り替える（下記）。`enabled` / `quotaCooldownMinutes`（利用枠・課金の上限で避ける時間）/ `transientCooldownMinutes`（混雑・レート制限で避ける時間） |

### トークン消費の効率化

| 工夫 | 内容 |
|---|---|
| プロセス専用のスキル | セッションごとに、そのプロセスの手順だけを書いた小さなスキル（約 2〜3KB）を読み込む。スキルは明示的に呼び出すので、全セッションのシステムプロンプトにスキル一覧も載せない |
| 軽量レビューは差分だけ | 2 周目以降のレビューは、前回レビュー時点の作業ツリーのスナップショットからの差分（`delta-N.diff`）・前回の指摘・対応記録だけを読む |
| 入力の必読 / 参照の区別 | 開始メッセージで「最初に読むもの」と「必要なときだけ読むもの」を分ける（例: 指摘修正では実装レポートやプランは参照扱い） |
| ツールの絞り込み | プロセスに必要なツールだけを有効にする（例: ヒアリングは質問・遷移・状態のみ、レビューは書き込みツールなし） |
| テスト出力の省略 | 合格時は結果の要約だけを返す。Red 確認は 40 行、失敗時は `testOutputLines` 行（全文はログ） |
| キャッシュを壊さない状態表示 | 状態は変わったときだけ追記し、過去の表示を会話から削除しない（プロンプトキャッシュの再利用が途切れない） |

### セッションを小さく保つ（`issueLimits` / `compaction`）

- **Issue の大きさ:** Issue 登録時に規模（S / M のみ）と受け入れ条件の数（5 個まで）を検査し、超えるものは分割を求めます。プラン承認時にテストケースが 12 件を超えていれば、承認ダイアログで分割の検討を促します。
- **自動圧縮:** コンテキスト使用率がしきい値（既定 60%）を超えると、次の区切り（ツール呼び出しの手前）で一度止めて圧縮し、そのプロセスのスキルと成果物の一覧を送り直して同じセッションで再開します。
  要約には、完了/残りのテストケース、直近のテスト結果と失敗原因の仮説、変更したファイル、未解決の指摘を残すよう指示します。
  Pi 自身の自動圧縮（上限直前）が起きた場合も、スキルと成果物の一覧を送り直します。

### Git 連携（`git`）

git リポジトリであれば自動で有効になります。

1. **開始時:** 開始元ブランチ（`main` など）を **origin から pull してから**、作業ブランチ（`issue-12-add-login` など。タイトルが日本語だけなら `issue-12`）を作成し、開始時点のコミットを**差分の基準**として記録します。
   - 作成元（= PR のマージ先）は `baseBranch`、未指定なら既定ブランチ（`origin/HEAD` / `main` / `master`）です。前の Issue の作業ブランチ上にいる場合は、既定ブランチから作るか、積み上げるかを確認します（UI が無ければ既定ブランチ）。
   - pull は早送りだけです（`main` 上なら `git pull --ff-only`、別のブランチ上なら `git fetch origin main:main`）。現在のブランチは変えません。
   - pull できない場合（ネットワーク・認証・ローカルの `main` に origin に無いコミットがある）は開始を止め、確認ダイアログで「最新化せずに開始」を選んだときだけ続けます。origin が無いリポジトリでは何もしません。`pullBase: false` で無効にできます。
   - 既存のブランチなら切り替えて再開します。未コミットの変更がある場合は確認します（`dirtyStart`: `ask` / `allow` / `refuse`）。
2. **作業中:** レビュー・修正・バグ修正の各セッションには「`git diff <基準>` で差分を確認する」と案内します。関係ない変更がレビューに混ざりません。
3. **完了時:** レビューを通過すると変更をコミットします（件名 `タイトル (#12)`、本文に `Closes #12`）。成果物（`.pi/harness/`）は既定ではコミットしません（`commitArtifacts`）。
4. **PR:** `pr` に従います。
   - `ask`（既定）: 確認ダイアログで承認したときだけ、push して開始時のブランチへの PR を作成します。PR の本文は実装レポートとレビュー履歴から、日本語のテンプレート（`pr.md`、下記）で作ります。
   - `auto`: 確認なしで作成します。
   - `off`: 作成しません。
   - 見送った場合や失敗した場合は `/harness pr` で作成できます。

エージェントにはコミット・push・ブランチ操作をさせません（SKILL で禁止し、完了処理は拡張が行います）。
コミットには git のユーザー設定（`git config --global user.name / user.email`）が必要です。

### テストの保護（`testIntegrity`）

実装開始時点からの差分（新規ファイルを含む）を調べ、次の変更を見つけると、レビューやバグ修正完了への遷移を止めます。

- テストファイルの削除
- `.skip` / `xit` / `@pytest.mark.skip` / `t.Skip` / `#[ignore]` などの追加
- `.only` / `fit` など、一部のテストだけを実行させる記述の追加
- アサーション（`expect` / `assert` など）の差し引きでの減少

仕様変更でテストが不要になった場合など、正当な理由があるときだけ、エージェントが理由を書いて先へ進めます。理由は `test-changes.md` に記録され、レビュー担当が妥当性を検証します。

### テストのロック（`testLock`）

テストを書く人と実装する人が同じエージェントなので、「実装を直す代わりにテストを書き換えて通す」ことを仕組みで防ぎます。

| 期間 | ロックされるもの | 新しいテストファイル |
|---|---|---|
| Red を確認（`harness_run_tests` の `expect: "red"` が失敗）してから Green が合格するまで | その時点のすべてのテストファイル | 追加できない |
| レビューへ進んでから完了まで（指摘修正を含む） | レビューへ進んだ時点のすべてのテストファイル | 追加できる |

- `edit` / `write` での書き込みはブロックします。bash などで変更された場合は、テスト実行とフェーズ遷移の前にハッシュで照合し、ロック時の内容に戻してから止めます（ロック時の内容は作業ディレクトリの `test-lock/` に保存）。
- テストのほうが受け入れ条件と合っていない場合は、エージェントが `harness_request_test_change` で対象ファイルと理由を示し、**ユーザーが承認したファイルだけ**編集できるようになります。申請と理由は `test-changes.md` と PR 本文に記録され、レビューで検証されます。
- テストランナーが書き換えるスナップショット（`__snapshots__/`、`.snap`）とキャッシュはロックしません。バグ修正フローでは、再現テストを書くためにロックを外し、再現を確認した時点でロックし直します。

### 失敗の指紋・ベースライン・不安定なテスト

`harness_run_tests` はテストの合否をさらに次のように判定します。どれも JUnit などの特別な出力は不要で、主なテストランナー（node:test / vitest / jest / pytest / go test / cargo test / tsc / eslint）の出力から失敗を表す行を取り出し、時間・行番号・パスなど実行ごとに変わる値を取り除いて比べます。

- **同じ失敗での早期停止（`sameFailureLimit`）:** 失敗の指紋（失敗したコマンドと失敗を表す行）が 2 回続いたら、修正が進んでいないとみなして上限（3 回）を待たずにエスカレーションします（理由: `no_progress`）。
- **ベースライン（`baseline`）:** `/impl` の開始時点でテストとチェックを実行し、結果を `baseline.md` に記録します。以降、開始時点と**同じ失敗だけ**が残っている場合は合格扱いにします。新しい失敗が加わった場合、失敗したテストを出力から特定できない場合、タイムアウトの場合は除外しません。
- **不安定なテスト（`flakyRetries`）:** green 期待で失敗したコマンドを再実行し、合格すれば不安定なテストとして記録します。修正ループの回数には数えず、PR 本文の「テスト」に載せます。ラズパイでテストが遅い場合は `0` にできます。

### 仕様の確認（spec_gap）

レビューで「受け入れ条件が 2 通り以上に読め、どちらを取るかで実装やテストが変わる」点が見つかったら、レビュー担当は指摘ではなく**仕様の確認**として記録します。

1. すぐにユーザーへ解釈の候補を示して回答を求めます（ダイアログ。閉じた場合や RPC ではチャットで答えるか `/harness answer <回答>`）。修正ループの回数には数えません。
2. 回答は `decisions.md` に記録され、以降のレビューと指摘修正の入力になります。同じ質問は二度聞きません。Issue へのコメントは `issue-comment-draft.md` に**下書きだけ**作ります（投稿はしません）。
3. ブロッキング指摘も出ていれば指摘修正へ進みます。仕様の確認だけなら、決まった解釈で差分の全体をもう一度フルレビューします（新しいセッション。レビューの周回には数えません）。
4. 回答は PR 本文の「仕様の確認」に載ります。

### ドキュメント作成フロー

README・導入手順・運用手順・設計書など、**ドキュメントだけ**を書く・直すときのフローです。テストは無く、実装フローとは分けています。

| 工程 | 内容 | 次へ進む条件 |
|---|---|---|
| 構成案（`doc_outline`） | 情報源（コード・既存ドキュメント・ADR）を読み、読者・目的・作るファイル・章立てと根拠を `outline.md` に書く | **人間の承認**（`kind: outline`） |
| 執筆（`doc_write`） | 構成案どおりに書く。コマンド・設定項目・パスは実物で確かめる。`doc-report.md` に書いたファイルと情報源を残す | `doc-report.md` があり、**変更がドキュメントだけ**（git の差分で確認） |
| レビュー（`doc_review`） | 正確さ（実物で確認）・網羅性・分かりやすさ・構成・一貫性・手順と例・リンクを見る。2 周目以降は前回からの差分だけ | 修正必須の指摘が無い（最大 3 周、超えたらエスカレーション） |
| 指摘修正（`doc_fix`） | 指摘を直して `fix-N.md` を書く | `fix-N.md` があり、変更がドキュメントだけ |
| 完了（`doc_done`） | ドキュメントだけをコミット（件名 `ドキュメント: <テーマ>`）し、`pr-docs.md` のテンプレートで PR を作成（`git.pr` に従う） | — |

- **ドキュメント以外は変更できません。** 書けるのは `.md` `.mdx` `.markdown` `.rst` `.adoc` `.txt` のファイルと `docsDir` 配下だけです。bash でコードを変更しても、レビューへ進む前に git の差分で見つけて止めます。
- テストのツール（`harness_run_tests` など）は有効にせず、ベースラインも取りません。エスカレーションの選択肢にバグ修正フローは出ません。
- 作業ブランチは `docs-<テーマ>`（Issue なら `docs-<番号>-<タイトル>`）です。実装フローと同じく、開始前に開始元ブランチを pull します。
- プロセスごとのモデルは `doc_plan` / `doc_write` / `doc_review` / `doc_fix` で指定できます。

### テンプレート（Issue・PR・レビュー記録・ADR）

Issue 本文・PR 本文・レビュー記録（`review-N.md`）は、エージェントに自由に書かせず、**項目ごとに受け取って拡張がテンプレートから組み立てます**。
見出しの並びや書き方が毎回同じになり、すべて日本語で作成されます。

| テンプレート | 使われる場面 | 主な内容 |
|---|---|---|
| `issue.md` | Issue 登録（`harness_create_issues`） | 背景・目的 / スコープ（やること・やらないこと）/ 受け入れ条件（AC-1…）/ テスト観点 / 依存関係 / 参照 / 補足 |
| `review.md` | レビュー記録（`harness_record_review`） | 判定・重大度別の件数 / 所見 / 観点別の結果（コードとドキュメントで観点が違う）/ 指摘（観点・場所・修正必須・内容・修正案）/ 仕様の確認 |
| `pr-docs.md` | PR 作成（ドキュメント作成フロー完了時） | 概要 / 対象 / 作成・更新したドキュメント（git の変更ファイル）/ 確認した情報源 / レビュー履歴 / 見てほしい点 / 未確定事項 / `Closes #N` |
| `pr.md` | PR 作成（実装フロー完了時・`/harness pr`） | 概要 / 関連 Issue / 受け入れ条件の充足 / 変更内容 / テスト（ベースライン・不安定なテストを含む）/ テストの変更 / レビュー履歴 / 仕様の確認 / 設計判断（ADR）/ 見てほしい点 / 既知の制約 / `Closes #N` |
| `adr.md` | ADR（`harness_record_decision`） | ステータス・日付・記録したプロセス・作業・関連・置き換え / 背景・課題 / 決定 / 検討した選択肢（利点・欠点・採用）/ 結果・影響 / 見直す条件 |

- PR 本文の概要・受け入れ条件の充足・変更内容などは、実装レポート（`implementation.md`）の同じ見出しから取ります。テスト結果とレビュー履歴は拡張が記録したものを使います。
- 空の項目は「なし」と表示し、見出しは省きません。
- **プロジェクトごとに変える:** 同梱の `~/piHarness/templates/<名前>.md` を `.pi/harness/templates/<名前>.md`（`workDir` 配下）にコピーして編集します。
  `{{名前}}` が値に置き換わります（使える名前は各テンプレート先頭のコメントに記載）。`{{名前?}}` は空なら何も出しません。

### 設計判断の記録（ADR）

要件定義書作成・プラン作成・TDD 実装・指摘修正・バグ修正の中で**重要な設計判断をしたとき**、エージェントは `harness_record_decision` で ADR を記録します。

- **対象:** ライブラリ・フレームワーク・外部サービスの採用や変更、データ構造・保存形式・スキーマ、モジュール境界・アーキテクチャ、外部インターフェース（API・CLI・設定）の互換性、セキュリティ・性能（Pi 5）のトレードオフ、要件やプランからの意図的な逸脱など、後から理由を知りたくなる・元に戻しにくい決定。命名や小さなリファクタは対象外です。
- **形を揃える:** 背景・決定・検討した選択肢（採用しなかった案を含めて 2 つ以上、採用はちょうど 1 つ）・影響・見直す条件を項目で受け取り、テンプレート（`adr.md`）で `docs/adr/0001-<タイトル>.md` を作ります。一覧 `docs/adr/README.md` も拡張が更新します。フロー中は ADR ディレクトリを直接編集できません。
- **既存の判断に従う:** 後のプロセスの開始メッセージに ADR 一覧が参照として載り、判断の前に関連する ADR を確認します。変えるときは `supersedes` で置き換え、古い ADR は「置き換え済み」になります。
- **人が確かめる場所:** 要件定義・プランの承認ダイアログに、その作業で記録した ADR が表示されます（承認に含まれます）。フルレビューは ADR の根拠と、実装が従っているかを確認し、重要な判断に ADR が無ければ指摘します。PR 本文にも ADR の一覧が入り、ADR のファイルは実装と一緒にコミットされます。
- 無効にするには `.pi/harness.json` で `"adr": false` にします。

### Issue の進み具合

要件定義で登録した Issue は、依存関係とともに `.pi/harness/issues.json` に記録されます。
`/impl` で「実装中」、レビュー通過で「完了」になり、GitHub で閉じられた Issue も完了として扱います。
`/impl next` は、登録順で最初の「未着手かつ依存がすべて完了した Issue」を選んで開始します。gh が無い環境で `docs/issues/*.md` に保存された Issue も対象です。

### モデル利用量

各セッションのトークン数と費用を、作業ディレクトリの `usage.json` にプロセスごとに記録します。
`/harness usage` で表示でき、実装フローや要件定義フローの完了時の報告にも合計を含めます。
モデルの割り当て（安価なモデル・高性能なモデル）の効果を確認するのに使えます。

### プロセスごとのモデル（`models`）

各プロセスは独立したセッションなので、プロセスごとに別のモデルと思考レベルを使えます。
新しいセッションの開始時に、そのプロセスの設定が適用されます。設定は Pi の既定モデルを変えず、そのセッションにだけ効きます。

| キー | 対象プロセス |
|------|-------------|
| `default` | 個別指定のないプロセス全体 |
| `hearing` | 要件ヒアリング（質問の繰り返し。ターン数が多いので安価なモデル向き） |
| `requirements` | 要件定義書・設計概要・Issue 分割案の作成と承認依頼（高性能モデル向き） |
| `issues` | Issue 登録 |
| `plan` | Issue/コード読込・テスト/実装プラン作成 |
| `implement` | TDD 実装 |
| `review` | コードレビュー（各周回） |
| `review_full` / `review_light` | レビューの 1 周目（フル）/ 2 周目以降（軽量）だけを別に指定（`review` より優先） |
| `fix` | レビュー指摘修正（各周回） |
| `bugfix` | バグ修正 |
| `doc_plan` / `doc_write` / `doc_review` / `doc_fix` | ドキュメントの構成案作成 / 執筆 / レビュー / 指摘修正 |

- 値は `"provider/model-id"` の文字列、その配列、または `{ "model": ..., "thinking": "high" }`。
  `model-id` だけでも、プロバイダーが一意に決まれば指定できます。
- **配列はフォールバック候補**です。先頭から順に、見つかって認証が設定されている最初のモデルを使います（例: `["google/gemini-flash-latest", "ollama/qwen3:8b"]`）。
- `thinking` は `off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max` から選びます。モデルの対応範囲に丸められます。
- プロセス個別の指定にない項目は `default` の値を使います。どちらにもなければ Pi の既定値のままです。
- 候補がすべて使えない場合（見つからない・認証が未設定）は、警告を出して既定のモデルで続行します。
- `/harness models` で各プロセスに実際に使われるモデルと、利用上限で避けているプロバイダーを確認できます。利用可能なモデルの一覧は `pi --list-models` で確認できます。

#### 利用上限での切り替え（`fallback`）

pi は一時的なエラー（429・overloaded・5xx など）を自分で数回再試行しますが、サブスクリプションや利用枠の上限（OpenCode Go の月間上限、ChatGPT サブスクリプションの上限、`insufficient_quota` など）は再試行せず、そのまま止まります。
piHarness はそのエラーで止まったプロセスを見つけて、次のように続けます。

1. そのプロバイダーを「上限」として `.pi/harness/provider-status.json` に記録します。解除の時刻はエラーの本文（`Try again in 2 hours` など）から読み、読めなければ `quotaCooldownMinutes`（混雑・レート制限なら `transientCooldownMinutes`）だけ避けます。
2. そのプロセスの models の候補から、上限中でない次のモデルに切り替え、**同じセッションで**「中断したところから続けて」と送り直します（会話は引き継がれます）。
3. 以降のプロセスも、解除されるまではそのプロバイダーの候補を飛ばします。
4. 候補がすべて上限なら、解除の目安を表示して止まります。解除後に「続けて」と伝えてください。

例えば `"default": ["opencode-go/kimi-k3", "openai/gpt-6.1-sol"]` のように**別のプロバイダーの候補を並べておく**と、片方の上限に達しても作業が止まりません。認証エラー（401 など）は切り替えの対象にしません（`/login` で直してください）。

例えば「ヒアリングは安価な Flash 系モデル、要件定義書作成は高性能モデル」「計画とレビューは高性能モデル、実装は速いモデル」「ラズパイ上のローカル LLM（Ollama など）は Issue 登録のような軽いプロセスだけ」といった使い分けができます。

成果物の md ファイルは Issue ごとの作業記録としてコミットしても構いません。状態ファイル・テストログ・テストのロックの記録は `.gitignore` を推奨します（`commitArtifacts: true` でも、テストのロックの記録はコミットしません）:

```gitignore
.pi/harness/state.json
.pi/harness/**/logs/
.pi/harness/**/test-lock/
```

## 開発

piHarness 自体を変更するときの構成・守ること・Pi の落とし穴は [AGENTS.md](AGENTS.md) にまとめています（このリポジトリで pi を起動すると自動で読み込まれます）。

```bash
npm install
npm run typecheck   # tsc
npm test            # 状態機械・ガード・設定・Git・テスト保護・テストのロック・失敗の指紋・進み具合・利用量・セットアップスクリプトのユニットテスト (node --test)
npm run test:e2e    # 偽モデルで実際の Pi セッションランタイムを動かし、4 フロー・セッション切り替え・自動圧縮・利用上限でのモデルの切り替えを通す E2E
npm run check       # 上記すべて
```

ラズパイでの `npm install` はネイティブモジュールのビルドを含む場合があるため、時間がかかることがあります（`typescript` と pi 本体は開発時の型チェック・E2E 用で、拡張の実行には不要です）。
