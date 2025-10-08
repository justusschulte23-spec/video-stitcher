import express from "express";
import { exec } from "child_process";
import fs from "fs";

const app = express();
app.use(express.json());

// Simple health check
app.get("/healthz", (req, res) => {
  res.send("ok");
});

// Stitch endpoint
app.post("/stitch", async (req, res) => {
  const { clips } = req.body; // expects array of URLs to MP4s
  if (!clips || clips.length === 0) {
    return res.status(400).json({ error: "No clips provided" });
  }

  const inputList = clips.map((url, i) => `file '${url}'`).join("\n");
  fs.writeFileSync("inputs.txt", inputList);

  const outputFile = "final_output.mp4";

  exec(`ffmpeg -f concat -safe 0 -i inputs.txt -c copy ${outputFile}`, (err) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: "Error stitching video" });
    }

    res.json({ message: "Video stitched successfully", output: outputFile });
  });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
