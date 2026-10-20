# Cat Tube 2.0

複数の Invidious 公開インスタンスから最速の正常 API 応答を選択する、YouTube 動画検索・視聴サイトです。

## Features

- Invidious API の並列リクエスト、最速の有効 JSON 応答を自動採用
- タイムアウト・不正応答・HTTP エラー時のフェイルオーバーと一時クールダウン
- 短期キャッシュと重複リクエスト共有
- 急上昇（すべて/音楽/ゲーム/映画）、検索、チャンネル、関連動画
- 動画再生（Invidious embed、使用可能なら直接再生）と再生先サーバー切替
- ローカル保存のお気に入り・視聴履歴
- レスポンシブデザイン、Render Docker 対応

## Run locally

Node.js 20+ を使用。

```bash
npm install
npm test
npm start
```

http://localhost:3000 にアクセス。

## Render deploy

Render の New > Blueprint から本リポジトリを選択してください。render.yaml を使用して Docker Web Service を作成できます。

環境変数:
- `INVIDIOUS_INSTANCES`: カンマ区切りの HTTPS インスタンス URL。例: `https://inv.nadeko.net,https://invidious.nerdvpn.de`
- `INVIDIOUS_TIMEOUT_MS`: 各サーバーのタイムアウト（デフォルト 4500ms）
- `PORT`: リッスンポート（デフォルト 3000）

API キー・データベース・Google ログインは不要です。

## Endpoints

`GET /healthz`・`GET /api/instances`・`GET /api/trending?type=gaming`・`GET /api/search?q=cat`・`GET /api/videos/:id`・`GET /api/channels/:id`

## Notes

API 応答が最速でも動画再生できるとは限りません。公開 Invidious サーバーでは YouTube によるアクセス制限、地域制限、利用制限などがありえます。「別サーバーで再生」で切り替えてください。

インスタンス一覧は将来変わるため運用時に設定を更新してください。接続先インスタンスには動画 ID 等が送信されます。

公式資料: https://docs.invidious.io/instances/ ・ https://docs.invidious.io/api/

旧 server.js に残っていた別アプリのチャット機能は上書きしてあります。GitHub の過去コミットは保持されます。
