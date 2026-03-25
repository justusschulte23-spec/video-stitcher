# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Single-file Express server (`server.js`) that stitches 2–3 MP4 clips into one video with crossfade transitions, optional voiceover audio, and word-level burned-in subtitles. Deployed on Railway via Docker.

- **Runtime**: Node.js 18, ESM (`"type": "module"`)
- **Only route**: `POST /stitch` — downloads inputs, runs FFmpeg, streams MP4 back
- **No tests, no build step**: `npm start` = `node server.js`

## Running locally

Requires `ffmpeg` in PATH.

```bash
npm install
OPENAI_API_KEY=sk-... node server.js
```

## FFmpeg pipeline (the core logic)

Understanding the filtergraph in `/stitch` is critical — all video logic flows through one `-filter_complex` string built at runtime:

1. **Normalize** each clip: `[N:v]setpts=PTS-STARTPTS[vN]`
2. **Chain xfade**: `[v0][v1]xfade=transition=fade:duration=${fade}:offset=${d0-fade}[v01]`, then optionally `[v01][v2]xfade...[vout]`
3. **Post-process `[vout]`**: `scale=1080:-2,fps=30,format=yuv420p` → optional `subtitles=...` filter → optional `tpad` (pad to `targetDuration`) → `fade=t=out` (fade-to-black)
4. **Audio**: mapped separately as stream `N:a?` with `aresample=48000,volume=${audioGain}`

The xfade `offset` values are computed from actual clip durations probed with `ffprobe` — getting these wrong causes A/V sync issues.

## Subtitle generation (two paths)

**Path 1 — Manual text** (`subtitles_text` in request body): words are evenly distributed across the audio/video duration with a 1.08× stretch factor. Timing is approximate.

**Path 2 — Whisper auto** (when `audioUrl` present, `autoSubtitles !== false`, `OPENAI_API_KEY` set): calls `POST /v1/audio/transcriptions` with `response_format=verbose_json` and `timestamp_granularities[]=word`. Returns actual per-word start/end timestamps → accurate SRT.

Manual text takes priority over Whisper. Whisper failure is non-fatal — logged, subtitles skipped.

SRT is written to `/tmp/subs/subtitles.srt` and passed to FFmpeg's `subtitles=` filter with `force_style` (Anton 36pt, white text, teal outline `&H0037AFD4`, `MarginV=48`). Font served from `/app/fonts/Anton-Regular.ttf`.

## Environment variables

| Variable | Purpose |
|---|---|
| `PORT` | Server port (Railway sets 8080; default 3000) |
| `OPENAI_API_KEY` | Required for Whisper auto-subtitle path |

## Temp file lifecycle

All downloads and outputs land in `/tmp` (Railway's only writable dir). Clips, audio, SRT, and final `stitched.mp4` are deleted in the response `close` event handler.

## Railway / Docker

Dockerfile: Node 18 base, installs FFmpeg via `apt-get`, sets `PORT=8080`. Add `OPENAI_API_KEY` as a Railway environment variable for Whisper support.
