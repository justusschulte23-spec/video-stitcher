import express from "express";
import { exec as execCb } from "child_process";
import { writeFile, unlink } from "fs/promises";
import { promisify } from "util";
const exec = promisify(execCb);

const app = express();
app.use(express.json());

// health check
app.get("/healthz", (_, res) => res.send("ok"));

// helper: download via curl (handles redirects/https robustly)
async function download(url, outPath) {
  // -L follow redirects, -sS silent but show errors, -o output
  const cmd = `curl -L -sS "${url}" -o "${outPath}"`;
  await exec(cmd);
}

// helper: get duration (seconds, float) with ffprobe
async function getDuration(path) {
  const { stdout } = await exec(
    `ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "${path}"`
  );
  return parseFloat(stdout.trim());
}

app.post("/stitch", async (req, res) => {
  try {
    const { clips = [], fade = 0.5 } = req.body || {};
    if (!Array.isArray(clips) || clips.length < 2) {
      return res.status(400).json({ error: "Provide at least 2 clip URLs" });
    }

    // 1) download all clips to /tmp
    const local = await Promise.all(
      clips.map(async (u, i) => {
        const p = `/tmp/clip_${i}.mp4`;
        await download(u, p);
        return p;
      })
    );

    // 2) get durations
    const durs = await Promise.all(local.map(p => getDuration(p)));

    // 3) build xfade filter dynamically (video only; your clips have no audio)
    // inputs formatting
    const prep = local.map((_, i) => `[${i}:v]setpts=PTS-STARTPTS,format=yuv420p[v${i}]`).join(";");
    // chain v0 ⨉ v1 → x1, then x1 ⨉ v2 → x2, ...
    let chain = `[v0][v1]xfade=transition=fade:duration=${fade}:offset=${Math.max(0, durs[0]-fade)}[x1]`;
    for (let i = 2; i < local.length; i++) {
      const prevLabel = i === 2 ? "x1" : `x${i-1}`;
      chain += `;[${prevLabel}][v${i}]xfade=transition=fade:duration=${fade}:offset=${Math.max(0, (durs.slice(0,i).reduce((a,b)=>a+b,0) - fade))}[x${i}]`;
    }
    const lastLabel = `x${local.length-1}`;

    const filter = `${prep};${chain}`;

    // 4) run ffmpeg (NO separate -vf; format is already inside the filter graph)
    const out = "/tmp/final_output.mp4";
    const inputArgs = local.flatMap(p => ["-i", p]);
    const cmd = [
      "ffmpeg",
      "-y",
      ...inputArgs,
      "-filter_complex", `"${filter}"`,
      "-map", `[${lastLabel}]`,
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "20",
      "-movflags", "+faststart",
      out
    ].join(" ");

    await exec(cmd);

    // stream back the mp4
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", 'attachment; filename="stitched.mp4"');
    res.sendFile(out, async () => {
      // cleanup
      await Promise.all(local.map(p => unlink(p).catch(()=>{})));
      await unlink(out).catch(()=>{});
    });

  } catch (err) {
    console.error("Server error:", err);
    res.status(500).json({ error: "FFmpeg failed", detail: String(err) });
  }
});

// Railway will inject PORT
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on ${port}`));
