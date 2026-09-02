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

Blocked ──────────▶ Validation   タスクのプルリクエストが open のまま
Human Review ─────▶ Validation   なら検証を再実行できる
```

| ステータス     | 動作                                                                    |
|----------------|-------------------------------------------------------------------------|
| `Todo`         | タスクは作成済み                                                        |
| `Ready`        | GitHub ワークフローを開始できる状態                                     |
| `In Progress`  | `octestra-lifecycle.yml` の `in-progress` job が実装エージェントを実行 |
| `Validation`   | `octestra-lifecycle.yml` の `validation` job が検証エージェントを実行。`Blocked` または `Human Review` のタスクをここへ戻すと、open のプルリクエストに対して検証を再実行する |
| `Human Review` | task owner にプルリクエストのレビューを依頼                             |
| `Blocked`      | 失敗内容と Actions 実行へのリンクをコメント。プルリクエストが open のままなら `Validation` に移すと検証を再実行、`Ready` に戻すとやり直し |
| `Done`         | タスクは完了                                                            |

関連する task issue は EPIC issue の下にまとめます。EPIC issue は、本文の `epic-config` block で配下の task issue に共通の設定を与える親 issue です。task issue はエージェントが処理する一つの作業単位で、EPIC の sub-issue として作成します。

## EPIC と task issue を定義する

issue body contract は、EPIC または task issue の fenced block を定義する Markdown template です。EPIC は `.github/octestra/issue-templates/epic.md.hbs`、task issue は `.github/octestra/issue-templates/task.md.hbs` を使って作成してください。これらと異なる issue 本文形式は使用できません。

EPIC issue には、すべての task issue で共有する設定と指示を記述します。

````markdown
```epic-config
id: ios-swift6            # task branch の名前に使う小文字の識別子
task_skill: swift-concurrency       # task エージェントが使う任意のスキル
triage_skill: migration-triage      # Todo triage loop を使う場合は必須
validation_skill: ios-ui-validation # 検証を省略しない場合は必須
draft_pr: false           # 各 task pull request を draft で開くか
skip_triage: false        # true の場合はこの EPIC を triage から除外
skip_validation: false    # true の場合は直接 Human Review へ進める
```

```epic-task-prompt
この EPIC のすべてのタスクで共有する指示。
```

```epic-triage-prompt
この EPIC の Todo triage で使う任意の指示。
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

`epic-triage-prompt`、`epic-validation-prompt`、`validation-prompt` は任意です。空のままに
しておくと、必要なときだけ追加できます。`skip_triage` のデフォルトは `false` で、
`false` の場合は `triage_skill` が必須です。`validation_skill` は `skip_validation` が `true`
でない限り必須で、検証を省略する場合は空でも構いません。

## エージェントのワークフローを設定する

`.github/octestra/actions/task-agent/action.yml` は実装エージェントを、`.github/octestra/actions/validation-agent/action.yml` は検証エージェントを実行します。各ファイルのプレースホルダーを、利用するエージェントの設定と実行ステップに置き換えてください。

Octestra は各 agent action を初回だけインストールし、以後の更新ではファイル全体を保持します。
lifecycle workflow は全体が置き換えられますが、loop workflow とその prompt は consumer-owned
file として保持されます。agent action では context に `inputs.*`、エージェント用 GitHub token
に `env.OCTESTRA_AGENT_GITHUB_TOKEN` を使用してください。出荷時の workflow に含まれるすべての
local agent action には、同名の任意の repository variable から正規化した
`env.OCTESTRA_AGENT_DEBUG` も渡されます。正規化は準備時に行います。既存の consumer-owned loop
workflow には、下記の 1 回の変更が必要です。その値で何をするかは
Octestra ではなく repository-owned action が決めます。

描画されるすべての agent prompt は、インストール済みの `/octestra-contracts`
workflow-contract skill を最初に読み込み、`task`、`triage`、`validation` のいずれかの phase を
指定します。repository skill は domain policy を所有し、`/octestra-contracts` は branch、
pull request、mutation、result file の要件を所有します。

composite action は GitHub Actions の `secrets` context を直接参照できません。cloud credential
には OIDC を使うか、選択した runner の環境から credential を渡してください。OIDC が必要な
場合は installer に `--enable-oidc` を指定します。

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
| `inputs.task_skill`                   | EPIC で指定された任意の task スキル       |
| `inputs.target`                       | ファイル、クラス、機能などの任意のタスク対象 |
| `env.OCTESTRA_AGENT_GITHUB_TOKEN`     | エージェント用の GitHub token            |
| `env.OCTESTRA_AGENT_DEBUG`     | repository variable が文字列 `true` の場合だけ `true`。それ以外は `false` |

ワークフローは composite action の呼び出し前に `task_ready` を確認します。action 内の各ステップで同じ条件を繰り返す必要はなく、`lifecycle/prepare-task` と同じ job、runner、workspace で実行されます。

Claude Code Action の設定例です。

```yaml
- uses: anthropics/claude-code-action@v1
  with:
    github_token: ${{ env.OCTESTRA_AGENT_GITHUB_TOKEN }}
    branch_prefix: ${{ inputs.branch_name }}
    branch_name_template: "{{prefix}}"
    show_full_output: ${{ env.OCTESTRA_AGENT_DEBUG }}
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
| `inputs.validation_skill` | EPIC で指定された検証スキル |
| `inputs.target` | ファイル、クラス、機能などの任意のタスク対象 |
| `env.OCTESTRA_AGENT_GITHUB_TOKEN` | エージェント用の GitHub token |
| `env.OCTESTRA_AGENT_DEBUG` | repository variable が文字列 `true` の場合だけ `true`。それ以外は `false` |

action は `lifecycle/prepare-validation` と同じ job、runner、checkout 済み workspace で実行されます。
検証エージェントは、インストール済みの `/octestra-contracts` skill を使って
`inputs.result_path` に JSON を書き込み、その形式を検査します。

### agent の debug flag を使う

task、validation、triage の rerun で repository 独自の debug 動作が必要な場合は、repository
Actions variable `OCTESTRA_AGENT_DEBUG` を `true` に設定します。variable が未設定の場合、または
小文字の文字列 `true` 以外の場合は、すべての local agent action には `false` が渡されます。
Octestra が注入するのはこの正規化した boolean だけです。consumer action は追加の log、tool の設定、
その他の repository-owned の動作に自由に利用できます。

新規インストールでは、3 つすべての action workflow が flag を渡します。既存インストールの update
では lifecycle workflow が置き換わるため task と validation action は受け取ります。一方 Todo loop
workflow は consumer-owned として全体が保持されるため、既存の `Prepare loop prompt` step に次の
environment value を 1 回追加してください。

```yaml
- name: Prepare loop prompt
  id: loop
  uses: ainame/octestra@main
  env:
    OCTESTRA_AGENT_DEBUG_VALUE: ${{ vars.OCTESTRA_AGENT_DEBUG }}
  with:
    operation: loop/prepare-triage
    github_token: ${{ steps.app-token.outputs.token }}
    issue_number: ${{ matrix.epic.number }}
```

インストール時の Claude の設定例では、次のように値を渡します。

```yaml
show_full_output: ${{ env.OCTESTRA_AGENT_DEBUG }}
```

これは generic flag の用途の一例です。既存の consumer-owned agent action には、この行または
`env.OCTESTRA_AGENT_DEBUG` の repository 独自の利用をそれぞれ 1 回追加してください。Octestra の
update はそれらのファイルを保持するため自動では変更しませんが、更新済み lifecycle と loop の
workflow は environment variable をすでに渡しているので、以後の rerun は repository variable を
変更するだけで実行できます。

full output では Claude の tool input と result（prompt、ファイル内容、command output を含む）が
GitHub Actions log に出力される可能性があります。必要な期間だけ有効にし、log を閲覧できる人を
信頼できる範囲に限定してください。GitHub の secret masking が、これらの診断記録を安全に公開
できるようにするものではありません。

```json
{
  "kind": "validation-result",
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

`kind`、`outcome`、`summary` が必須です。`kind` は常に `validation-result`、`outcome` は
`passed` または `failed` です。`passed` は task を `Human Review` に進め、`failed` は
`Blocked` に移動します。

### 個別のチェックを記述する

`checks` は任意です。指定する場合は JSON object の配列にします。各 object には空でない文字列の `name` と `result` が必須です。必要に応じて、その他の custom field を追加できます。

Octestra は task issue の検証結果コメントに、check ごとに 1 行を表示します。`checks` を使うとコメントを確認しやすくなりますが、ライフサイクルを個別に制御するものではありません。Octestra が task issue を進めるか Blocked にするかは、最上位の `outcome` だけで決まります。

## Scheduled Agent Loop

`.github/workflows/octestra-loop-todo.yml` は consumer-owned の Todo triage 例です。手動では
すぐ実行できます。定期実行する場合は実行間隔を設定して `schedule` block を uncomment し、
`.github/octestra/actions/triage-agent/action.yml` の placeholder を置き換えてください。

triage action には、lifecycle の agent action と同じように、正規化された
`env.OCTESTRA_AGENT_DEBUG` が渡されます。既存の loop workflow では Octestra の update がその
workflow を保持するため、上記の正規化 step を追加してください。

`loop/list-epics` は `octestra-epic` label を持つ open issue を探し、`epic-config` に
`skip_triage: true` を設定した EPIC を除外します。workflow は残った EPIC ごとに matrix
job を起動し、同時に実行する agent job は最大3つです。`loop/prepare-triage` はその EPIC から
`triage_skill` と任意の `epic-triage-prompt` block を読み、`triageSkill`、
`epicTriagePrompt`、`resultPath` を使って
`.github/octestra/prompts/loop-todo.md.hbs` を描画します。
lifecycle の task と validation の prepare operation と同様に、skill も独立した output として
公開します。workflow は local triage action に `epic_number`、`triage_skill`、`prompt`、
`result_path` を渡します。

task の探索、選択、件数制限、readiness policy、issue preparation、domain knowledge は workflow
や prompt ではなく、triage skill に置いてください。agent は repository policy に必要な issue
body やその他の issue data を変更できますが、`AI Task Status` Issue Field を直接変更してはいけません。
必要な preparation がすべて成功したあと、次の JSON を書き込みます。

```json
{
  "kind": "triage-result",
  "readyIssues": [12, 34],
  "summary": "任意の概要"
}
```

`readyIssues` は完全に処理され、ready と判断した task の一意な正の repository issue 番号です。
空配列も有効です。
`loop/finalize-triage` は result がない場合や不正な場合に fail closed します。status を更新する
前に、報告されたすべての issue が open で、対象 EPIC の direct sub-issue であり、有効な task
body を持ち、現在 `Todo` または `Ready` であることを確認します。`Ready` は no-op です。
`Todo` から `Ready` へ変更する直前にも status を再確認し、ほかの status を上書きしません。
実際に `Todo` から `Ready` へ変更する各 task には、変更直前に source EPIC と workflow run の
metadata を含む Octestra activity comment を投稿します。comment の投稿は lifecycle の成功系と
同じく best-effort です。失敗時は workflow warning を出しますが、status 更新は続行します。
すでに `Ready` の task には status 更新も重複する activity comment も行いません。
open かつ opt-out していない EPIC に `triage_skill` がない場合、または `epic-config` が不正な
場合、discovery はその EPIC を示して run を失敗させ、黙って除外しません。

workflow は描画した `prompt` を local triage action に渡します。finalization はその action が
成功した場合だけ実行されます。

loop workflow、prompt、local action は update で保持されます。`loop/finalize-triage` より前に
インストールした場合は、現行 template から workflow と prompt を手動で移行してください。
installer はこの状態を報告しますが、repository policy を上書きしません。

## プロンプトテンプレート

Octestra は agent に渡す prompt を Handlebars template として管理します。実装用は
`.github/octestra/prompts/lifecycle-in-progress.md.hbs`、検証用は
`.github/octestra/prompts/lifecycle-validation.md.hbs`、Todo triage 用は
`.github/octestra/prompts/loop-todo.md.hbs` です。対応する準備 step が template を描画し、
local agent action へ渡します。

template では EPIC と task issue の設定・prompt を利用できます。主な変数は次のとおりです。

- `epicTaskPrompt`: EPIC の実装指示
- `epicTriagePrompt`: EPIC の Todo triage 指示
- `taskPrompt`: task issue の実装指示
- `epicValidationPrompt`: EPIC の検証指示
- `validationPrompt`: task issue の検証指示
- `taskSkill`: EPIC で設定した task スキル
- `triageSkill`: EPIC で設定した Todo triage スキル
- `validationSkill`: EPIC で設定した検証スキル
- `target`: 設定されている場合のタスク対象
- `issueNumber`: task issue 番号
- `branchName`: 実装時の正確な task branch
- `pullNumber`: 存在する場合の関連 pull request 番号
- `draftFlag`: draft pull request を設定した場合の `--draft`
- `resultPath`: 検証または triage 時の result path
- `artifactPath`: 検証時の artifact directory。検証用 workflow でのみ利用可能

## 設定を変更する

`.github/octestra/config.yml` では、GitHub Actions runner、Octestra が使う GitHub App、task branch の命名規則、prompt template の場所を設定します。Todo triage prompt を既定の `.github/octestra/prompts/loop-todo.md.hbs` から移動する場合は `prompts.loop_todo` を設定します。このキーがない既存のインストールでは、引き続き既定のパスを使用します。`github_app.private_key_secret_key_name` には、GitHub App の private key を保存する Actions secret の名前を設定します。secret の値を `config.yml` に書き込むことはありません。

`github_app.client_id`、`github_app.private_key_secret_key_name`、`runners` 配下の値、または `status.field_id` を変更したあとは、新しい値をリポジトリの Actions 変数へコピーしてください。

```sh
.github/octestra/octestra.sh vars sync
```
