# Octestra

**GitHub Actions と Projects 上で完結する、サーバーレスな AI エージェントオーケストレーション。**

issue を `In Progress` に動かすと、エージェントが実装し、プルリクエストを開き、検証が走り、人間にレビューが
依頼されます。すべてタスクの状態が駆動し、サーバーもキューもデータベースも不要です。

📖 [English](README.md) · [設計メモ](docs/design.md) · [用語集](docs/glossary.md)

```
issue #42 ──▶ In Progress ──▶ agent ──▶ pull request ──▶ validation ──▶ review ──▶ Done
```

## なぜ Octestra か

### 1. エージェントの実行ではなく、その後の受け渡しを自動化する

エージェントを走らせること自体は簡単です。時間を取られるのはその後です。成果をプルリクエストにし、検証を
通し、適切な人の前に出し、そのどこかが失敗したときにどうするかを決める部分です。

Octestra はこの連鎖をタスクの状態グラフで駆動します。実装から検証へ、検証からレビューへ受け渡し、マージが
タスクを閉じます。各遷移は issue の現在の状態と照合されるため、古い変更や不正な変更は何も起動しません
（同じブランチに2体目のエージェントが乗ることがない）。失敗は誰も読まないログではなく、実行へのリンク付きで
`Blocked` に残ります。

### 2. GitHub の上だけで動くので、デプロイするサーバーがない

状態は issue のフィールド。スケジューリングは GitHub 自身のイベント。実行環境はすでに持っている Actions の
runner。デプロイするものも、生かし続けるものも、二重に管理する権限モデルもありません。アンインストールは
ワークフローのファイルを消すことです。

これは Actions で自作もできます。魔法は何もありません。Octestra が渡すのは、揃った状態の部品一式です。遷移の
ガード、7状態のグラフ、担当者の割り当て、ブランチ名の解決、プルリクエストの探索、レビューの振り分け、失敗
からの回復。ここが数か月かかる部分で、しかもどれも間違えたときに静かに壊れます。

### 3. プロンプト・設定・結果が、レビューできる1箇所に集まる

エージェントの振る舞いは `.hbs` のプロンプトテンプレートと1つの `config.yml` にあります。3つのワークフロー
YAML に埋もれるのではなく、バージョン管理され、差分が読め、他のコードと同じようにプルリクエストでレビュー
できます。

検証エージェントが出力した JSON は、レビュアーが実際に読むコメントとして整形されます。「これは通ったのか、
何を根拠にそう言えるのか」に、Actions のログを開かずに issue 上で答えられます。Octestra が使う操作はどれも
単体で呼べるので、別の形のワークフローを組むこともできます。

## 提供するもの、しないもの

| 提供する | 提供しない |
|---|---|
| GitHub issue のフィールド上で動く7状態のタスクライフサイクル | エージェント本体 — Octestra はモデルを呼びません |
| 担当者の割り当て、ブランチ名、プルリクエストの探索、レビュー依頼 | スケジューラ — フィールドを動かすものが別に必要です |
| あなたのテンプレートから描画されるプロンプト | サーバー、ダッシュボード、キュー、データベース |
| 結果を issue に投稿する検証ステップ | リポジトリを横断するビュー |
| 失敗時の処理: 実行へのリンク付きコメントと `Blocked` への移動 | 受け入れ基準 — `passed` の意味は検証エージェントが決めます |
| カスタマイズを保つインストーラと更新コマンド | エージェントの記憶 — 毎回コールドスタートし、文脈は issue とプルリクエストです |
| | エージェントとトークンの分離（[セキュリティ](#セキュリティ)） |

## Symphony との比較

[openai/symphony](https://github.com/openai/symphony) は同じ問題に逆側から取り組んでいます。常駐サービスが
issue トラッカーを polling し、自らエージェントをディスパッチします。どちらの選択にも代償があります。

| | Octestra | Symphony |
|---|---|---|
| 形態 | GitHub Actions のワークフロー | 自分で動かすサービス |
| 作業を開始するもの | あなたが issue のフィールドを動かす | サービスがトラッカーを polling してディスパッチ |
| issue トラッカー | GitHub issues | トラッカーごとのアダプタ |
| エージェント | あなたが書く任意のステップ | Codex app-server を話すコーディングエージェント |
| ワークスペース | 実行ごとに新しい runner | ホスト上の issue ごとのディレクトリを再利用 |
| エージェントの文脈 | 実行ごとにリポジトリ・issue・プルリクエストから再構築 | 1つの生きた Codex スレッドに蓄積し、ターンをまたいで再利用 |
| 並行数・リトライ・バックオフ | GitHub の concurrency group | 独自のスケジューラ |
| 実行時間 | Actions の分数とジョブの上限 | ホストの制約のみ |
| 資格情報の置き場所 | GitHub Secrets | 動かしているホスト |
| 監査ログ | issue、プルリクエスト、Actions のログ | 独自のログとトラッカー |
| 導入 | インストーラのコマンド1つ | Elixir のリファレンスを動かす、または SPEC から実装する |

**Symphony を選ぶ**のは、人が介在せずにエージェントが作業を拾ってほしいとき、コールドスタートせずに蓄積された
文脈の中で反復してほしいとき、Actions の上限より長く走らせたいとき、あるいはトラッカーが GitHub でないとき。

**Octestra を選ぶ**のは、サービスを運用したくないとき、作業がすでに GitHub の issue にあり、各実行を新しい
runner で独立させ、文脈をプロセスではなく issue とプルリクエストに置きたいとき。

どちらも早期段階で、どちらも信頼できる環境を前提とし、どちらもエージェントをサンドボックスで囲っていません。

## こういうときに向いている

向いている:

- 大きな移行や一斉修正を、似たタスクに分割したいとき — EPIC issue 1つと、作業単位ごとの sub-issue。
- 仕様が固まった小さめのタスクが溜まっていて、1件ずつ付き添いたくないとき。
- すでに GitHub の issue と Projects で仕事をしているチーム。

別の手段を検討したほうがよい:

- エージェントを1回だけ動かしたいとき。[`claude-code-action`](https://github.com/anthropics/claude-code-action) を直接使ってください。
- 人が介在せずにエージェントが作業を拾ってほしいとき。[Symphony](#symphony-との比較) を参照。
- リポジトリが GitHub organization に属していないとき。
- リポジトリが public、または issue を編集できる全員を信頼できるわけではないとき。

## 仕組み

organization の Issue Field `AI Task Status` が状態を持ちます。これを変更するとワークフローの実行が始まります。

```
Todo ──▶ Ready ──▶ In Progress ──▶ Validation ──▶ Human Review ──▶ Done
            ▲            │              │                ▲
            │            └──────────────┴────────────────┘  skip_validation: true
            └──────────── Blocked ◀──── 上のいずれかが失敗したとき
```

| 状態 | 設定するのは | Octestra はそのあと |
|---|---|---|
| `Todo` | あなた | — |
| `Ready` | あなた | — |
| `In Progress` | あなた | エージェントを実行し、ブランチとプルリクエストを確認して次へ |
| `Validation` | Octestra | 検証エージェントを実行し、結果を投稿して次へ |
| `Human Review` | Octestra | レビューを依頼し、プルリクエストがマージされたら `Done` へ |
| `Blocked` | Octestra | 理由をコメント。`Ready` に戻せば再試行 |
| `Done` | Octestra | — |

作業は **EPIC issue** と、作業単位ごとの **task issue** で表します。EPIC の本文には配下のタスクが共有する設定と
指示を書きます。同梱のエージェントスキルが、計画からこの両方を書き起こします。

## 必要なもの

- **GitHub organization** に属するリポジトリ — Issue Field は organization 単位の機能です。
- 認証済みの [GitHub CLI](https://cli.github.com/)。
- `AI Task Status` フィールドを作る organization 管理者権限（初回のみ）。
- Contents・Issues・Pull requests に書き込み権限を持つ **GitHub App**。

## セキュリティ

Octestra は**メンバーを信頼できるプライベートリポジトリ**向けであり、その外では安全ではありません。

エージェントへの指示は issue の本文とリポジトリの内容から来ます。同じジョブの中で、エージェントは Contents・
Issues・Pull requests への書き込み権限を持つ GitHub App トークンを保持します。したがって:

- **`AI Task Status` を変更できる人は、エージェントを実行できます。** 書き込み権限と同等に扱ってください。
- issue の本文を編集できる人が、エージェントへの指示内容を決められます。
- ライフサイクルのステップがエージェントと同じジョブにあるため、乗っ取られたエージェントはタスクの状態を
  動かし、Octestra としてコメントすることもできます。
- `passed` は検証エージェントが自分の作業について述べた主張であり、独立した検査ではありません。

エージェントと特権トークンの分離は**未実装**です。実装されているのは、`secrets: inherit` をどこでも使わない
こと、App トークンをそれぞれ自分のリポジトリに限定すること、そして秘密鍵を Octestra のコードが一度も読まない
ことです。

## インストール

タスクを実行するリポジトリのルートで:

```sh
curl -fsSL https://raw.githubusercontent.com/ainame/octestra/refs/heads/main/install.sh | bash
```

続いて GitHub App をインストールし、その秘密鍵を `OCTESTRA_GITHUB_APP_PRIVATE_KEY` という Actions secret に
保存します。インストーラを再実行しても `config.yml` とカスタマイズした内容は保たれます。

| フラグ | 効果 |
|---|---|
| `--org NAME` | フィールドを持つ organization。既定では推測します。 |
| `--status-field NAME` | 使用または作成するフィールド。既定は `AI Task Status`。 |
| `--fork` / `--repository OWNER/REPO` | `ainame/octestra` ではなく自分の organization の fork を呼びます。 |
| `--ref REF` | タグやブランチに固定します。既定は最新のバージョンタグ。 |
| `--enable-oidc` | クラウドのロール用に `id-token: write` を有効にします。 |
| `--skill-target claude\|codex\|agents` | EPIC セットアップスキルの設置先。 |
| `--yes` | 既定値をそのまま使います。 |

## インターフェース

タスクを動かすステップは Octestra が持ち、エージェントはあなたが持ちます。境界はこれだけです。

### あなたが用意する

| 場所 | 内容 |
|---|---|
| in-progress ワークフローの `agent-steps` | 実装エージェントの準備と呼び出し |
| validation ワークフローの `agent-steps` | 同じもの。成果物のアップロードも |
| 両方の `agent-credentials` | それらのステップが必要とする secret ごとの `secrets:` 宣言 |
| `octestra-lifecycle.yml` の `in-progress-secrets`・`validation-secrets` | その secret を渡す記述 |
| `.github/octestra/prompts/*.md.hbs` | 各エージェントへの指示 |
| `.github/octestra/config.yml` | runner、App のクライアント ID、ブランチのテンプレート、プロンプトのパス |

これらの名前はいずれも **custom region** を示します。`# octestra:custom:begin <name>` と
`# octestra:custom:end <name>` に挟まれた行のことです。更新はその内側を保ち、それ以外を置き換えます。

### Octestra が用意する

in-progress ワークフローで、あなたのステップの前に:

| 名前 | 内容 |
|---|---|
| `steps.epic.outputs.prompt` | 描画済みのタスクプロンプト |
| `steps.epic.outputs.branch_name` | エージェントが push すべきブランチ。これ以外は探されません |
| `steps.epic.outputs.task_ready` | 既存の作業で中断したときに `false`。ステップの実行条件に使ってください |
| `steps.epic.outputs.draft_flag` | `--draft`、または空 |
| `steps.epic.outputs.skip_validation` | `Validation` を飛ばすかどうか |
| `steps.epic.outputs.task_owner` | issue の担当者 |
| `steps.epic.outputs.epic_id`・`parent_number`・`skill_name`・`target_file` | EPIC の id と issue 番号、指定されたスキル、タスクの対象 |
| `env.OCTESTRA_AGENT_GITHUB_TOKEN` | エージェント用の GitHub トークン |

validation ワークフローで、あなたのステップの前に:

| 名前 | 内容 |
|---|---|
| `steps.epic.outputs.prompt` | 描画済みの検証プロンプト |
| `steps.epic.outputs.pull_number` | 検証対象のプルリクエスト。すでに checkout 済み |
| `steps.epic.outputs.result_path` | エージェントが結果を書き込む先 |
| `steps.epic.outputs.artifact_path` | スクリーンショットやログなどの証跡の置き場所 |
| `steps.epic.outputs.branch_name`・`parent_number`・`target_file` | ブランチ、EPIC の issue 番号、対象 |
| `env.OCTESTRA_AGENT_GITHUB_TOKEN` | エージェント用の GitHub トークン |

Claude Code Action の場合は、ブランチ名をそのまま通します。

```yaml
- uses: anthropics/claude-code-action@v1
  with:
    github_token: ${{ env.OCTESTRA_AGENT_GITHUB_TOKEN }}
    branch_prefix: ${{ steps.epic.outputs.branch_name }}
    branch_name_template: "{{prefix}}"
    prompt: ${{ steps.epic.outputs.prompt }}
```

### これは壊さないでください

| 守ること | 破ると |
|---|---|
| `branch_name` そのものを push する | ブランチが見つからず、issue にコメントして `Blocked` へ |
| そのブランチからプルリクエストを開く | `PR not found for branch …` で失敗し、`Blocked` へ |
| `outcome` と `summary` を JSON で `result_path` に書く | ファイルが読めず、`Blocked` へ |
| 成功時の `outcome` はちょうど `passed` | それ以外の値はすべて `Blocked` へ |
| 検証エージェントはブランチもコミットも作らない | checkout 済みのプルリクエストの HEAD 上です。push しても後始末されません |
| `Prepare …` を最初、`Finalize …` を最後に、どちらもマーカーの外に置く | あなたのステップは `steps.epic.outputs` を読み、finalize はその結果を報告します |
| custom region の中から他のステップの id を参照しない | 将来そのステップが移動され、GitHub は解決できない参照を空文字にします |
| `secrets: inherit` を使わない | エージェントを実行するジョブに organization のすべての secret を渡します |
| `octestra-lifecycle.yml` の permissions を、呼ぶ全ワークフローの上位集合に保つ | ジョブが1つも始まらないまま `startup_failure`。ログも残りません |

## タスクの設定

EPIC issue の本文に、配下のタスクが継承するブロックを書きます。

````markdown
```epic-config
id: ios-swift6            # 必須。小文字のスラグで、タスクのブランチ名の名前空間になります
skill: swift-concurrency  # 任意。プロンプトから使えるエージェントのスキル
draft_pr: false           # プルリクエストを draft で開くか
skip_validation: false    # Validation を飛ばして Human Review へ直行するか
```

```epic-prompt
この EPIC のすべてのタスクが受け取る指示。
```

```validation-prompt
検証エージェントが受け取る指示。
```
````

task issue には `task-config`（任意の `target`）と `task-prompt` を書けます。どちらのプロンプトも EPIC のものに
追記されます。

> 検証ワークフローに実際のエージェントを入れるまでは `skip_validation: true` にしてください。同梱の
> プレースホルダは意図的に失敗します。

`config.yml` には runner、App のクライアント ID、ブランチのテンプレート
（`octestra/{epic_id}/issue-{issue_number}`）、プロンプトのパスがあります。うち4つの値はリポジトリ変数にも
コピーされます。ワークフローがファイルを読む前に必要になるからです。ファイルを編集したら
`octestra.sh vars sync` を実行してください。

## 検証結果のファイル

検証エージェントは `result_path` に JSON を書きます。必須は `outcome` と `summary` だけです。Octestra はこれを
issue のコメントとして整形し、`outcome` を読んでタスクの行き先を決めます。

```json
{
  "outcome": "passed",
  "summary": "すべてのチェックが通りました。",
  "checks": [
    { "name": "unit tests", "kind": "test", "result": "passed", "evidence": "3 packages" }
  ],
  "details": "実行したコマンドと、レビュアーが知るべきことを Markdown で。"
}
```

`acceptance`・`checks`・`evidence`・`artifacts`・`knownGaps`・`details` は任意です。未知のフィールドは無視
されるので、自由に拡張できます。

## インストールの保守

```sh
.github/octestra/octestra.sh doctor          # 問題をすべて報告。あれば非ゼロ終了
.github/octestra/octestra.sh vars check      # 変数が config.yml と一致しなければ非ゼロ終了
.github/octestra/octestra.sh vars sync       # config.yml の値を変数へ書き込む
.github/octestra/octestra.sh ref             # ワークフローが呼ぶ Octestra を表示
.github/octestra/octestra.sh update --latest # 最新のバージョンタグから再インストール
```

`doctor` は読み取りのみで、放置すると静かに壊れるものを拾います。古くなった、または未設定の変数、名前が
変わったフィールド、欠けている状態の選択肢、有効なのにワークフローファイルが無いジョブ、存在しない場所を指す
プロンプトのパス、対応が無いマーカー。

`update` は対象バージョンをダウンロードし、**そのバージョンの**インストーラを実行します。更新では常に新しい
ロジックが走るということです。結果は `git diff` で確認してからコミットしてください。

## 操作一覧

各ステップは `operation:` 入力で指定した操作を1つ実行します。**aggregate** は複数の処理を1つの名前でまとめた
もので、生成されるワークフローはこちらを使います。**individual** はその構成要素を単体で使うもので、別の順序が
必要なリポジトリのためにあります。

| 種類 | 操作 | 動作 |
|---|---|---|
| Guard | `lifecycle/validate-transition` | 状態変更を issue の現在の状態と照合します。人による不正な変更は、その人に割り当てて説明します。 |
| Aggregate | `lifecycle/prepare-task` | 担当者を割り当て、ブランチやプルリクエストが既にあれば中断し、プロンプトを描画し、co-author trailer を設定します。 |
| Aggregate | `lifecycle/finalize-task` | ブランチとプルリクエストを解決し、次が人間ならレビューを依頼し、状態を更新してコメントします。 |
| Aggregate | `lifecycle/prepare-validation` | プルリクエストを解決し、プロンプトを描画し、結果と証跡のパスを公開します。 |
| Aggregate | `lifecycle/finalize-validation` | 結果を投稿します。`passed` ならレビューを依頼して `Human Review` へ、それ以外は `Blocked` へ。 |
| Aggregate | `lifecycle/finalize-merged-task` | `Human Review` のタスクを、プルリクエストのマージ時に `Done` へ移動します。 |
| Aggregate | `lifecycle/report-failure` | 実行へのリンクをコメントし、タスクを `Blocked` へ移動します。 |
| Individual | `assign-owner` | 変更した人を割り当てます。ボットによる変更では既存の担当者を保ちます。 |
| Individual | `lifecycle/build-task-context` | 担当者の割り当てを除いた `prepare-task`。 |
| Individual | `lifecycle/build-validation-context` | `prepare-validation` のコンテキスト構築部分。 |
| Individual | `resolve-task-pr` | ブランチに対応する未クローズのプルリクエスト番号を公開します。 |
| Individual | `report-proof` | 結果ファイルを issue のコメントとして整形します。状態は変えません。 |
| Individual | `request-review` | プルリクエストを draft から外し、レビューを依頼します。 |
| Individual | `update-status` | フィールドを指定の状態に設定します。 |

## 開発

```sh
npm ci
make all
```

`make all` はコミット前に必ず通してください。`dist/index.js` を再生成します。これは Actions の実行時バンドル
なのでコミットされています。

このリポジトリを変更するための取り決めは [`AGENTS.md`](AGENTS.md) にあります。なぜこの形なのかは
[`docs/design.md`](docs/design.md)、用語は [`docs/glossary.md`](docs/glossary.md)、未着手の作業は
[`TODO.md`](TODO.md) にあります。

## ライセンス

[MIT](LICENSE)
