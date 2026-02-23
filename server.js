const express = require("express");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { pipeline } = require("stream/promises");

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT || 8787);
const WORKER_TOKEN = (process.env.WORKER_TOKEN || "").trim();
const WORKER_TOKEN_HEADER = (process.env.WORKER_TOKEN_HEADER || "x-worker-token").toLowerCase();
const BASE_PUBLIC_URL = (process.env.BASE_PUBLIC_URL || "").replace(/\/+$/, "");
const JOBS_DIR = path.resolve(process.env.JOBS_DIR || path.join(__dirname, "jobs"));
const TMP_DIR = path.resolve(process.env.TMP_DIR || path.join(__dirname, "tmp"));
const VERIFY_TLS = String(process.env.VERIFY_TLS || "1") !== "0";

/** @type {Map<string, any>} */
const jobs = new Map();

function nowIso() {
  return new Date().toISOString();
}

function log(level, msg, extra) {
  const base = `[${nowIso()}] [${level}] ${msg}`;
  if (extra === undefined) {
    console.log(base);
    return;
  }
  try {
    console.log(base, JSON.stringify(extra));
  } catch {
    console.log(base, extra);
  }
}

function safeError(err) {
  if (!err) return "Unknown error";
  if (typeof err === "string") return err;
  return err.message || String(err);
}

function sanitizeFilename(input, fallback) {
  const x = String(input || "").replace(/[^\w.\-]+/g, "_").replace(/^_+|_+$/g, "");
  return x || fallback;
}

function getPublicBase(req) {
  if (BASE_PUBLIC_URL) return BASE_PUBLIC_URL;
  return `${req.protocol}://${req.get("host")}`;
}

function jobPublicArtifactUrl(req, jobId, fileName) {
  return `${getPublicBase(req)}/artifacts/${encodeURIComponent(jobId)}/${encodeURIComponent(fileName)}`;
}

function authMiddleware(req, res, next) {
  if (!WORKER_TOKEN) return next();
  const incoming = (req.get(WORKER_TOKEN_HEADER) || "").trim();
  if (!incoming || incoming !== WORKER_TOKEN) {
    log("WARN", "Unauthorized request", {
      method: req.method,
      path: req.originalUrl,
      ip: req.ip,
      hasToken: incoming !== "",
      tokenHeader: WORKER_TOKEN_HEADER,
      ua: req.get("user-agent") || "",
    });
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
}

app.use((req, res, next) => {
  const start = Date.now();
  const rid = crypto.randomUUID().slice(0, 8);
  req._rid = rid;
  log("INFO", "REQ IN", {
    rid,
    method: req.method,
    path: req.originalUrl,
    ip: req.ip,
    ua: req.get("user-agent") || "",
    host: req.get("host") || "",
  });
  res.on("finish", () => {
    log("INFO", "REQ OUT", {
      rid,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      ms: Date.now() - start,
    });
  });
  next();
});

async function ensureDirs() {
  await fsp.mkdir(JOBS_DIR, { recursive: true });
  await fsp.mkdir(TMP_DIR, { recursive: true });
}

async function downloadSource(url, headers, destFile) {
  log("INFO", "Download source start", { url });
  const opts = { headers: headers || {} };
  if (!VERIFY_TLS && url.startsWith("https://")) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }
  const resp = await fetch(url, opts);
  if (!resp.ok || !resp.body) {
    log("ERROR", "Download source failed", { url, status: resp.status });
    throw new Error(`Download source failed (${resp.status})`);
  }
  await fsp.mkdir(path.dirname(destFile), { recursive: true });
  await pipeline(resp.body, fs.createWriteStream(destFile));
  const st = await fsp.stat(destFile);
  if (st.size <= 0) throw new Error("Downloaded source is empty");
  log("INFO", "Download source done", { url, bytes: st.size });
}

function parseProgressSec(stderrChunk) {
  const lines = String(stderrChunk || "").split(/\r?\n/);
  let sec = null;
  for (const line of lines) {
    const m = line.match(/time=(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/);
    if (!m) continue;
    const v = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    sec = Number.isFinite(v) ? v : sec;
  }
  return sec;
}

function buildTrimArgs(inputFile, outputFile, options) {
  const start = Number(options.start || 0);
  const end = Number(options.end || 0);
  const mode = String(options.mode || "reencode");
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
    throw new Error("Invalid trim interval");
  }
  const args = ["-y", "-ss", String(start), "-to", String(end), "-i", inputFile];
  if (mode === "copy") {
    args.push("-c", "copy");
  } else {
    args.push("-c:v", "libx264", "-preset", "medium", "-crf", "21", "-c:a", "copy");
  }
  args.push(outputFile);
  return { args, duration: end - start };
}

function createJob(payload, req) {
  const id = "job_" + crypto.randomUUID().replace(/-/g, "");
  const now = Math.floor(Date.now() / 1000);
  const job = {
    id,
    type: String(payload.type || ""),
    request_id: payload.request_id || null,
    status: "queued",
    progress: 0,
    progress_sec: 0,
    duration_sec: 0,
    created_at: now,
    updated_at: now,
    error: null,
    artifacts: [],
    output_dir: path.join(JOBS_DIR, id),
    tmp_input: path.join(TMP_DIR, `${id}.source`),
    process: null,
    pid: 0,
    canceled: false,
    public_base: getPublicBase(req),
  };
  jobs.set(id, job);
  log("INFO", "Job created", {
    rid: req._rid,
    job_id: id,
    type: job.type,
    sourceUrl: payload?.source?.url || "",
  });
  return job;
}

async function runFfmpegJob(job, payload, req) {
  try {
    await ensureDirs();
    await fsp.mkdir(job.output_dir, { recursive: true });

    const source = payload.source || {};
    const sourceUrl = String(source.url || "");
    if (!sourceUrl) throw new Error("source.url is required");

    job.status = "running";
    job.updated_at = Math.floor(Date.now() / 1000);
    log("INFO", "Job running", {
      rid: req._rid,
      job_id: job.id,
      type: job.type,
    });

    await downloadSource(sourceUrl, source.headers || {}, job.tmp_input);

    const options = payload.options || {};
    let outputName = "out.bin";
    let ffArgs = [];
    if (job.type === "regen") {
      outputName = sanitizeFilename((payload.output || {}).filename_hint || "thumb", "thumb") + ".jpg";
      const sec = Number(options.sec || 0);
      ffArgs = ["-y", "-ss", String(Math.max(0, sec)), "-i", job.tmp_input, "-vframes", "1", "-q:v", "2", path.join(job.output_dir, outputName)];
    } else if (job.type === "portrait") {
      outputName = sanitizeFilename((payload.output || {}).filename_hint || "portrait", "portrait") + ".jpg";
      const sec = Number(options.sec || 0);
      ffArgs = ["-y", "-ss", String(Math.max(0, sec)), "-i", job.tmp_input, "-vframes", "1", "-q:v", "2", path.join(job.output_dir, outputName)];
    } else if (job.type === "trim") {
      outputName = sanitizeFilename((payload.output || {}).filename_hint || "trimmed", "trimmed") + ".mp4";
      const trim = buildTrimArgs(job.tmp_input, path.join(job.output_dir, outputName), options);
      ffArgs = trim.args;
      job.duration_sec = trim.duration;
    } else {
      throw new Error(`Unsupported type: ${job.type}`);
    }

    const ff = spawn("ffmpeg", ffArgs, { stdio: ["ignore", "ignore", "pipe"] });
    job.process = ff;
    job.pid = ff.pid || 0;
    log("INFO", "FFmpeg spawned", {
      rid: req._rid,
      job_id: job.id,
      pid: job.pid,
      args: ffArgs,
    });

    let stderrTail = "";
    ff.stderr.on("data", (chunk) => {
      const text = String(chunk || "");
      stderrTail = (stderrTail + text).slice(-8000);
      const sec = parseProgressSec(text);
      if (sec !== null) {
        job.progress_sec = sec;
        if (job.duration_sec > 0) {
          job.progress = Math.max(0, Math.min(1, sec / job.duration_sec));
        }
        log("DEBUG", "Job progress", {
          job_id: job.id,
          progress: job.progress,
          progress_sec: job.progress_sec,
          duration_sec: job.duration_sec,
        });
      }
      job.updated_at = Math.floor(Date.now() / 1000);
    });

    await new Promise((resolve, reject) => {
      ff.on("error", reject);
      ff.on("close", (code, signal) => {
        if (job.canceled || signal) return resolve();
        if (code === 0) return resolve();
        reject(new Error(`ffmpeg exit ${code}: ${stderrTail.slice(-400)}`));
      });
    });

    job.process = null;
    job.pid = 0;
    job.updated_at = Math.floor(Date.now() / 1000);

    if (job.canceled) {
      job.status = "canceled";
      log("WARN", "Job canceled", { job_id: job.id });
      return;
    }

    const outputPath = path.join(job.output_dir, outputName);
    const st = await fsp.stat(outputPath).catch(() => null);
    if (!st || st.size <= 0) throw new Error("Output artifact missing");

    job.status = "done";
    job.progress = 1;
    job.artifacts = [
      {
        kind: job.type === "trim" ? "video" : (job.type === "portrait" ? "portrait" : "thumb"),
        file: outputName,
        url: jobPublicArtifactUrl(req, job.id, outputName),
      },
    ];
    log("INFO", "Job done", {
      rid: req._rid,
      job_id: job.id,
      artifacts: job.artifacts,
    });
  } catch (err) {
    job.status = job.canceled ? "canceled" : "failed";
    job.error = safeError(err);
    job.updated_at = Math.floor(Date.now() / 1000);
    log("ERROR", "Job failed", {
      rid: req._rid,
      job_id: job.id,
      error: job.error,
    });
  } finally {
    try { await fsp.unlink(job.tmp_input); } catch {}
  }
}

app.get("/health", (_, res) => {
  res.json({ ok: true, service: "myvids-remote-worker" });
});

app.post("/jobs", authMiddleware, async (req, res) => {
  const payload = req.body || {};
  const type = String(payload.type || "");
  if (!["regen", "portrait", "trim"].includes(type)) {
    log("WARN", "Invalid job type", { rid: req._rid, type });
    return res.status(400).json({ ok: false, error: "Invalid type" });
  }
  if (!payload.source || !payload.source.url) {
    log("WARN", "Missing source.url", { rid: req._rid });
    return res.status(400).json({ ok: false, error: "source.url is required" });
  }

  const job = createJob(payload, req);
  setImmediate(() => {
    runFfmpegJob(job, payload, req).catch((err) => {
      job.status = "failed";
      job.error = safeError(err);
      job.updated_at = Math.floor(Date.now() / 1000);
    });
  });

  res.json({
    ok: true,
    job_id: job.id,
    status: job.status,
    created_at: job.created_at,
  });
});

app.get("/jobs/:id", authMiddleware, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    log("WARN", "Job not found", { rid: req._rid, job_id: req.params.id });
    return res.status(404).json({ ok: false, error: "Job not found" });
  }
  res.json({
    ok: true,
    job_id: job.id,
    request_id: job.request_id,
    type: job.type,
    status: job.status,
    progress: job.progress,
    progress_sec: job.progress_sec,
    duration_sec: job.duration_sec,
    created_at: job.created_at,
    updated_at: job.updated_at,
    artifacts: job.artifacts,
    error: job.error,
  });
});

app.post("/jobs/:id/cancel", authMiddleware, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    log("WARN", "Cancel job not found", { rid: req._rid, job_id: req.params.id });
    return res.status(404).json({ ok: false, error: "Job not found" });
  }
  if (job.status !== "running" && job.status !== "queued") {
    return res.json({ ok: true, job_id: job.id, status: job.status });
  }
  job.canceled = true;
  job.status = "canceled";
  job.updated_at = Math.floor(Date.now() / 1000);
  log("WARN", "Cancel requested", { rid: req._rid, job_id: job.id, pid: job.pid });
  if (job.process && job.pid) {
    try {
      process.kill(job.pid, "SIGTERM");
      setTimeout(() => {
        try { process.kill(job.pid, "SIGKILL"); } catch {}
      }, 1200);
    } catch {}
  }
  return res.json({ ok: true, job_id: job.id, status: "canceled" });
});

app.get("/artifacts/:jobId/:file", authMiddleware, async (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    log("WARN", "Artifact job not found", { rid: req._rid, job_id: req.params.jobId });
    return res.status(404).json({ ok: false, error: "Job not found" });
  }
  const fileName = path.basename(req.params.file);
  const abs = path.join(job.output_dir, fileName);
  if (!abs.startsWith(job.output_dir)) {
    log("WARN", "Artifact invalid path", { rid: req._rid, abs, out: job.output_dir });
    return res.status(400).json({ ok: false, error: "Invalid path" });
  }
  if (!fs.existsSync(abs)) {
    log("WARN", "Artifact not found", { rid: req._rid, abs });
    return res.status(404).json({ ok: false, error: "Artifact not found" });
  }
  log("INFO", "Artifact served", { rid: req._rid, file: abs });
  res.sendFile(abs);
});

ensureDirs()
  .then(() => {
    app.listen(PORT, () => {
      log("INFO", `myVids remote worker running on :${PORT}`, {
        tokenHeader: WORKER_TOKEN_HEADER,
        tokenEnabled: WORKER_TOKEN !== "",
      });
    });
  })
  .catch((err) => {
    log("ERROR", "Failed to start worker", { error: safeError(err) });
    process.exit(1);
  });
