# Octestra 実装ガイド

📖 [English](integration.md)

このガイドでは、インストールした Octestra に実装エージェントと検証エージェントを接続し、task issue を定義する方法を説明します。インストール、更新、運用は [README](../README.ja.md) を参照してください。

## タスクのライフサイクル

Octestra は organization に `AI Task Status` Issue Field を作成します。task issue でこの field の status option を変更すると、ワークフローが実行されます。

```text
Todo ──▶ Ready ──▶ In Progress ──▶ Validation ──▶ Human Review ──▶ Done
             ▲            │                              ▲
             │            └──────────────────────────────┘  skip_validation が true の場合
             └──────────── Blocked ◀──── 上記いずれかが失敗
```

| ステータス     | 動作                                                                    |
|----------------|-------------------------------------------------------------------------|
| `Todo`         | タスクは作成済み                                                        |
| `Ready`        | GitHub ワークフローを開始できる状態                                     |
| `In Progress`  | `octestra-lifecycle-in-progress.yml` が実装エージェントを実行中         |
| `Validation`   | `octestra-lifecycle-validation.yml` が検証エージェントを実行中          |
| `Human Review` | task owner にプルリクエストのレビューを依頼                             |
| `Blocked`      | 失敗内容と Actions 実行へのリンクをコメント。`Ready` に戻すと再試行可能 |
| `Done`         | タスクは完了                                                            |

関連する task issue は EPIC issue の下にまとめます。EPIC issue は、本文の `epic-config` block で配下の task issue に共通の設定を与える親 issue です。task issue はエージェントが処理する一つの作業単位で、EPIC の sub-issue として作成します。

## EPIC と task issue を定義する

issue body contract は、EPIC または task issue の fenced block を定義する Markdown template です。EPIC は `.github/octestra/issue-templates/epic.md.hbs`、task issue は `.github/octestra/issue-templates/task.md.hbs` を使って作成してください。これらと異なる issue 本文形式は使用できません。

EPIC issue には、すべての task issue で共有する設定と指示を記述します。

````markdown
```epic-config
id: ios-swift6            # task branch の名前に使う小文字の識別子
skill: swift-concurrency  # 実装エージェントが使う任意のスキル
draft_pr: false           # 各 task pull request を draft で開くか
skip_validation: false    # true の場合は直接 Human Review へ進める
```

```epic-task-prompt
この EPIC のすべてのタスクで共有する指示。
```

```epic-validation-prompt
この EPIC の task で共有する検証エージェントへの任意の指示。
```
````

task issue には、変更対象、タスク固有の実装指示、必要に応じて検証指示を記述します。

````markdown
```task-config
target: Sources/Feature.swift # 任意の変更対象ファイルまたはコンポーネント
```

```task-prompt
このタスクを実装してください。
```

```validation-prompt
画面に期待する内容が表示され、ユーザー操作に正しく応答することを確認してください。
```
````

`epic-validation-prompt` と `validation-prompt` は任意です。空のままにしておくと、issue ごとに必要なときだけ追加できます。

## エージェントのワークフローを設定する

`octestra-lifecycle-in-progress.yml` は実装エージェントを、`octestra-lifecycle-validation.yml` は検証エージェントを実行します。各ファイルのプレースホルダーを、利用するエージェントの設定と実行ステップに置き換えてください。

インストールされるワークフローには、**custom region** があります。custom region は、対応する `# octestra:custom:begin <name>` と `# octestra:custom:end <name>` のマーカーに挟まれた行です。更新時には custom region の内容だけが新しいワークフローに引き継がれ、外側の内容は置き換えられます。

| custom region         | 記述する内容                                                     |
|-----------------------|------------------------------------------------------------------|
| `agent-steps`         | 環境設定、依存関係、エージェントの実行、任意の成果物アップロード |
| `agent-credentials`   | 各ステップに必要な Actions secret の名前と説明                   |
| `in-progress-secrets` | メインワークフローから実装ワークフローへ渡す secret              |
| `validation-secrets`  | メインワークフローから検証ワークフローへ渡す secret              |

`agent-credentials` で宣言した secret は、対応する `in-progress-secrets` または `validation-secrets` から明示的に渡します。`secrets: inherit` は使用しないでください。実行エージェントに organization のすべての secret が渡されてしまいます。

custom region の中では、次だけを参照してください。

- `steps.epic.outputs.*`
- `env.OCTESTRA_AGENT_GITHUB_TOKEN`
- 同じワークフローファイルで宣言された `secrets`、`vars`、`inputs`

custom region の外にあるワークフローステップを ID で参照してはいけません。更新でそのステップが削除または移動すると、GitHub は参照を空文字列として扱い、エージェントは不完全な設定で実行されます。

## 実装エージェント

`lifecycle/prepare-task` は実装エージェントの前に実行され、次の値を公開します。

| 名前                                 | 値                                                     |
|--------------------------------------|--------------------------------------------------------|
| `steps.epic.outputs.prompt`          | 描画済みの実装プロンプト                               |
| `steps.epic.outputs.branch_name`     | エージェントが push する正確な branch 名               |
| `steps.epic.outputs.task_ready`      | 既存の作業により新しい実行を開始できない場合は `false` |
| `steps.epic.outputs.draft_flag`      | `--draft`、または空                                    |
| `steps.epic.outputs.skip_validation` | 検証を省略するかどうか                                 |
| `steps.epic.outputs.task_owner`      | タスクを担当する人                                     |
| `steps.epic.outputs.epic_id`         | EPIC の識別子                                          |
| `steps.epic.outputs.parent_number`   | EPIC の issue 番号                                     |
| `steps.epic.outputs.skill_name`      | EPIC で指定された任意のスキル                          |
| `steps.epic.outputs.target_file`     | 任意のタスク対象                                       |
| `env.OCTESTRA_AGENT_GITHUB_TOKEN`    | エージェント用の GitHub token                          |

Claude Code Action の設定例です。

```yaml
- uses: anthropics/claude-code-action@v1
  if: steps.epic.outputs.task_ready == 'true'
  with:
    github_token: ${{ env.OCTESTRA_AGENT_GITHUB_TOKEN }}
    branch_prefix: ${{ steps.epic.outputs.branch_name }}
    branch_name_template: "{{prefix}}"
    prompt: ${{ steps.epic.outputs.prompt }}
```

エージェントは `branch_name` と完全に同じ名前の branch を push し、その branch から pull request を開く必要があります。できなかった場合、Octestra は task issue を `Blocked` に移動します。

## 検証エージェント

`lifecycle/prepare-validation` は pull request の branch を checkout してから、検証エージェントに次の値を公開します。

| 名前 | 値 |
|---|---|
| `steps.epic.outputs.prompt` | 描画済みの検証プロンプト |
| `steps.epic.outputs.pull_number` | 検証対象の pull request |
| `steps.epic.outputs.result_path` | 検証結果の JSON を書き込むパス |
| `steps.epic.outputs.artifact_path` | スクリーンショット、ログ、その他の証跡を保存するディレクトリ |
| `steps.epic.outputs.branch_name` | checkout 済みの task branch |
| `steps.epic.outputs.parent_number` | EPIC の issue 番号 |
| `steps.epic.outputs.target_file` | 任意のタスク対象 |
| `env.OCTESTRA_AGENT_GITHUB_TOKEN` | エージェント用の GitHub token |

検証エージェントは `result_path` に JSON を書き込みます。

```json
{
  "outcome": "passed",
  "summary": "すべてのチェックが通りました。",
  "checks": [
    {
      "name": "unit tests",
      "result": "passed"
    }
  ],
  "details": "実行したコマンドと、レビュアーが知っておくべき内容。"
}
```

必須なのは `outcome` と `summary` だけです。`Human Review` に進むには、`outcome` が正確に `passed` である必要があります。その他の値では task issue が `Blocked` に移動します。

### 個別のチェックを記述する

`checks` は任意です。指定する場合は JSON object の配列にします。各 object には空でない文字列の `name` と `result` が必須です。必要に応じて、その他の custom field を追加できます。

Octestra は task issue の検証結果コメントに、check ごとに 1 行を表示します。`checks` を使うとコメントを確認しやすくなりますが、ライフサイクルを個別に制御するものではありません。Octestra が task issue を進めるか Blocked にするかは、最上位の `outcome` だけで決まります。

## プロンプトテンプレート

Octestra はエージェントに渡すプロンプトを Handlebars template として管理します。実装用は `.github/octestra/prompts/lifecycle-in-progress.md.hbs`、検証用は `.github/octestra/prompts/lifecycle-validation.md.hbs` です。`Prepare task lifecycle` または `Prepare validation lifecycle` が template を描画し、結果を `steps.epic.outputs.prompt` としてエージェントの実行ステップへ渡します。

template では EPIC と task issue の設定・prompt を利用できます。主な変数は次のとおりです。

- `epicTaskPrompt`: EPIC と task issue の実装指示を結合したもの
- `skillName`: EPIC で設定したスキル名
- `target`: 設定されている場合のタスク対象
- `issueNumber`: task issue 番号
- `pullNumber`: 存在する場合の関連 pull request 番号
- `draftFlag`: draft pull request を設定した場合の `--draft`
- `resultPath`: 検証時の result path。検証用 workflow でのみ利用可能
- `artifactPath`: 検証時の artifact directory。検証用 workflow でのみ利用可能

## 設定を変更する

`.github/octestra/config.yml` では、GitHub Actions runner、Octestra が使う GitHub App、task branch の命名規則、prompt template の場所を設定します。`github_app.private_key_secret_key_name` には、GitHub App の private key を保存する Actions secret の名前を設定します。secret の値を `config.yml` に書き込むことはありません。

`github_app.client_id`、`github_app.private_key_secret_key_name`、`runners` 配下の値、または `status.field_id` を変更したあとは、新しい値をリポジトリの Actions 変数へコピーしてください。

```sh
.github/octestra/octestra.sh vars sync
```
