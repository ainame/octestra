# Octestra

**Serverless AI agent orchestration framework built on top of GitHub**

<p align="center">
<img src="docs/assets/octestra-logo.png" alt="Octestra" width="200">
</p>

Octestra は、GitHub Issue を起点に、AI エージェントによるタスクの実装、プルリクエスト作成、検証までを GitHub Actions 上で実行するフレームワークです。organization の Issue Field で task issue の進行を管理し、人間によるレビューとマージまでの流れを支援します。

📖 [English](README.md) · [実装ガイド](docs/integration.ja.md)

各ノードは task issue の `AI Task Status`、矢印は次の status へ進める操作を表します。

![Octestra のタスクライフサイクル](docs/assets/lifecycle.ja.svg)

## はじめに

### 必要なもの

- GitHub organization に属するリポジトリ
  - インストール時にカスタム Issue Field を作成できる organization 管理者権限
- 対象リポジトリに対して認証済みの [GitHub CLI](https://cli.github.com/)
- 対象リポジトリにインストールされた、**Contents**、**Issues**、**Pull requests** への書き込み権限を持つ GitHub App
- GitHub Actions 上で実行できるコーディングエージェント

### インストール

Octestra を利用するリポジトリのルートディレクトリでインストーラを実行します。

```sh
curl -fsSL https://raw.githubusercontent.com/ainame/octestra/refs/heads/main/install.sh | bash
```

インストーラは次のファイルを追加します。

- Octestra 専用のファイル
  - `.github/octestra/octestra.sh`
  - `.github/octestra/config.yml`
  - `.github/octestra/check-validation-result.sh`
  - `.github/octestra/issue-templates/epic.md.hbs`
  - `.github/octestra/issue-templates/task.md.hbs`
  - `.github/octestra/prompts/lifecycle-in-progress.md.hbs`
  - `.github/octestra/prompts/lifecycle-validation.md.hbs`
- workflow のテンプレート
  - `.github/workflows/octestra-lifecycle.yml`
  - `.github/workflows/octestra-lifecycle-in-progress.yml`
  - `.github/workflows/octestra-lifecycle-validation.yml`
- task セットアップ用のスキル
  - `.agents/skills/setup-migration-epic/SKILL.md`
  - `.agents/skills/setup-migration-epic/setup_epic.rb`

### エージェントを設定する

インストール直後のワークフローには、エージェントを実行するためのプレースホルダーがあります。まず [実装ガイド](docs/integration.ja.md) に従い、実装エージェントと検証エージェントを設定してください。

### 最初のタスクを実行する

1. EPIC issue とその sub-issue である task issue を、インストールされた issue-body contract から作成します。
2. task issue の `AI Task Status` を `Ready` に変更します。
3. 実装を開始するには `In Progress` に変更します。
4. Octestra がプルリクエストを作成し、検証後に `Human Review` へ進めます。

EPIC と task issue の書式、各 status option の意味、エージェントへの入力は [実装ガイド](docs/integration.ja.md) を参照してください。

## 更新とメンテナンス

```sh
.github/octestra/octestra.sh doctor
.github/octestra/octestra.sh vars check
.github/octestra/octestra.sh vars sync
.github/octestra/octestra.sh ref
.github/octestra/octestra.sh update --latest
```

| コマンド          | 用途                                                                  |
|-------------------|-----------------------------------------------------------------------|
| `doctor`          | 設定、status option、プロンプト、ワークフローの問題を報告             |
| `vars check`      | リポジトリの Actions 変数が `config.yml` と一致するか確認             |
| `vars sync`       | `config.yml` の必要な値を Actions 変数へコピー                        |
| `ref`             | インストール済みワークフローが使う Octestra のリポジトリと ref を表示 |
| `update --latest` | agent action と `config.yml` を保ったまま最新リリースをインストール |

インストーラを再実行すると workflow は置き換えられ、`config.yml` と両方の agent action は保持されます。更新後は、コミット前に `git diff` で変更内容を確認してください。

## セキュリティ

現在の Octestra は、**メンバーを信頼できるプライベートリポジトリ**を前提としています。

- `AI Task Status` Issue Field を変更できる人は、エージェントを開始できます。
- issue の本文を編集できる人は、エージェントへの指示を変更できます。
- エージェントには、リポジトリへの書き込み権限を持つ GitHub App トークンが渡されます。
- エージェントと、リポジトリへの書き込み権限を持つワークフローステップは、まだ別々のジョブに分離されていません。
- 検証結果は検証エージェント自身の主張であり、Octestra が独立して確認するものではありません。

Octestra は各ワークフローで指定された secret だけを渡し、リポジトリや organization のすべての secret をまとめて渡すことはありません。ただし、エージェントはリポジトリや issue を更新できるステップと同じジョブで動きます。public リポジトリや、信頼できない issue 入力には使用しないでください。

## 開発

```sh
npm ci
make all
```

`make all` は型チェックとテストを実行し、コミット対象の `dist/index.js` バンドルを再生成します。

Octestra を変更する前に [`AGENTS.md`](AGENTS.md) を読んでください。アーキテクチャ上の判断は [`docs/design.md`](docs/design.md)、今後の作業は [`TODO.md`](TODO.md) に記録されています。

## ライセンス

[MIT](LICENSE)
