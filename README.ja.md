# Octestra

**サーバーレスな AI エージェントオーケストレーションフレームワーク。GitHub Actions と Projects の上に構築。**

何もデプロイせずに、多数のタスクへ多数のコーディングエージェントを流します。タスクの状態は GitHub issue の
フィールド。スケジューリングは GitHub 自身のイベント。実行環境はすでに持っている Actions の runner。生かし
続けるコーディネータも、キューも、データベースも、深夜に叩き起こされる対象もありません。

📖 [English README](README.md) · [設計メモ](docs/design.md) · [用語集](docs/glossary.md)

```
あなた: issue #42 を `In Progress` へ
                │
                ▼
   エージェントが実装 → プルリクエスト → 検証 → レビュー依頼 → マージ → Done
```

## Octestra を使う理由

### 1. サーバーが無い。動かすものが無いから

エージェントをオーケストレーションする他の方法は、何かを生かし続ける必要があります。コーディネータの
プロセス、ジョブキュー、どのタスクがどの状態かを保持するデータベース。いずれもデプロイし、監視し、守り、
費用を払う対象であり、あなたと作業の間に立つインフラです。

Octestra にはそれがありません。状態機械は organization の Issue Field なので、タスクの状態は GitHub が保存し、
GitHub のイベントがそのままスケジューラになります。ダッシュボードは既に存在するあなたの Project ボードです。
アンインストールはワークフローのファイルを消すこと。残り続けるサービスも、移行すべきデータも、二重に管理する
権限モデルもありません。アクセス制御は、あなたが既に運用している GitHub の権限そのものです。

### 2. エージェントは自由、こちらへのロックインも無い

Octestra はモデルを一切呼びません。面倒で間違えやすい側 — タスクの持ち主は誰か、作業はどのブランチにあるか、
プルリクエストを見つける、適切な人にレビューを依頼する、実行が失敗したときの回復 — を Octestra が担い、
エージェントへ渡すのはレンダリング済みのプロンプトと push すべきブランチだけです。

この境界こそが製品です。Claude Code から Codex へ、あるいはシェルスクリプトへ乗り換えるのは、1ファイルの
1ブロックを編集するだけ。エージェントの選択が移行作業になることはありません。

### 3. 既定でレビュー可能。だから成果物を本当に出荷できる

誰もレビューできないエージェントの出力は負債です。Octestra では、すべてのタスクがブランチ、プルリクエスト、
指名されたレビュアー、そして何が起きたかを記した issue のコメントを生みます。人間が `Done` へ動かさない限り
マージされません。失敗は消え去るのではなく、実行へのリンク付きで `Blocked` に残ります。

### 4. カスタマイズしても、更新を受け取り続けられる

生成された CI は、手を入れた瞬間から腐るのが普通です。次の更新が追加した配線を上書きするので、結果として誰も
更新しなくなります。Octestra はあなたが所有する部分に印を付け、`octestra.sh update` がその中身を新しい
バージョンへ運び、周囲だけを置き換えます。新しい Octestra の取り込みは、この先ずっとコマンド1つです。

## サーバーレスであることの実際

| | Octestra | サーバー型のオーケストレータ |
|---|---|---|
| タスクの状態の置き場所 | issue のフィールド | 自分で運用するデータベース |
| スケジューリング | GitHub の issue イベント | 生かし続けるコーディネータのプロセス |
| 実行環境 | 既にある Actions の runner | 自分で用意するワーカー |
| ダッシュボード | あなたの GitHub Project ボード | リポジトリの隣にある専用 UI |
| 監査ログ | issue、プルリクエスト、Actions のログ | 専用のストア（必要なら書き出す） |
| アクセス制御 | GitHub の権限 | 同期し続けるべき2つ目の権限モデル |
| やめるとき | ワークフローのファイルを消す | サービスを廃止する |

サーバーを持たないことで諦めるもの:

- **無人での起動はできません。** 誰か、あるいはあなたが追加するスケジュール実行のワークフローが、フィールドを
  変える必要があります。Octestra 自体はスケジューラを同梱しません。
- **一度に1リポジトリです。** 中央に保持するものが無いので、リポジトリ横断のビューもありません。
- **Actions の実行時間を消費します。** 長時間のエージェント実行は Actions の時間として課金されます。runner は
  ジョブごとに選べます。
- **GitHub 専用です。** 設計が Issue Field と `workflow_call` と不可分です。

## こういうときに向いている

向いているケース:

- 大きな移行や一斉修正を、似た単位の作業に分割したいとき — EPIC issue 1つと、作業単位ごとの sub-issue。
- 仕様が固まった小さめのタスクが溜まっており、1件ずつ付き添いたくないとき。
- すでに GitHub の issue と Projects で仕事をしていて、見る場所を増やしたくないチーム。

別の手段を検討したほうがよいケース:

- エージェントを1回だけ動かしたい場合。[`anthropics/claude-code-action`](https://github.com/anthropics/claude-code-action)
  を直接使うほうが早いです。
- リポジトリが GitHub organization に属していない場合。Octestra は organization の Issue Field
  （organization が issue に追加できるカスタムフィールド）で駆動します。
- リポジトリが public、または issue を編集できる全員を信頼できるわけではない場合。[セキュリティ](#セキュリティ)を参照。

## 仕組み

すべては issue 上の1つのフィールド — organization が持つ Issue Field `AI Task Status` — で駆動します。その
7つの選択肢がタスクの状態であり、このフィールドの変更がワークフローの実行を開始させます。

```
Todo ──▶ Ready ──▶ In Progress ──▶ Validation ──▶ Human Review ──▶ Done
            ▲            │              │                ▲
            │            └──────────────┴────────────────┘  skip_validation: true
            └──────────── Blocked ◀──── 上のいずれかが失敗したとき
```

| 状態 | 設定するのは | Octestra がすること |
|---|---|---|
| `Todo` | あなた | 何もしません。まだ着手できる状態ではないという意味です。 |
| `Ready` | あなた | 何もしません。あなたが開始するのを待っています。 |
| `In Progress` | あなた | 実装エージェントを実行し、ブランチとプルリクエストを確認して、`Validation` か `Human Review` へ移動します。 |
| `Validation` | Octestra | 検証エージェントを実行し、その結果を issue に投稿して、`Human Review` か `Blocked` へ移動します。 |
| `Human Review` | Octestra | プルリクエストを draft から外してレビューを依頼し、そのプルリクエストがマージされたら `Done` へ移動します。 |
| `Blocked` | Octestra | 何もしません。理由をコメントし、あなたが `Ready` に戻すのを待ちます。 |
| `Done` | Octestra | 何もしません。タスクは完了です。 |

作業は **EPIC issue** と、作業単位ごとの **task issue** で構成します。EPIC の本文には配下のタスクが共有する
設定と指示を書き、task issue には個別のものを書きます。インストーラが Claude Code や Codex 向けのスキルも
入れるので、計画からこの2種類を生成できます。50個の issue を手で作る必要はありません。

## 必要なもの

- **GitHub organization** に属するリポジトリ。Octestra は organization の Issue Field で駆動します。
- 認証済みの [GitHub CLI](https://cli.github.com/)。
- `AI Task Status` フィールドを作成するための organization 管理者権限（初回のみ）。互換性のある既存の
  フィールドがあれば、それを再利用できます。
- リポジトリの **Contents**・**Issues**・**Pull requests** に書き込み権限を持つ **GitHub App**。
- EPIC とタスクをボードで見たい場合は GitHub Project。

## セキュリティ

インストールする前に読んでください。Octestra は**メンバーを信頼できるプライベートリポジトリ**向けに作られて
おり、その外では安全ではありません。

エージェントは、task issue の本文、親 EPIC issue の本文、そしてリポジトリの内容を指示として受け取って動きま
す。同じジョブの中で、Octestra は Contents・Issues・Pull requests への書き込み権限を持つ GitHub App トークン
をエージェントに渡し、checkout はそのトークンをディスク上に残します。したがって現時点では:

- **`AI Task Status` フィールドを変更できる人は、エージェントを起動できます。** その権限は、リポジトリへの
  書き込み権限と同等に扱ってください。
- issue の本文を編集できる人が、エージェントへの指示内容を決められます。
- タスクを進めるステップがエージェントと同じジョブで動くため、エージェントが暴走した場合、タスクの状態変更や
  Octestra としてのコメント投稿も可能です。
- 検証エージェントは、渡されたプルリクエストを自分で判定し、自分で結果ファイルを書きます。`passed` はその
  エージェント自身の主張であって、独立した検査ではありません。

エージェントの実行と特権トークンの分離は未実装です。実装済みの対策は次のとおりです。`secrets: inherit` は
どこでも使っていないため、エージェントのジョブはそのワークフローが宣言し呼び出し側が渡した secret だけを
受け取ります。App トークンは実行中のリポジトリ1つに限定されます。App の秘密鍵は GitHub Actions Secrets に
留まり、Octestra のコードがその値を読むことはありません。

インストール前に2つ決めてください。誰にステータスフィールドの変更を許すか（それがエージェントを起動できる人
です）。そして、エージェントの資格情報がこのリポジトリの外のどこまで届くか。OIDC で引き受けるクラウドの
ロールやモデルの API キーは、エージェントと同じだけ露出します。

## インストール

タスクを実行するリポジトリのルートで実行します。

```sh
curl -fsSL https://raw.githubusercontent.com/ainame/octestra/refs/heads/main/install.sh | bash
```

`AI Task Status` フィールドを検出または作成し、ワークフロー、プロンプト、メンテナンス用の
`.github/octestra/octestra.sh`、EPIC セットアップスキルを書き込み、4つのリポジトリ変数を同期します。再実行
しても安全です。`config.yml` は保持され、[インターフェース](#インターフェース)が示す場所であなたがカスタマ
イズした内容も保持されます。

続いて、Contents・Issues・Pull requests への書き込み権限を持つ GitHub App をインストールし、その秘密鍵を
`OCTESTRA_GITHUB_APP_PRIVATE_KEY` という Actions secret に保存してください。各ワークフローは自分のリポジ
トリに限定したトークンを都度発行するので、App 側の追加設定は不要です。

| フラグ | 効果 |
|---|---|
| `--org NAME` | Issue Field を持つ organization。既定ではリポジトリから推測します。 |
| `--status-field NAME` | 使用または作成するフィールド名。既定は `AI Task Status`。 |
| `--fork` / `--repository OWNER/REPO` | `ainame/octestra` ではなく自分の organization の fork を呼びます。 |
| `--ref REF` | ワークフローが呼ぶタグやブランチを固定します。既定は最新のバージョンタグ。 |
| `--enable-oidc` | `id-token: write` を有効にします。OIDC でクラウドのロールを引き受ける場合に。 |
| `--skill-target claude\|codex\|agents` | EPIC セットアップスキルの設置先ディレクトリ。 |
| `--yes` | 確認なしで既定値を採用します。 |

生成されるワークフローは Octestra を action として呼ぶため、その `uses:` の参照先が「あなたのリポジトリで誰の
コードが動くか」を決めます。自分の fork を指せば、organization が管理するコードだけが動きます。その代わり
upstream の取り込みは自分の仕事になります。この選択は後から `octestra.sh ref` で変更できます。fork が
private の場合は、その Actions アクセスポリシーで呼び出し元リポジトリを許可する必要もあります。

## インターフェース

タスクを進めるステップは Octestra が持ち、エージェントはあなたが持ちます。両者の境界はこれだけです。
エージェントのステップを書く前に、一度目を通してください。

### あなたが用意するもの

| 場所 | 内容 |
|---|---|
| `octestra-lifecycle-in-progress.yml` の `agent-steps` | 実装エージェントの準備と実行のステップ。 |
| `octestra-lifecycle-validation.yml` の `agent-steps` | 検証エージェントについて同じもの。成果物のアップロードも。 |
| 両ファイルの `agent-credentials` | それらのステップが必要とする secret ごとの `on.workflow_call.secrets` 宣言。 |
| `octestra-lifecycle.yml` の `in-progress-secrets`・`validation-secrets` | 呼び出し側からその secret を渡す記述。 |
| `.github/octestra/prompts/*.md.hbs` | 各エージェントへの指示。 |
| `.github/octestra/config.yml` | 2つの runner、App のクライアント ID、ブランチのテンプレート、プロンプトのパス。 |

ここに挙げた名前はいずれも **custom region** を示します。custom region とは、対応する
`# octestra:custom:begin <name>` と `# octestra:custom:end <name>` のマーカーに挟まれた行のことです。更新は
その内側を保持し、それ以外をすべて置き換えます。つまり、外側に書いたものは失われます。region を引き継げない
場合、インストーラは以前のファイルを `<workflow>.yml.octestra-bak` として保存し、そのことを報告します。

### Octestra が渡すもの

`octestra-lifecycle-in-progress.yml` で、あなたのステップの前に:

| 名前 | 内容 |
|---|---|
| `steps.epic.outputs.prompt` | レンダリング済みのタスクプロンプト。 |
| `steps.epic.outputs.branch_name` | エージェントが push すべきブランチ。以降これ以外は探されません。 |
| `steps.epic.outputs.task_ready` | 既存のブランチや未クローズのプルリクエストで中断した場合に `false`。ステップの実行条件に使ってください。 |
| `steps.epic.outputs.draft_flag` | プルリクエストを draft にすべきときは `--draft`、そうでなければ空。 |
| `steps.epic.outputs.skip_validation` | このタスクが `Human Review` へ直行するかどうか。 |
| `steps.epic.outputs.task_owner` | issue の担当者。 |
| `steps.epic.outputs.epic_id`・`parent_number`・`skill_name`・`target_file` | EPIC の id、その issue 番号、指定されたスキル、タスクの対象。 |
| `env.OCTESTRA_AGENT_GITHUB_TOKEN` | エージェント用の GitHub トークン。 |

`octestra-lifecycle-validation.yml` で、あなたのステップの前に:

| 名前 | 内容 |
|---|---|
| `steps.epic.outputs.prompt` | レンダリング済みの検証プロンプト。 |
| `steps.epic.outputs.pull_number` | 検証対象の未クローズのプルリクエスト。すでに checkout されています。 |
| `steps.epic.outputs.result_path` | エージェントが結果を書き込むファイル。 |
| `steps.epic.outputs.artifact_path` | スクリーンショットやログなどの証跡を置くディレクトリ。 |
| `steps.epic.outputs.branch_name`・`parent_number`・`target_file` | タスクのブランチ、EPIC の issue 番号、タスクの対象。 |
| `env.OCTESTRA_AGENT_GITHUB_TOKEN` | エージェント用の GitHub トークン。 |

Claude Code Action を使う場合は、ブランチ名をそのまま通します。

```yaml
- uses: anthropics/claude-code-action@v1
  with:
    github_token: ${{ env.OCTESTRA_AGENT_GITHUB_TOKEN }}
    branch_prefix: ${{ steps.epic.outputs.branch_name }}
    branch_name_template: "{{prefix}}"
    prompt: ${{ steps.epic.outputs.prompt }}
```

### 壊してはいけないこと

| 守ること | 破ったときに起きること |
|---|---|
| エージェントは `branch_name` そのものを push する | ブランチが見つからず、エージェントが作らなかったとコメントして `Blocked` へ移動します。 |
| エージェントはそのブランチからプルリクエストを作る | 最終処理が `PR not found for branch …` で失敗し、タスクは `Blocked` へ移動します。 |
| 検証エージェントは `outcome` と `summary` を JSON で `result_path` に書く | 最終処理がファイルを読めずに失敗し、タスクは `Blocked` へ移動します。 |
| 成功時の `outcome` はちょうど `passed` | 他の値はすべて `Blocked` へ移動します。本当の失敗には正しく、タイプミスには静かな罠になります。 |
| 検証エージェントはブランチもコミットも作らない | checkout 済みのプルリクエストの HEAD を検証しています。ここからの push はどのライフサイクルにも属さず、後始末もされません。 |
| `Prepare …` と `Finalize …` のステップはマーカーの外に、最初と最後に置く | あなたのステップは `steps.epic.outputs` を読むので、prepare より前では何も動きません。finalize はあなたのステップの結果を報告するので、最後でなければなりません。 |
| custom region の中から他のステップを id で参照しない | 将来のバージョンがそのステップを移動でき、GitHub は解決できない参照をエラーではなく空文字にします。 |
| `secrets: inherit` はどこでも使わない | エージェントを実行するジョブに、organization のすべての secret を渡してしまいます。 |
| `octestra-lifecycle.yml` のワークフローレベルの `permissions:` は、呼び出す全ワークフローの上位集合を保つ | ジョブが1つも作られないまま実行全体が `startup_failure` になります。ログも注釈もなく、読めるものが残りません。 |

## タスクの設定

EPIC issue の本文には配下のタスクが継承するブロックを、task issue の本文には個別のものを書きます。

````markdown
```epic-config
id: ios-swift6            # 必須。小文字のスラグで、タスクのブランチ名の名前空間になります
skill: swift-concurrency  # 任意。プロンプトから使わせるエージェントのスキル名
draft_pr: false           # プルリクエストを draft で作るか
skip_validation: false    # 検証を通さず Human Review へ直行するか
```

```epic-prompt
この EPIC のすべてのタスクが受け取る指示。
```

```validation-prompt
検証エージェントが受け取る指示。
```
````

task issue には、任意の `target` を持つ `task-config` と、そのタスク固有の指示を書く `task-prompt` を置けま
す。どちらのプロンプトも EPIC のものに追記される形で渡されます。

> 検証ワークフローに実際のエージェントを入れるまでは `skip_validation: true` にしてください。同梱の
> プレースホルダは意図的に失敗するので、タスクが `Blocked` に移動します。

残りの設定は `.github/octestra/config.yml` にあります。2つの runner のラベル、App のクライアント ID、
ブランチのテンプレート（既定は `octestra/{epic_id}/issue-{issue_number}`）、プロンプトのパスです。このうち
4つの値はリポジトリ変数にもコピーされます。ワークフローがファイルを読む前に必要になる値だからです
（`OCTESTRA_GITHUB_APP_CLIENT_ID`・`OCTESTRA_ORCHESTRATION_RUNNER`・`OCTESTRA_AGENT_RUNNER`・
`OCTESTRA_STATUS_FIELD_ID`）。ファイルを編集したら `octestra.sh vars sync` を実行してください。

## 検証結果のファイル

検証エージェントは `result_path` に JSON を書きます。Octestra はこのファイルを **proof** と呼びます。必須は
`outcome` と `summary` だけです。Octestra はこれをレビュアー向けの issue コメントとして整形し、`outcome` を
読んでタスクの行き先を決めます。

```json
{
  "outcome": "passed",
  "summary": "すべてのチェックが通りました。",
  "checks": [
    { "name": "unit tests", "kind": "test", "result": "passed", "evidence": "3 packages" }
  ],
  "details": "実行したコマンドや、レビュアーが知るべきことを Markdown で。"
}
```

`acceptance`・`checks`・`evidence`・`artifacts`・`knownGaps`・`details` は任意で、あれば描画されます。未知の
フィールドは無視されるので、自由に拡張できます。Octestra は内容をあなたの受け入れ基準と照合しません。それは
あなたの領域のままです。

## インストールの保守

`.github/octestra/octestra.sh` が `config.yml` の隣に設置されます。必要なのは認証済みの GitHub CLI だけです。

```sh
.github/octestra/octestra.sh doctor          # 問題をすべて報告し、あれば非ゼロ終了
.github/octestra/octestra.sh vars check      # 変数が config.yml と一致しなければ非ゼロ終了
.github/octestra/octestra.sh vars sync       # config.yml の値を変数へ書き込む
.github/octestra/octestra.sh ref             # ワークフローが呼ぶ Octestra を表示
.github/octestra/octestra.sh update --latest # 最新のバージョンタグから再インストール
```

`doctor` は読み取りのみです。放置すると静かに壊れる種類の問題を拾います。`config.yml` と一致しなくなった、
あるいは一度も設定されていない変数、名前が変わったフィールド、欠けている状態の選択肢、有効なのにワークフロー
ファイルが存在しないジョブ、存在しないパスを指すプロンプト、対応するもう一方が無いマーカーです。

`update` は対象バージョンをダウンロードし、**そのバージョンの**インストーラをあなたのリポジトリに対して実行
します。更新では常に新しいロジックが走るということです。既存のインストールが記録している回答を再利用し、
最後に変数を同期します。結果は `git diff` で確認してからコミットしてください。

## 操作一覧

各ステップは `operation:` 入力で指定した Octestra の操作を1つ実行します。**aggregate** は複数の処理を1つの
名前でまとめたもので、生成されるワークフローはこちらを使います。**individual** はその構成要素を単体で使う
もので、別の順序が必要なリポジトリのためにあります。

| 種類 | 操作 | 動作 |
|---|---|---|
| Guard | `lifecycle/validate-transition` | 状態変更を issue の現在の状態と照合します。人が行った不正な変更は、その人に割り当てて説明し、タスクは動かしません。 |
| Aggregate | `lifecycle/prepare-task` | 担当者を割り当て、ブランチやプルリクエストが既にあれば中断し、タスクプロンプトを描画し、Git の co-author trailer を設定します。 |
| Aggregate | `lifecycle/finalize-task` | ブランチとプルリクエストを解決し、次が人間ならレビューを依頼し、状態を更新して結果をコメントします。 |
| Aggregate | `lifecycle/prepare-validation` | プルリクエストを解決し、検証プロンプトを描画し、結果と証跡のパスを公開します。 |
| Aggregate | `lifecycle/finalize-validation` | proof を投稿し、`passed` ならレビューを依頼して `Human Review` へ、それ以外は `Blocked` へ移動します。 |
| Aggregate | `lifecycle/finalize-merged-task` | `Human Review` のタスクを、そのプルリクエストがマージされたときに `Done` へ移動します。 |
| Aggregate | `lifecycle/report-failure` | 失敗した実行へのリンクをコメントし、タスクを `Blocked` へ移動します。 |
| Individual | `assign-owner` | 変更を行った人を割り当てます。ボットによる変更のときは既存の担当者を保ちます。 |
| Individual | `lifecycle/build-task-context` | `prepare-task` のうち、担当者割り当てを除いたコンテキスト構築の部分。 |
| Individual | `lifecycle/build-validation-context` | `prepare-validation` のコンテキスト構築の部分。 |
| Individual | `resolve-task-pr` | ブランチに対応する未クローズのプルリクエスト番号を公開します。 |
| Individual | `report-proof` | proof ファイルを issue コメントとして描画します。状態は変えません。 |
| Individual | `request-review` | プルリクエストを draft から外し、担当者にレビューを依頼します。 |
| Individual | `update-status` | Issue Field を指定の状態に設定します。 |

## 開発

```sh
npm ci
make all
```

`make all` はコミット前に必ず通してください。`dist/index.js` を再生成します。これは Actions の実行時バンドル
なのでコミットされています。

このリポジトリを変更するための取り決めは [`AGENTS.md`](AGENTS.md) にあります（構成、プラットフォームの
不変条件、コードスタイル、レビューチェックリスト）。なぜこの形なのかは [`docs/design.md`](docs/design.md)、
用語の定義は [`docs/glossary.md`](docs/glossary.md)、未着手の作業は [`TODO.md`](TODO.md) にあります。

## ライセンス

[MIT](LICENSE)
