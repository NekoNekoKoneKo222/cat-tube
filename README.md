# Cat Tube

YouTube Data API v3 + official YouTube embed + optional server-side yt-dlp stream proxy.

## Deploy: Render (recommended)

1. Push this folder to a GitHub repository.
2. In Render, create **New > Blueprint** and select the repository.
3. Render reads `render.yaml` and creates the `cat-tube` web service.
4. Set these environment variables in Render:
   - `YOUTUBE_API_KEY`
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
   - `GOOGLE_CALLBACK_URL` = `https://YOUR-RENDER-DOMAIN/auth/google/callback`
5. Deploy.
6. In Google Cloud Console, add exactly the same callback URL to the OAuth client under **Authorized redirect URIs**.

## Local

```bash
cp .env.example .env
npm install
npm start
```

Open `http://localhost:3000`.

## Features

- YouTube Data API v3 search
- Video detail/watch page
- Official YouTube no-cookie embed
- Direct Stream mode through a backend HTTP proxy using yt-dlp
- Channel pages
- YouTube playlist pages
- Google OAuth login
- User playlists
- Download endpoint for content the user is authorized to download
- Docker / Render deployment

## Important deployment note

The included JSON file store is intended for a demo/small deployment. Render's default filesystem is ephemeral, so user playlists should not be treated as durable production data. For a real production deployment, move users/playlists/session persistence to Postgres and use a persistent session store.

## Legal / platform note

Use the stream proxy and download functionality only for videos/content you are authorized to access, process, cache, or download, and in accordance with applicable laws and platform terms. The official embedded player remains the default playback mode.
