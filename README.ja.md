# Octestra

**Serverless AI agent orchestration framework built on top of GitHub**

<p align="center">
<img src="docs/assets/octestra-logo.png" alt="Octestra" width="200">
</p>

Octestra は、GitHub Issue を起点に、AI エージェントによるタスクの実装、プルリクエスト作成、検証までを GitHub Actions 上で実行するフレームワークです。organization の Issue Field で task issue の進行を管理し、人間によるレビューとマージまでの流れを支援します。

📖 [English](README.md) · [実装ガイド](docs/integration.ja.md)

各ノードは task issue の `AI Task Status`、矢印は次の status へ進める操作を表します。

![Octestra のタスクライフサイクル](docs/assets/lifecycle.ja.svg)

## 主な機能

Octestra に AI エージェント自体は含まれません。GitHub Issue で管理されたタスクに対して、
指定した skill を任意の AI エージェントで実行できます。

- **Issue ベースのオーケストレーション** — status の変化に応じて、task を適切な agent と skill に
  引き渡し、実装、検証、人間によるレビューまでを GitHub 上の一つの流れとしてつなぎます。
- **GitHub Actions の boilerplate** — エージェントを GitHub Actions 上で動かすための workflow と
  関連ファイルのひな型を提供します。local action でエージェントのセットアップと実行方法を、
  prompt と skill でエージェントへの指示とリポジトリ固有の作業方針を定義します。
- **追跡しやすい activity** — Octestra の実行結果と検証内容を Issue comment に自動で記録し、
  各 task で何が起きたのかを簡単に追跡できます。

## はじめに

### 必要なもの

- GitHub organization に属するリポジトリ
  - private repository であり、コーディングエージェントを実行するメンバーを信頼できること
  - インストール時にカスタム Issue Field を作成できる organization 管理者権限
- 対象リポジトリに対して認証済みの [GitHub CLI](https://cli.github.com/)
- 対象リポジトリにインストールされた、**Contents**、**Issues**、**Pull requests** への書き込み権限を持つ GitHub App
- GitHub Actions 上で実行できるコーディングエージェント

### インストール

Octestra を利用するリポジトリのルートディレクトリでインストーラを実行します。

```sh
curl -fsSL https://raw.githubusercontent.com/ainame/octestra/refs/heads/main/install.sh | bash
```

### 仕組み

Octestra は 3 つの要素で構成されます。

1. **インストールされるファイル** — リポジトリ内でカスタマイズできる workflow、prompt、
   エージェント設定。
2. **Octestra GitHub Action** — このリポジトリがホストするタスク準備と GitHub 更新の共通処理。
3. **GitHub Project** — task issue と status をテーブルやカンバンで操作・確認するコンソール。
   Octestra 専用の Web UI を別途ホストする必要はありません。

### エージェントを設定する

インストール直後の agent action には、エージェントを実行するためのプレースホルダーがあります。
[実装ガイド](docs/integration.ja.md) に従い、実装、検証、triage の各エージェントを設定してください。

### 最初のタスクを実行する

1. EPIC issue とその sub-issue である task issue を、インストールされた issue-body contract から作成します。
2. task issue の `AI Task Status` を `Ready` に変更します。
3. 実装を開始するには `In Progress` に変更します。
4. Octestra がプルリクエストを作成し、検証後に `Human Review` へ進めます。

EPIC と task issue の書式、各 status option の意味、エージェントへの入力は [実装ガイド](docs/integration.ja.md) を参照してください。

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
