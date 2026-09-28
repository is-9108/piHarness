# piHarness

[pi-coding-agent](https://pi.dev) 用のワークフロー制御拡張（TypeScript Extension）と Skill 群です。
AI エージェントに次の 3 つのフローを「手順書」だけでなく **状態機械とゲートで強制** させます。

| フロー | 開始 | 概要 |
|-------|------|------|
| 1. 要件定義 | `/req <テーマ>` | 仕様が明確になるまで質問（ヒアリング）→ 要件定義書・設計概要・Issue 分割案 → **人間の承認ゲート** → 機能単位の小さな GitHub Issue を登録（ヒアリング / 要件定義書作成 / Issue 登録は別セッション） |
| 2. TDD 実装 | `/impl <Issue番号>` | Issue とコードベースを読込 → テストプラン/実装プラン → **人間の承認** → Red/Green/Refactor → テスト修正ループ（最大 3 周）→ 多角的コードレビューループ（最大 3 周、2 周目以降は軽量）|
| 3. バグ修正 | `/bugfix <説明>` | エスカレーション時にユーザー判断で起動。再現テスト → 根本原因分析 → 修正 → 検証 → **実装フローへ合流** |

ループ上限に達するとエージェントは自走をやめ、ユーザーに判断（ループ継続 / バグ修正フロー / 手動対応 / 中止）を求めます。

**各プロセス（要件ヒアリング / 要件定義書作成 / Issue 登録 / プラン作成 / TDD 実装 / レビュー / 指摘修正 / バグ修正）は独立したセッションで実行され、
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

### A. プロジェクトごとに clone して使う（推奨）

各プロジェクトの `.pi/piHarness/` に clone し、セットアップスクリプトを 1 回実行します。

```bash
cd ~/projects/my-app
git clone https://github.com/is-9108/piHarness.git .pi/piHarness
node .pi/piHarness/scripts/install.mjs
pi        # 起動してプロジェクトを信頼（trust）する
```

セットアップスクリプトは次のことを行います。何度実行しても結果は同じです。

| 対象 | 内容 |
|------|------|
| `.pi/settings.json` | `packages` に `"./piHarness"` を追加（既存の設定・パッケージは保持） |
| `.pi/harness.json` | 無ければ雛形を作成（あれば変更しない）。プロジェクトごとのテストコマンド・モデルはここで設定 |
| `.gitignore` | `.pi/harness/state.json`, `.pi/harness/**/logs/`, `.pi/piHarness/` を追加 |
| 環境チェック | Node.js 22.19 以上・pi・gh（ログイン状態）を確認して表示 |

- **更新:** `git -C .pi/piHarness pull`（pi 起動中なら `/reload`）
- **取り外し:** `node .pi/piHarness/scripts/install.mjs --uninstall` で登録だけを外します（成果物と設定は残ります）
- **確認のみ:** `--dry-run` で変更内容だけを表示します
- **別の場所に clone した場合:** `node <clone先>/scripts/install.mjs --project <プロジェクト>` で相対パスを自動計算します

チームで同じバージョンを使いたい場合は、clone の代わりに git サブモジュールにできます。
この場合、スクリプトは `.pi/piHarness/` を `.gitignore` に入れません。

```bash
git submodule add https://github.com/is-9108/piHarness.git .pi/piHarness
node .pi/piHarness/scripts/install.mjs
```

補足:

- **プロジェクトごとに独立:** ワークフローの状態（`.pi/harness/state.json`）・成果物・設定（`.pi/harness.json`）はプロジェクトごとに独立しています。
  プロジェクトごとに別のバージョンの piHarness を使うこともできます。
- **本体は編集できない:** エージェントはプロジェクト内の piHarness 本体（`.pi/piHarness/`）を編集できません（拡張がブロックします）。
- **依存パッケージは不要:** clone 先で `npm install` は不要です。必要なパッケージは Pi 本体が提供します。

### B. 全プロジェクト共通で使う

1 か所に clone して、ユーザー設定に登録します。全プロジェクトで同じ piHarness が有効になります。

```bash
git clone https://github.com/is-9108/piHarness.git ~/piHarness
pi install ~/piHarness
```

### C. 一時的に読み込む

```bash
pi -e ~/piHarness/extensions/harness/index.ts
```

### piHarness 自体の開発

このリポジトリの `.pi/settings.json` が自分自身を読み込むよう設定されています。リポジトリ直下で `pi` を起動し、プロジェクトを信頼してください。

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
| `/impl <番号 \| URL \| docs/issues/*.md>` | TDD 実装フローを開始（作業ブランチを作成。GitHub の Issue は `gh issue view` で本文を取得） |
| `/impl next` | 依存関係から次に着手できる Issue を選んで開始 |
| `/bugfix [説明]` | バグ修正フローを開始（実装フロー中/エスカレーション中なら完了後に合流） |
| `/harness status` | 現在のフロー・フェーズ・プロセスの入出力成果物・ループ回数・最近のイベント |
| `/harness next [指示]` | 次のプロセス（または中断中の現在のプロセス）を新しいセッションで開始（`autoHandoff: false` 時や pi 再起動後） |
| `/harness approve [コメント]` | 承認待ちのドキュメント/プランを承認（ダイアログを閉じた場合や RPC 利用時） |
| `/harness revise <修正内容>` | 修正を依頼 |
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
| `harness-hearing` | 要件ヒアリング（質問の観点、hearing.md テンプレート） |
| `harness-requirements` | 要件定義書・設計概要・Issue 分割案の作成と承認（テンプレート、Issue 分割ルール） |
| `harness-issues` | Issue 登録（Issue 本文テンプレート） |
| `harness-plan` | Issue・コード読込とテスト/実装プラン（plan.md テンプレート） |
| `harness-tdd` | TDD 実装（Red/Green/Refactor、失敗時の分析、implementation.md テンプレート） |
| `harness-review` | フルレビュー（観点、重大度、観点チェックリスト） |
| `harness-review-light` | 軽量レビュー（前回指摘の解消と差分の確認） |
| `harness-fix` | レビュー指摘の修正（fix-N.md テンプレート） |
| `harness-bugfix` | バグ修正（再現 → 根本原因分析 → 修正 → 合流、バグレポートテンプレート） |

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
  "issueRepo": "owner/repo",
  "issueLabels": [],
  "ensureLabels": true,
  "testOutputLines": 120,
  "autoHandoff": true,
  "testIntegrity": true,
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
    "dirtyStart": "ask"
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
| `workDir` | .pi/harness | 状態ファイルと、作業項目ごとの成果物（プラン・実装レポート・レビュー記録・テストログ・バグレポート）の出力先 |
| `issueRepo` | カレントリポジトリ | Issue 登録・PR 作成先 |
| `issueLabels` | [] | 全 Issue に付与するラベル |
| `ensureLabels` | true | 存在しないラベルを自動作成 |
| `testOutputLines` | 120 | モデルに渡すテスト出力の末尾行数（全文はログに保存） |
| `autoHandoff` | true | プロセス完了時に自動で新しいセッションを開始する。false なら `/harness next` で手動開始 |
| `testIntegrity` | true | テストを弱める変更を検知して理由の記録を求める（下記） |
| `compaction` | 有効・60% | コンテキスト使用率がしきい値を超えたら区切りで圧縮し、スキルと成果物の一覧を送り直して再開（下記） |
| `issueLimits` | AC 5 個・S/M・テスト 12 件 | Issue とプランの大きさの上限（下記） |
| `git` | 下記 | Git 連携（作業ブランチ・差分の基準・コミット・PR） |
| `models` | {} | プロセスごとのモデル・思考レベル（下記） |

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

1. **開始時:** `/impl` で作業ブランチ（`issue-12-add-login` など。タイトルが日本語だけなら `issue-12`）を作成し、開始時点のコミットを**差分の基準**として記録します。
   - 作成元（= PR のマージ先）は `baseBranch`、未指定なら現在のブランチです。前の Issue の作業ブランチ上にいる場合は、既定ブランチ（`origin/HEAD` / `main` / `master`）から作るか、積み上げるかを確認します（UI が無ければ既定ブランチ）。
   - 既存のブランチなら切り替えて再開します。未コミットの変更がある場合は確認します（`dirtyStart`: `ask` / `allow` / `refuse`）。
2. **作業中:** レビュー・修正・バグ修正の各セッションには「`git diff <基準>` で差分を確認する」と案内します。関係ない変更がレビューに混ざりません。
3. **完了時:** レビューを通過すると変更をコミットします（件名 `タイトル (#12)`、本文に `Closes #12`）。成果物（`.pi/harness/`）は既定ではコミットしません（`commitArtifacts`）。
4. **PR:** `pr` に従います。
   - `ask`（既定）: 確認ダイアログで承認したときだけ、push して開始時のブランチへの PR を作成します。PR の本文は実装レポートとレビュー履歴から作ります。
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

- 値は `"provider/model-id"` の文字列、その配列、または `{ "model": ..., "thinking": "high" }`。
  `model-id` だけでも、プロバイダーが一意に決まれば指定できます。
- **配列はフォールバック候補**です。先頭から順に、見つかって認証が設定されている最初のモデルを使います（例: `["google/gemini-flash-latest", "ollama/qwen3:8b"]`）。
- `thinking` は `off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max` から選びます。モデルの対応範囲に丸められます。
- プロセス個別の指定にない項目は `default` の値を使います。どちらにもなければ Pi の既定値のままです。
- 候補がすべて使えない場合（見つからない・認証が未設定）は、警告を出して既定のモデルで続行します。
- `/harness models` で各プロセスに実際に使われるモデルを確認できます。利用可能なモデルの一覧は `pi --list-models` で確認できます。

例えば「ヒアリングは安価な Flash 系モデル、要件定義書作成は高性能モデル」「計画とレビューは高性能モデル、実装は速いモデル」「ラズパイ上のローカル LLM（Ollama など）は Issue 登録のような軽いプロセスだけ」といった使い分けができます。

成果物の md ファイルは Issue ごとの作業記録としてコミットしても構いません。状態ファイルとテストログは `.gitignore` を推奨します:

```gitignore
.pi/harness/state.json
.pi/harness/**/logs/
```

## 開発

```bash
npm install
npm run typecheck   # tsc
npm test            # 状態機械・ガード・設定・Git・テスト保護・進み具合・利用量・セットアップスクリプトのユニットテスト (node --test)
npm run test:e2e    # 偽モデルで実際の Pi セッションランタイムを動かし、3 フロー・セッション切り替え・自動圧縮を通す E2E
npm run check       # 上記すべて
```

ラズパイでの `npm install` はネイティブモジュールのビルドを含む場合があるため、時間がかかることがあります（`typescript` と pi 本体は開発時の型チェック・E2E 用で、拡張の実行には不要です）。
