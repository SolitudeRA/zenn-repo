# Zenn用記事リポジトリ

このリポジトリは、[Blog-Project](https://github.com/SolitudeRA/Blog-Project) のサブリポジトリとして、Zenn向けの記事管理および公開を効率化するために使用されます。GitHub Actionsを活用し、記事の自動更新、シリーズリンク生成、公開プロセスを自動化します。

---

## 特徴

- **Zenn記事管理**  
  Zenn用の記事の自動更新、シリーズリンクの生成、公開プロセスを一元管理。

- **自動化ワークフロー**  
  GitHub Actionsを活用し、記事の解析、リンク生成、コミット・プッシュを完全自動化。

- **シリーズリンク生成**  
  記事の `series` 情報に基づき、自動的にリンクを生成し記事に挿入します。

---

## 必要なセットアップ

### 1. **リポジトリのクローン**

以下のコマンドでリポジトリをクローンします：

```bash
git clone https://github.com/SolitudeRA/zenn-repo.git
cd zenn-repo
```

### 2. **依存パッケージのインストール**

Node.jsがインストールされていることを確認し、以下のコマンドを実行してください：

```bash
npm install
```

---

## ディレクトリ構成

```
.
├── articles/        # Zenn用の記事が格納されるディレクトリ
│   ├── .keep        # 空のディレクトリを保持するためのファイル
│   └── *.md         # Zenn用のMarkdownファイル
├── books/           # Zennで公開する本が格納されるディレクトリ
│   ├── .keep        # 空のディレクトリを保持するためのファイル
├── pre-publish/     # 公開準備中の記事が格納されるディレクトリ
├── scripts/         # 自動化スクリプト
│   ├── parse-articles.js         # 記事を解析し、公開準備を行うスクリプト
│   ├── generate-series-links.js  # シリーズリンクを生成するスクリプト
├── .github/         # GitHub Actionsの設定
│   └── workflows/
│       └── publish_articles.yml  # 記事公開を自動化するワークフロー
├── LICENSE          # ライセンスファイル
└── README.md        # このファイル
```

---

## 使用方法

### 記事を公開する手順

1. 自動的にメインリポジトリ`blog-project`のコミットから`pre-publish` に記事を追加または更新します。
2. GitHub Actions が自動的に以下の処理を実行します：
   - 記事の解析（`parse-articles.js`）。
   - シリーズリンクの生成（`generate-series-links.js`）。
   - 記事の変更内容をリポジトリにコミット＆プッシュ。

---

## GitHub Actions ワークフローの流れ

1. **記事の解析**  
   `pre-publish` に格納されている記事を解析し、公開可能な形式に変換。

2. **シリーズリンクの生成**  
   記事の `series` 情報を基にリンクを生成し、記事内に挿入。

3. **リポジトリへの更新内容をコミット＆プッシュ**  
   更新された記事を Zenn 用リポジトリにコミットし、プッシュ。

---

## 安全な記事 ID プロトコル

Zenn の公開 URL は `articles/<slug>.md` のファイル名で決まります。公開後に
slug を変えると別記事になるため、このリポジトリではタイトルを記事の識別子
として使用しません。

### 2つの管理ファイル

- `pre-publish/manifest.json`
  - メインリポジトリの `articles/manifest.json` を**内容を変えずにコピー**した
    完全な配信スナップショットです。
  - Zenn 対象は `targets.zenn.desired` を持つエントリだけです。
  - `source` は `articles/share/<basename>.md` または
    `articles/zenn/<basename>.md` のみ受け付けます。パス越境と basename の
    重複は拒否されます。
- `article-map.json`
  - Zenn 固有の `article_id -> slug` binding です。
  - 既存 binding の slug・lifecycle の変更や削除は禁止です。CI では
    push event の `${{ github.event.before }}` を明示的な比較元として使い、
    複数 commit を含む push でも push 前の map と比較します。新しい binding
    の追加だけが通常処理で許可されます。

現在の安全切片が処理する状態は
`article_state: active` かつ `targets.zenn.desired: published` のみです。
`retiring`、`retired`、`withdrawn` は、意図せず記事を非公開化しないよう
明示的にエラーで停止します。ソースが snapshot から消えても、既存の
`articles/*.md` を自動削除・再作成・非公開化することはありません。

### タイトル変更と記事リンク

parser と series generator は常に `article_id` で binding を引きます。
タイトルや `source` のファイル名を変更しても、既存 slug は変わりません。
`article_id` は全リポジトリ共通で 32 文字の小文字 hex とし、ハイフン付き UUID
など別形式は受け付けません。

記事間リンクにはタイトルではなく次の記法を使用します。

```markdown
<<<article:339243802597e8c42bcddfb10b5e94e3>>>
```

生成時に、参照先の現在のタイトルと固定 slug を使った Zenn URL に変換されます。
旧 `<<<タイトル>>>` 記法、未解決 ID、重複 ID、target 欠損、未管理 target は
すべて書き込み前に検出されます。

### ローカル検証

```bash
npm ci
npm run typecheck
npm test
npm run check:articles  # 読み取り専用 dry-run
npm run build:articles  # 検証後に生成結果を適用
npx zenn list:articles
```

`build:articles` は series block と ID link の生成まで1プロセスで完了します。
検証エラーがある場合、article や map を書き始めません。
workflow は commit message を理由に検証 job をスキップしません。生成 commit の
再実行は `GITHUB_TOKEN` の標準トリガー制御と、差分がなければ commit しない
guard で収束させます。
履歴上の任意の revision と比較する場合は
`npm run check:articles -- --base-ref=<revision>` を使用します。指定した
revision やその `article-map.json` を読めない場合は fail closed で停止します。
比較元 tree に map がなくても、その commit から可達な履歴を検索します。過去に
map が存在した場合は最新の既存 map を復元して不可変比較を続けます。可達履歴に
map が一度も現れていないことを Git で確認できた初回導入時だけ、履歴比較なしの
bootstrap を許可します。

---

## 開発者向け情報

### スクリプト一覧

- **`parse-articles.js`**  
  manifest と map を検証し、ID binding を維持したまま最終記事を生成します。

- **`generate-series-links.js`**  
  `article_id` に基づくシリーズ・記事間リンクを生成します。parser からも利用
  される純粋な生成モジュールです。

- **`article-identity.js`**
  manifest、binding、source、target、参照の fail-closed 検証を担当します。

`npm run typecheck` は `tsconfig.json` に従って既存 JavaScript を静的検査します。
この段階ではファイルを生成せず、公開時の Node.js 実行方法も変更しません。

### デバッグ

以下のコマンドでローカル環境でスクリプトを実行できます：

```bash
npm run typecheck
npm test
npm run check:articles
npm run build:articles
```

---

## ライセンス

このリポジトリは [MITライセンス](LICENSE) のもとで公開されています。
