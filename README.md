# Cat Tube

Cat Hub と独立した動画サービスです。YouTube Data API v3 をサーバー側で呼び、API キーはブラウザへ送りません。ホーム、検索、視聴、チャンネル、プレイリスト、Shorts、関連動画、履歴、お気に入り、設定を提供します。ライブラリの個人データは現在ブラウザの localStorage に保存します。

## 設定

Render のサービス環境変数に `YOUTUBE_API_KEY` を設定してください。未設定でもアプリと `/healthz` は起動しますが、検索などの動画 API は 503 を返します。

```sh
npm ci
npm start
```

`PORT` は Render が設定します。Dockerfile は Node.js のみを含み、PostgreSQL や yt-dlp は必要ありません。
