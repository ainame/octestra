# Octestra

**GitHub Actions と Projects のための serverless AI agent orchestration framework。**

<p align="center">
<img src="docs/assets/octestra-logo.png" alt="Octestra" width="200">
</p>

issue を `In Progress` に移すだけ。その先は Octestra が引き継ぎます。コーディングエージェントがタスクを実装し、
プルリクエストを開き、変更を検証したあと、人間にレビューを依頼します。

ワークフローはすべて GitHub 上で動きます。オーケストレーション用のサーバー、キュー、データベースは不要です。

📖 [English](README.md) · [設計メモ](docs/design.md) · [用語集](docs/glossary.md)

```text
GitHub issue
    │
    ▼
In Progress ──▶ エージェント ──▶ プルリクエスト ──▶ 検証 ──▶ 人間によるレビュー ──▶ Done
```

## 概要

Octestra は GitHub Issues、GitHub Actions、そして任意のコーディングエージェントを連携させます。各 issue の
カスタムフィールドにタスクの進行状況を記録し、その値が変わると次の処理を開始します。結果は issue、
プルリクエスト、Actions の実行履歴のいずれかに残ります。

Octestra 自身はバックログからタスクを選びません。人または別の自動化が `AI Task Status` フィールドを
`In Progress` に変更すると、タスクが始まります。

## 特徴

- **GitHub 上で完結。** issue のカスタムフィールドが進行状況を保持し、GitHub Actions が処理を実行します。
- **エージェントを自由に選択。** タスクを実装してプルリクエストを開ける Action やコマンドなら利用できます。
- **受け渡しまで自動化。** ブランチとプルリクエストの特定、検証、レビュー依頼、issue の更新、失敗の報告を
  Octestra が行います。
- **指示をリポジトリで管理。** プロンプトと設定をコードと一緒にバージョン管理できます。
- **設定を保ったまま更新。** Octestra を更新しても、エージェントと認証情報を設定したワークフロー部分は
  保持されます。

## Octestra を選ぶ理由

### エージェントの実行だけでなく、デリバリーまでオーケストレーション

コーディングエージェントの実行は工程のひとつにすぎません。成果を届けるには、ブランチとプルリクエストを特定し、
変更を検証し、レビュアーに引き渡し、失敗から復旧する必要があります。Octestra はこれらの受け渡しを、ひとつの
見えるワークフローにつなぎます。

各処理は、開始前に issue の現在のステータスを確認します。失敗したタスクはログの中で止まるのではなく、
`Blocked` に移動し、失敗した Actions 実行へのリンクが追加されます。

### serverless のまま使える

タスクのステータスは issue が保持し、GitHub のイベントが処理を開始し、GitHub Actions が実行環境を提供します。
Octestra のために新たなサービスをデプロイ、監視、保護、バックアップする必要はありません。

### 使いたいエージェントを持ち込める

Octestra はモデルを直接呼び出さず、特定のエージェントベンダーも要求しません。タスクを実装してプルリクエストを
開く GitHub Action やコマンドを、ワークフローから自由に実行できます。プロンプト、runner、エージェントの
認証情報はリポジトリに置かれ、通常のコードレビューを通せます。

## はじめに

### 必要要件

- GitHub organization に属するリポジトリ
- 対象リポジトリに対して認証済みの [GitHub CLI](https://cli.github.com/)
- インストール時にカスタム issue フィールドを作成できる organization 管理者権限
- 対象リポジトリにインストールされた、**Contents**、**Issues**、**Pull requests** への書き込み権限を持つ
  GitHub App
- GitHub Actions 上で実行できるコーディングエージェント

Octestra を利用するリポジトリで、次のインストーラを実行します。

```sh
curl -fsSL https://raw.githubusercontent.com/ainame/octestra/refs/heads/main/install.sh | bash
```

続いて、次の設定を行います。

1. GitHub App の秘密鍵を、`OCTESTRA_GITHUB_APP_PRIVATE_KEY` という名前の Actions secret に保存します。
2. `.github/workflows/octestra-lifecycle-in-progress.yml` にあるプレースホルダーを、実際のエージェントを
   実行するステップに置き換えます。
3. `.github/workflows/octestra-lifecycle-validation.yml` を設定します。最初のタスクを準備している間は、
   検証を無効にしても構いません。
4. コーディングエージェントに、インストールされた `setup-migration-epic` スキルを使うよう依頼します。
   このスキルは計画から親 issue をひとつ作り、タスクごとの sub-issue を作成します。
5. task issue の `AI Task Status` フィールドを `In Progress` に変更します。

インストーラは GitHub Actions ワークフロー、プロンプトテンプレート、設定ファイル、メンテナンススクリプト、
`setup-migration-epic` エージェントスキル、ステータスフィールドで使う7つの選択肢を追加します。

> [!WARNING]
> 現在の Octestra は、メンバーを信頼できるプライベートリポジトリを対象としています。使用前に
> [セキュリティ](#セキュリティ)を確認してください。

## 仕組み

Octestra は organization に `AI Task Status` という GitHub Issue Field を作成します。Issue Field とは、
issue に直接追加するカスタムフィールドです。この値を変更すると、タスクが次の流れで進みます。

```text
Todo ──▶ Ready ──▶ In Progress ──▶ Validation ──▶ Human Review ──▶ Done
             ▲            │              │                ▲
             │            └──────────────┴────────────────┘  検証を無効にした場合
             └──────────── Blocked ◀──── 上記いずれかが失敗
```

| ステータス | 動作 |
|---|---|
| `Todo` | タスクは作成済みですが、まだ実行できません。 |
| `Ready` | 人または別の GitHub ワークフローが開始できる状態です。 |
| `In Progress` | 実装エージェントが動き、プルリクエストを開きます。 |
| `Validation` | 検証エージェントがプルリクエストを評価し、結果を投稿します。 |
| `Human Review` | task issue の担当者にレビューを依頼します。 |
| `Blocked` | 失敗内容と Actions 実行へのリンクをコメントします。`Ready` に戻すと再試行できます。 |
| `Done` | タスクは完了です。 |

関連するタスクは **EPIC issue** の下にまとめます。EPIC issue とは、本文の `epic-config` ブロックで配下の
task issue をまとめて設定する親 issue です。各 **task issue** はエージェントが処理するひとつの作業単位で、
EPIC の sub-issue として作成します。

## OpenAI Symphony との比較

[OpenAI Symphony](https://github.com/openai/symphony) は、仕様と experimental reference implementation を
提供しています。
サービスがプロジェクト管理ツールを繰り返し確認し、対象となる issue ごとに再利用可能な作業ディレクトリを用意して、
作業が不要になるまで Codex を実行します。

Octestra が重視するのは、GitHub 内での明示的な受け渡しです。フィールドの変更が GitHub Actions ワークフローを
開始し、そのワークフローが設定済みの実装エージェントまたは検証エージェントを呼び出します。

| | Octestra | Symphony |
|---|---|---|
| 主な役割 | ひとつのタスクを実装、検証、レビューへ進める | 対象タスクを選び、エージェントに継続して処理させる |
| 実行形態 | GitHub Actions ワークフロー | 常駐サービスまたは実行ファイル |
| 開始条件 | task issue の `AI Task Status` フィールドの変更 | サービスがトラッカーを繰り返し確認 |
| 対応トラッカー | GitHub Issues | reference implementation では Linear、GitHub Issues、Jira Cloud、Asana、GitLab |
| エージェント | 設定した任意の Action またはコマンド | app-server インターフェース経由の Codex |
| 作業ディレクトリ | ワークフロー実行ごとに新しい GitHub Actions ジョブ | issue ごとのディレクトリを実行間で再利用 |
| エージェントセッション | 実装と検証でエージェントを1回ずつ実行 | サービスが issue を処理している間に複数の Codex ターンを実行 |
| 並列実行と再試行 | GitHub Actions が管理 | Symphony が管理 |
| 人間によるレビュー | 組み込みの `Human Review` ステップ | トラッカーのステータスと Symphony の `WORKFLOW.md` で定義 |
| インフラ | Octestra の常駐プロセスは不要 | 常駐プロセス、ローカルディスク、トラッカーの認証情報が必要 |

**Octestra が適しているのは**、GitHub 上でイベント駆動の受け渡しを行い、任意のエージェントを使いたい場合です。

**Symphony が適しているのは**、人がタスクを開始しなくてもエージェントに作業を選ばせたい場合、Codex の作業
ディレクトリを実行間で維持したい場合、または GitHub 以外のトラッカーを使う場合です。

このような受け渡しが不要で、エージェントを1回だけ実行したい場合は、そのエージェントの GitHub Action を直接
呼び出してください。

## エージェント連携

Octestra はエージェント実行の前後を処理します。エージェントを実行するコマンドは利用者が設定します。

インストールされるワークフローには **custom region** があります。これは
`# octestra:custom:begin <name>` と `# octestra:custom:end <name>` の対応するマーカーに挟まれた行です。
エージェントの設定はこの内側に記述してください。更新時には custom region の内容を新しいワークフローへ引き継ぎ、
その外側を置き換えます。

| custom region | 記述する内容 |
|---|---|
| `agent-steps` | 環境設定、依存関係、エージェントの実行、任意の成果物アップロード |
| `agent-credentials` | 各ステップに必要な secret の名前と説明 |
| `in-progress-secrets` | メインワークフローから実装ワークフローへ渡す値 |
| `validation-secrets` | メインワークフローから検証ワークフローへ渡す値 |

### 実装エージェントへの入力

実装エージェントを実行する前に、Octestra の `lifecycle/prepare-task` Action が次の値を用意します。

| 名前 | 値 |
|---|---|
| `steps.epic.outputs.prompt` | 描画済みの実装プロンプト |
| `steps.epic.outputs.branch_name` | エージェントが push する正確なブランチ名 |
| `steps.epic.outputs.task_ready` | 既存の作業によって新しい実行を開始できない場合は `false` |
| `steps.epic.outputs.draft_flag` | `--draft`、または空 |
| `steps.epic.outputs.skip_validation` | 検証を省略するかどうか |
| `steps.epic.outputs.task_owner` | タスクを担当する人 |
| `steps.epic.outputs.epic_id` | EPIC の識別子 |
| `steps.epic.outputs.parent_number` | EPIC の issue 番号 |
| `steps.epic.outputs.skill_name` | EPIC で指定された任意のスキル |
| `steps.epic.outputs.target_file` | 任意のタスク対象 |
| `env.OCTESTRA_AGENT_GITHUB_TOKEN` | エージェント用の GitHub トークン |

Claude Code Action を使う例です。

```yaml
- uses: anthropics/claude-code-action@v1
  if: steps.epic.outputs.task_ready == 'true'
  with:
    github_token: ${{ env.OCTESTRA_AGENT_GITHUB_TOKEN }}
    branch_prefix: ${{ steps.epic.outputs.branch_name }}
    branch_name_template: "{{prefix}}"
    prompt: ${{ steps.epic.outputs.prompt }}
```

エージェントは `branch_name` と完全に同じ名前のブランチを push し、そのブランチからプルリクエストを開く必要が
あります。できなかった場合、Octestra はタスクを `Blocked` に移動します。

### 検証エージェントへの入力

検証エージェントを実行する前に、Octestra の `lifecycle/prepare-validation` Action がプルリクエストのブランチを
checkout し、次の値を用意します。

| 名前 | 値 |
|---|---|
| `steps.epic.outputs.prompt` | 描画済みの検証プロンプト |
| `steps.epic.outputs.pull_number` | 検証対象のプルリクエスト |
| `steps.epic.outputs.result_path` | 検証結果の JSON を書き込むパス |
| `steps.epic.outputs.artifact_path` | スクリーンショット、ログ、その他の証跡を保存するディレクトリ |
| `steps.epic.outputs.branch_name` | checkout 済みの task branch |
| `steps.epic.outputs.parent_number` | EPIC の issue 番号 |
| `steps.epic.outputs.target_file` | 任意のタスク対象 |
| `env.OCTESTRA_AGENT_GITHUB_TOKEN` | エージェント用の GitHub トークン |

検証エージェントは `result_path` に JSON を書き込みます。

```json
{
  "outcome": "passed",
  "summary": "すべてのチェックが通りました。",
  "checks": [
    {
      "name": "unit tests",
      "kind": "test",
      "result": "passed",
      "evidence": "3 packages"
    }
  ],
  "details": "実行したコマンドと、レビュアーが知っておくべき内容。"
}
```

必須なのは `outcome` と `summary` だけです。`Human Review` に進むには、`outcome` が正確に `passed` である
必要があります。それ以外の値ではタスクが `Blocked` に移動します。

custom region の中では、上記の Octestra の値と、同じワークフローファイルで宣言された `secrets`、リポジトリ
変数、ワークフロー入力だけを使ってください。他のワークフローステップから値を直接参照しないでください。
更新によってそのステップが置き換わると、エージェントに空の値が渡される可能性があります。

## タスク設定

EPIC issue は、関連するタスクをまとめる親 issue です。本文には次のブロックを記述します。

````markdown
```epic-config
id: ios-swift6            # task branch の名前に使う小文字の識別子
skill: swift-concurrency  # 実装エージェントが使う任意のスキル
draft_pr: false           # 各 task pull request を draft で開くか
skip_validation: false    # true の場合は直接 Human Review へ進める
```

```epic-prompt
この EPIC のすべてのタスクで共有する指示。
```

```validation-prompt
検証エージェントへの指示。
```
````

各 task sub-issue には、変更対象となる任意のファイルやコンポーネントと、そのタスク固有の指示を追加します。

````markdown
```task-config
target: Sources/Feature.swift # 任意の変更対象ファイルまたはコンポーネント
```

```task-prompt
このタスクを実装してください。
```
````

`.github/octestra/config.yml` では、ワークフローを実行する GitHub Actions runner、Octestra が使う GitHub App、
task branch の命名規則、プロンプトテンプレートの場所を設定します。

`github_app.client_id`、`runners` 配下の値、または `status.field_id` を変更したあとは、新しい値をリポジトリの
Actions 変数へコピーします。

```sh
.github/octestra/octestra.sh vars sync
```

## インストールオプション

| フラグ | 効果 |
|---|---|
| `--org NAME` | カスタム issue フィールドを所有する organization。既定では自動判定 |
| `--status-field NAME` | 使用または作成するカスタム issue フィールド。既定は `AI Task Status` |
| `--github-app-client-id ID` | GitHub App のクライアント ID |
| `--skill-target claude\|codex\|agents` | EPIC セットアップスキルを設置するディレクトリ |
| `--repository OWNER/REPO` | インストールされたワークフローが利用する Octestra リポジトリ |
| `--fork` | `--repository ORGANIZATION/octestra` の短縮形 |
| `--ref REF` | バージョンタグまたはブランチ。公式リポジトリでは既定で最新のバージョンタグ |
| `--enable-oidc` | GitHub OIDC を使ったクラウドプロバイダーへの認証をワークフローで許可 |
| `--yes` | 確認せずに既定値を使用 |

インストーラを再実行しても、`config.yml` と各 custom region の内容は保持されます。

## 更新とメンテナンス

```sh
.github/octestra/octestra.sh doctor
.github/octestra/octestra.sh vars check
.github/octestra/octestra.sh vars sync
.github/octestra/octestra.sh ref
.github/octestra/octestra.sh update --latest
```

| コマンド | 用途 |
|---|---|
| `doctor` | 設定、ステータスフィールド、プロンプト、ワークフローの問題を報告 |
| `vars check` | リポジトリの Actions 変数が `config.yml` と一致するか確認 |
| `vars sync` | `config.yml` の必要な値を Actions 変数へコピー |
| `ref` | インストール済みワークフローが使う Octestra のリポジトリと ref を表示 |
| `update --latest` | custom region を保ったまま最新リリースをインストール |

更新後は、コミットする前に `git diff` で変更内容を確認してください。

## セキュリティ

現在の Octestra は、**メンバーを信頼できるプライベートリポジトリ**を前提としています。

- `AI Task Status` フィールドを変更できる人は、誰でもエージェントを開始できます。
- issue の本文を編集できる人は、エージェントへの指示を変更できます。
- エージェントには、リポジトリへの書き込み権限を持つ GitHub App トークンが渡されます。
- エージェントと、リポジトリへの書き込み権限を持つワークフローステップは、まだ別々のジョブに分離されていません。
- 検証結果は検証エージェント自身の主張であり、Octestra が独立して確認するものではありません。

Octestra は各ワークフローで指定された secret だけを渡し、リポジトリや organization のすべての secret を
まとめて渡すことはありません。ただし、エージェントはリポジトリや issue を更新できるステップと同じジョブで
動きます。public リポジトリや、信頼できない issue 入力には使用しないでください。

## 高度な使い方

Octestra の各ステップは、[`action.yml`](action.yml) の `operation:` 入力でひとつの操作を選びます。
インストールされるワークフローは、実装と検証の受け渡しを一括で行う操作を使います。処理の順序を変えたい場合は、
より小さな操作を直接呼び出せます。

## 開発

```sh
npm ci
make all
```

`make all` は型チェックとテストを実行し、コミット対象の `dist/index.js` バンドルを再生成します。

Octestra を変更する前に [`AGENTS.md`](AGENTS.md) を読んでください。アーキテクチャ上の判断は
[`docs/design.md`](docs/design.md)、今後の作業は [`TODO.md`](TODO.md) に記録されています。

## ライセンス

[MIT](LICENSE)
