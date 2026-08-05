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
task_skill: swift-concurrency       # task エージェントが使う任意のスキル
validation_skill: ios-ui-validation # 検証を省略しない場合は必須
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

`epic-validation-prompt` と `validation-prompt` は任意です。空のままにしておくと、issue ごとに
必要なときだけ追加できます。`validation_skill` は `skip_validation` が `true` でない限り必須です。
検証を省略する場合は空でも構いません。

## エージェントのワークフローを設定する

`.github/octestra/actions/task-agent/action.yml` は実装エージェントを、`.github/octestra/actions/validation-agent/action.yml` は検証エージェントを実行します。各ファイルのプレースホルダーを、利用するエージェントの設定と実行ステップに置き換えてください。

Octestra は各 agent action を初回だけインストールし、以後の更新ではファイル全体を保持します。workflow は全体が置き換えられます。agent action では lifecycle context に `inputs.*`、エージェント用 GitHub token に `env.OCTESTRA_AGENT_GITHUB_TOKEN` を使用してください。

## 実装エージェント

`lifecycle/prepare-task` は実装エージェントの前に実行され、その出力は input として `task-agent/action.yml` に渡されます。

| 名前                                 | 値                                                     |
|--------------------------------------|--------------------------------------------------------|
| `inputs.issue_number`                 | task issue の番号                        |
| `inputs.prompt`                       | 描画済みの実装プロンプト                 |
| `inputs.branch_name`                  | エージェントが push する正確な branch 名 |
| `inputs.draft_flag`                   | `--draft`、または空                      |
| `inputs.skip_validation`              | 検証を省略するかどうか                   |
| `inputs.task_owner`                   | タスクを担当する人                       |
| `inputs.epic_id`                      | EPIC の識別子                            |
| `inputs.parent_number`                | EPIC の issue 番号                       |
| `inputs.task_skill_name`              | EPIC で指定された任意の task スキル       |
| `inputs.target`                       | ファイル、クラス、機能などの任意のタスク対象 |
| `env.OCTESTRA_AGENT_GITHUB_TOKEN`     | エージェント用の GitHub token            |

ワークフローは composite action の呼び出し前に `task_ready` を確認します。action 内の各ステップで同じ条件を繰り返す必要はなく、`lifecycle/prepare-task` と同じ job、runner、workspace で実行されます。

Claude Code Action の設定例です。

```yaml
- uses: anthropics/claude-code-action@v1
  with:
    github_token: ${{ env.OCTESTRA_AGENT_GITHUB_TOKEN }}
    branch_prefix: ${{ inputs.branch_name }}
    branch_name_template: "{{prefix}}"
    prompt: ${{ inputs.prompt }}
```

エージェントは `branch_name` と完全に同じ名前の branch を push し、その branch から pull request を開く必要があります。できなかった場合、Octestra は task issue を `Blocked` に移動します。

## 検証エージェント

`lifecycle/prepare-validation` は pull request の branch を解決します。ワークフローはその branch を checkout し、準備処理の出力を input として `validation-agent/action.yml` に渡します。

| 名前 | 値 |
|---|---|
| `inputs.issue_number` | task issue の番号 |
| `inputs.prompt` | 描画済みの検証プロンプト |
| `inputs.pull_number` | 検証対象の pull request |
| `inputs.result_path` | 検証結果の JSON を書き込むパス |
| `inputs.artifact_path` | スクリーンショット、ログ、その他の証跡を保存するディレクトリ |
| `inputs.branch_name` | checkout 済みの task branch |
| `inputs.parent_number` | EPIC の issue 番号 |
| `inputs.validation_skill_name` | EPIC で指定された検証スキル |
| `inputs.target` | ファイル、クラス、機能などの任意のタスク対象 |
| `env.OCTESTRA_AGENT_GITHUB_TOKEN` | エージェント用の GitHub token |

action は `lifecycle/prepare-validation` と同じ job、runner、checkout 済み workspace で実行されます。
検証エージェントは、インストール済みの `octestra-validation-proof` skill を使って
`inputs.result_path` に JSON を書き込み、その形式を検査します。

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

- `epicTaskPrompt`: EPIC の実装指示
- `taskPrompt`: task issue の実装指示
- `epicValidationPrompt`: EPIC の検証指示
- `validationPrompt`: task issue の検証指示
- `taskSkillName`: EPIC で設定した task スキル名
- `validationSkillName`: EPIC で設定した検証スキル名
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
