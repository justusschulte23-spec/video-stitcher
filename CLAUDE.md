# video-stitcher

Express + FFmpeg service that stitches 2–3 MP4 clips together with crossfade transitions, overlays a voiceover audio track, and burns word-level subtitles into the output. Deployed on Railway.

## Architecture

- **Runtime**: Node.js 18, ESM (`"type": "module"`)
- **Framework**: Express 4
- **Media processing**: FFmpeg (system binary, installed in Docker)
- **Subtitle generation**: Word-level SRT — either via OpenAI Whisper API (auto-transcribe from audio) or evenly-distributed from provided text
- **Fonts**: `/app/fonts/Anton-Regular.ttf` used for subtitle rendering

## Single entry point

`server.js` — everything lives here (no separate modules/routes).

## API

### `POST /stitch`

**Body** (JSON):
```json
{
  "clips":          ["<url1>", "<url2>", "<url3>"],   // 2–3 video URLs (required)
  "audioUrl":       "<url>",                           // voiceover audio URL (optional)
  "subtitles_text": "word1 word2 ...",                 // manual subtitle text (optional)
  "autoSubtitles":  true,                              // default true; set false to skip Whisper
  "fade":           0.5,                               // crossfade duration in seconds
  "audioGain":      1.0,                               // audio volume multiplier
  "subtitleDelay":  0.1,                               // subtitle delay in seconds
  "targetDuration": 29,                                // target output length in seconds
  "fadeOut":        2                                  // fade-to-black duration at end
}
```

Returns the stitched `.mp4` as `video/mp4` binary stream.

### `GET /health`

Returns `200 ok` — used by Railway for health checks.

## Subtitle generation priority

1. `subtitles_text` provided → evenly-distributed word timing (old method)
2. `audioUrl` provided + `autoSubtitles !== false` + `OPENAI_API_KEY` set → Whisper word-level timestamps
3. Neither → no subtitles

## Environment variables

| Variable         | Required | Description                        |
|------------------|----------|------------------------------------|
| `PORT`           | No       | Server port (default 3000, Railway sets 8080) |
| `OPENAI_API_KEY` | For auto-subtitles | OpenAI API key for Whisper transcription |

## Running locally

```bash
npm install
OPENAI_API_KEY=sk-... node server.js
```

Requires `ffmpeg` installed locally.

## Docker / Railway

```bash
docker build -t video-stitcher .
docker run -p 8080:8080 -e OPENAI_API_KEY=sk-... video-stitcher
```

The Dockerfile installs FFmpeg via `apt-get` and sets `PORT=8080`.

## Key implementation notes

- All temp files go in `/tmp` (writable on Railway)
- Subtitles directory: `/tmp/subs/subtitles.srt`
- Subtitle style: Anton font, white text, teal outline (`&H0037AFD4`), 36pt, bottom-center
- FFmpeg preset: `ultrafast` + CRF 23, output `1080:-2` @ 30fps, `yuv420p`, `+faststart`
- `xfade` filter chains clips; `tpad` pads short content to `targetDuration`
- Response timeout: 600s (10 min)
