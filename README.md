# Cat Tube 3.0 - Invidious HTML multiplexer

Cat Tube は **Invidious API を使いません**。公開インスタンスの通常の **HTML 検索ページ、急上昇ページ、動画ページ、チャンネルページ** をサーバーから取得・解析して表示します。

## サーバー選択方法

1. Cat Tube の Node.js バックエンドが、複数の Invidious HTTPS サーバーに対象ページを同時 GET します。
2. そのページの HTML が Invidious の検索一覧 / 動画 / チャンネルとして解析できることを確認します。CAPTCHA や HTTP エラーは採用しません。
3. **最初に有効な結果を返したサーバー**の結果を採用します。残った通信はキャンセルします。
4. 失敗したサーバーの HTTP ステータスと計測時間を記録し、短いクールダウン期間を設定します。
5. 動画は結果を返したサーバーの `/embed/VIDEO_ID` の HTML プレイヤーを iframe 表示します。「別サーバーで再生」で他のサーバーを試せます。

**注意:** 「動画ページの HTML が一番早く届く」ことは「動画ストリームの映像データが最も早く届く」ことと同義ではありません。公式 API の有効・無効とも無関係です。プレイヤーが再生できない場合はサーバーを切り替えてください。

公開 Invidious サーバーは YouTube 側の制限、地域制限、Bot 対策、アクセス制限により HTML 画面自体を返せない場合があります。その場合、HTML の解析方式でも検索結果は表示できません。

## 主な機能

- HTML 検索、急上昇、チャンネル、動画ページ解析
- 最速の有効 HTML を採用する並列レースと障害時フェイルオーバー
- 検索ページごとの HTTP エラー、最終応答時間を表示
- Invidious iframe 再生と接続先の手動切り替え、任意の YouTube 公式埋め込み
- 検索結果のキャッシュ、ブラウザに保存するお気に入り・視聴履歴
- API キー不要、データベース不要、Render / Docker 対応
- 画面上で絵文字を使わない UI

## Setup

Node.js 20 以上を使用してください。

```bash
npm install
npm test
npm start
```

http://localhost:3000

### Render

このリポジトリの render.yaml を使用して Docker サービスを作成してください。既存の Render サービスで、このリポジトリの main ブランチを自動デプロイしている場合は通常の更新で反映されます。

設定例:

```bash
INVIDIOUS_INSTANCES=https://inv.nadeko.net,https://invidious.nerdvpn.de,https://yt.chocolatemoo53.com,https://invidious.tiekoetter.com,https://invidious.f5.si
INVIDIOUS_TIMEOUT_MS=6500
```

- 接続先は **HTTPS origin のみ**。任意のサイト URL やパスを登録しないでください。
- `/healthz`: Cat Tube 自体の生存確認
- `/cat/instances?refresh=1`: 各サーバーで HTML の検索テストを実施。全サーバーの測定完了後、状態を返す
- `/cat/search?q=cats&page=1`: Invidious の HTML 検索結果
- `/cat/trending?type=music`: HTML 急上昇（利用不可の場合、検索結果にフォールバックし明示）
- `/cat/videos/VIDEO_ID`: HTML 動画ページ。取得失敗時は iframe 再生のみ試行
- `/cat/channels/CHANNEL_ID`: HTML チャンネルページ

なお `/cat/*` はブラウザと Cat Tube の間の通信であり、外部 Invidious API を呼び出すものではありません。

## Known limitations

- HTML 形式が変更された場合はセレクタの更新が必要です。
- 検索に失敗したときは通常の Invidious Web 検索へのリンクを表示します。
- 埋め込み先 Invidious サーバーが再生を許可していない場合、プレイヤーが動作しません。
- 動画のバイト配信を Cat Tube の Render サーバー経由で中継しない設計です（帯域と負荷を避けるため）。

Invidious documentation: https://docs.invidious.io/instances/
