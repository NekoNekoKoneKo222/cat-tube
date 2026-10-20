# Cat Tube 3.2 - Invidious HTML + HTML5 video

Cat Tube は Invidious の通常の HTML ページを読み取る動画サイトです。Invidious の JSON API（/api/v1）も YouTube Data API も使用しません。

## 動画検索と再生

1. 複数の Invidious サーバーの通常ページ（/search?q=... または /watch?v=...）を同時に取得します。
2. 不正な HTML とエラーを除外し、最初に有効な結果を返したサーバーを採用します。
3. 動画ページ内にある HTML5 video の source 要素から、mp4 等の再生 URL を抽出します。
4. Cat Tube 自身の HTML5 video タグに、選ばれたサーバーのメディア URL を設定します。iframe 埋め込みは使用しません。
5. 再生に失敗すると別のサーバーの /watch 動画ページを取り直し、別の再生 URL を HTML5 プレイヤーに設定します。

Invidious 標準の /latest_version?id=...&itag=... は動画を配信するメディアエンドポイントであり、無効化されている /api/v1 JSON メタデータ API ではありません。

**制約:** 動画のページ HTML 取得が速くても、そのサーバーから映像データが速く配信できるとは限りません。公開サーバーに YouTube 側のアクセス制限や配信制限がある場合は、HTML5 プレイヤーも再生できません。

## 主な機能

- HTML 検索と HTML 動画ページの並列レース
- HTML5 のビデオプレイヤー（通常の再生、停止、音量、シーク、全画面）
- 再生に失敗した場合のサーバー切り替え
- サーバーステータス、音楽・ゲーム・映画、チャンネル
- ブラウザ内お気に入りと視聴履歴
- 絵文字を使わないダーク UI
- Docker / Render デプロイ

## ローカル

Node.js 20 以上が必要です。

    npm install
    npm test
    npm start

http://localhost:3000 を開いてください。

## Render

render.yaml に対応しています。カスタムインスタンスを設定する環境変数:

    INVIDIOUS_INSTANCES=https://inv.nadeko.net,https://invidious.nerdvpn.de,https://yt.chocolatemoo53.com,https://invidious.tiekoetter.com,https://invidious.f5.si
    INVIDIOUS_TIMEOUT_MS=6500

## Cat Tube 内部エンドポイント

- GET /healthz
- GET /cat/instances?refresh=1
- GET /cat/search?q=cats
- GET /cat/trending?type=music
- GET /cat/videos/VIDEO_ID
- GET /cat/videos/VIDEO_ID?instance=URL_ENCODED_CONFIGURED_ORIGIN
- GET /cat/channels/CHANNEL_ID

内部の /cat エンドポイントは Cat Tube 自身のサーバーです。外部の Invidious JSON API を呼び出すものではありません。

## HTML5 動画ソースの取得と復旧（3.2）

Cat Tube は Invidious の通常の HTML を取得して解析します。JSON メタデータ API は不要です。

動画再生では以下の順番で試みます。

1. 複数の公開 Invidious サーバーの `/watch?v=VIDEO_ID` を並列取得。
2. 各ページに HTML5 の再生ソースがない場合、そのサーバーの `/embed/VIDEO_ID` の HTML を確認。
3. 最も早く有効な再生ソースを返したサーバーを選択。
4. 通常の `/latest_version` に加え、Invidious Companion が発行した署名付き HTTPS `/latest_version` をサポート。URL 内の動画 ID を検証してからブラウザの HTML5 `<video>` に渡します。
5. 再生失敗時は別の接続先からソースを取得し直します。

**注意:** Companion サーバーの配信 URL は HTML ページ側のホストと異なる場合があります。動画の通信は選択された配信元へブラウザから行い、Cat Tube のバックエンドは動画バイト列をプロキシしません。配信元のアクセス制限や一時的な障害がある場合は、そのまま再生できない可能性があります。
