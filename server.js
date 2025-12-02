require("dotenv").config();

const express = require("express");
const path = require("path");
const multer = require("multer");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 3000;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase =
  supabaseUrl && supabaseServiceRoleKey
    ? createClient(supabaseUrl, supabaseServiceRoleKey)
    : null;

const TAG_REGEX = /^[A-Za-z0-9_-]+#\d{4}$/;
const ALLOWED_REASONS = new Set([
  "betrayal",
  "rat-tactics",
  "afk-griefing",
  "verbal-abuse",
  "cheating-exploiting",
  "offensive-name",
]);
const REASON_LABELS = {
  "betrayal": "Betrayal",
  "rat-tactics": "Rat Tactics",
  "afk-griefing": "AFK / Griefing",
  "verbal-abuse": "Verbal Abuse / Hate Speech",
  "cheating-exploiting": "Cheating / Exploiting",
  "offensive-name": "Offensive or Innaproriate Name",
};
const REASON_COLORS = {
  "betrayal": "#FD0000",
  "rat-tactics": "#A020F0",
  "afk-griefing": "#5EFDFE",
  "verbal-abuse": "#FF4FD4",
  "cheating-exploiting": "#05FD72",
  "offensive-name": "#FDE800",
};
const LEADERBOARD_FETCH_LIMIT = 5000;

function slugToTag(slug) {
  const decoded = decodeURIComponent(slug);
  const match = decoded.match(/^(.*)-(\d{4})$/);
  if (!match) return null;
  return `${match[1]}#${match[2]}`;
}
const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "video/mp4",
  "video/quicktime", // mov
  "video/webm",
  "video/x-msvideo", // avi
  "video/x-matroska", // mkv
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB cap
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      return cb(new Error("Unsupported file type"));
    }
    cb(null, true);
  },
});

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/raider/:slug", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "raider", "index.html"));
});

app.get("/api/raider/:slug/stats", async (req, res) => {
  res.set("Cache-Control", "no-store");

  if (!supabase) {
    return res.status(500).json({ error: "Supabase is not configured." });
  }

  const { span = "week" } = req.query;
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const slug = req.params.slug;
  const tag = slugToTag(slug);

  if (!tag) {
    return res.status(400).json({ error: "Invalid raider slug." });
  }

  const normalizedTag = tag.toLowerCase();

  const spanDays = span === "month" ? 30 : 7;
  const endDate = new Date();
  endDate.setUTCHours(23, 59, 59, 999);
  endDate.setUTCDate(endDate.getUTCDate() - offset * spanDays);

  const startDate = new Date(endDate);
  startDate.setUTCHours(0, 0, 0, 0);
  startDate.setUTCDate(startDate.getUTCDate() - (spanDays - 1));

  try {
    const { data: raider, error: raiderError } = await supabase
      .from("raiders")
      .select("id")
      .eq("tag", normalizedTag)
      .single();

    if (raiderError) {
      if (raiderError.code === "PGRST116") {
        return res.status(404).json({ error: "Raider not found." });
      }
      throw raiderError;
    }

    const { data: reports, error: reportsError } = await supabase
      .from("reports")
      .select("reason, created_at")
      .eq("raider_id", raider.id)
      .gte("created_at", startDate.toISOString())
      .lte("created_at", endDate.toISOString());

    if (reportsError) {
      throw reportsError;
    }

    const labels = [];
    const datasets = {};
    const dateIndex = {};

    for (let i = 0; i < spanDays; i++) {
      const d = new Date(startDate);
      d.setUTCDate(startDate.getUTCDate() + i);
      const key = d.toISOString().slice(0, 10);
      labels.push(key);
      dateIndex[key] = i;
    }

    Object.keys(REASON_LABELS).forEach((reasonKey) => {
      datasets[reasonKey] = Array(spanDays).fill(0);
    });

    reports.forEach((report) => {
      const reasonKey = report.reason;
      if (!datasets[reasonKey]) return;
      const dayKey = new Date(report.created_at).toISOString().slice(0, 10);
      const idx = dateIndex[dayKey];
      if (typeof idx === "number") {
        datasets[reasonKey][idx] += 1;
      }
    });

    const displayLabels = labels.map((key, idx) => {
      const d = new Date(key + "T00:00:00Z");
      if (span === "month") {
        return String(d.getUTCDate());
      }
      return d.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      });
    });
    if (offset === 0 && span !== "month" && displayLabels.length > 0) {
      displayLabels[displayLabels.length - 1] = "Today";
    }

    const response = {
      span,
      offset,
      rangeMonth: startDate.toLocaleString("en-US", {
        month: "long",
        timeZone: "UTC",
      }),
      labels,
      displayLabels,
      datasets: Object.keys(datasets).map((reasonKey) => ({
        label: REASON_LABELS[reasonKey],
        key: reasonKey,
        data: datasets[reasonKey],
        color: REASON_COLORS[reasonKey],
      })),
    };

    res.json(response);
  } catch (error) {
    res.status(500).json({ error: error.message || "Unexpected error" });
  }
});

app.get("/api/raider/:slug/comments", async (req, res) => {
  if (!supabase) {
    return res.status(500).json({ error: "Supabase is not configured." });
  }

  const slug = req.params.slug;
  const tag = slugToTag(slug);
  const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 200, 500));
  const sort = req.query.sort === "recent" ? "recent" : "top";

  if (!tag) {
    return res.status(400).json({ error: "Invalid raider slug." });
  }

  const normalizedTag = tag.toLowerCase();

  try {
    const { data: raider, error: raiderError } = await supabase
      .from("raiders")
      .select("id")
      .eq("tag", normalizedTag)
      .single();

    if (raiderError) {
      if (raiderError.code === "PGRST116") {
        return res.status(404).json({ error: "Raider not found." });
      }
      throw raiderError;
    }

    const { data: reports, error: reportsError } = await supabase
      .from("reports")
      .select("id, comments, reason, created_at, evidence_urls, upvotes, downvotes")
      .eq("raider_id", raider.id)
      .order(sort === "recent" ? "created_at" : "upvotes", {
        ascending: sort === "recent",
        nullsFirst: false,
      })
      .limit(limit);

    if (reportsError) {
      throw reportsError;
    }

    const comments = (reports || []).map((r) => ({
      id: r.id,
      comment: r.comments,
      reason: REASON_LABELS[r.reason] || r.reason,
      created_at: r.created_at,
      evidence_urls: r.evidence_urls || [],
      upvotes: Number.isFinite(r.upvotes) ? r.upvotes : 0,
      downvotes: Number.isFinite(r.downvotes) ? r.downvotes : 0,
      score:
        (Number.isFinite(r.upvotes) ? r.upvotes : 0) -
        (Number.isFinite(r.downvotes) ? r.downvotes : 0),
    }));

    res.json({ comments });
  } catch (error) {
    res.status(500).json({ error: error.message || "Unexpected error" });
  }
});

app.get("/api/leaderboard", async (req, res) => {
  res.set("Cache-Control", "no-store");

  if (!supabase) {
    return res.status(500).json({ error: "Supabase is not configured." });
  }

  const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 10, 25));

  try {
    const { data: rows, error } = await supabase
      .from("reports")
      .select("raider_id, raiders(tag)")
      .limit(LEADERBOARD_FETCH_LIMIT);

    if (error) {
      throw error;
    }

    const counts = new Map();
    (rows || []).forEach((row) => {
      const tag = row?.raiders?.tag;
      if (!tag) return;
      const normalized = tag.toLowerCase();
      counts.set(normalized, {
        tag,
        count: (counts.get(normalized)?.count || 0) + 1,
      });
    });

    const leaderboard = Array.from(counts.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);

    res.json({ leaderboard });
  } catch (error) {
    res.status(500).json({ error: error.message || "Unexpected error" });
  }
});

app.post("/api/comments/:id/vote", async (req, res) => {
  if (!supabase) {
    return res.status(500).json({ error: "Supabase is not configured." });
  }

  const id = req.params.id;
  const vote = req.query.vote === "down" ? "down" : "up";
  const prev = req.query.prev === "up" || req.query.prev === "down" ? req.query.prev : null;

  try {
    const { data: existing, error: fetchError } = await supabase
      .from("reports")
      .select("id, upvotes, downvotes")
      .eq("id", id)
      .single();

    if (fetchError) {
      if (fetchError.code === "PGRST116") {
        return res.status(404).json({ error: "Comment not found." });
      }
      throw fetchError;
    }

    const upvotes = Number.isFinite(existing.upvotes) ? existing.upvotes : 0;
    const downvotes = Number.isFinite(existing.downvotes) ? existing.downvotes : 0;

    let newUp = upvotes;
    let newDown = downvotes;

    if (prev === vote) {
      return res.json({
        id,
        upvotes: newUp,
        downvotes: newDown,
        score: newUp - newDown,
      });
    }

    if (vote === "up") {
      newUp += 1;
      if (prev === "down") {
        newDown = Math.max(0, newDown - 1);
      }
    } else {
      newDown += 1;
      if (prev === "up") {
        newUp = Math.max(0, newUp - 1);
      }
    }

    const { data: updated, error: updateError } = await supabase
      .from("reports")
      .update({ upvotes: newUp, downvotes: newDown })
      .eq("id", id)
      .select("id, upvotes, downvotes")
      .single();

    if (updateError) {
      throw updateError;
    }

    res.json({
      id,
      upvotes: updated.upvotes,
      downvotes: updated.downvotes,
      score: (updated.upvotes || 0) - (updated.downvotes || 0),
    });
  } catch (error) {
    res.status(500).json({ error: error.message || "Unexpected error" });
  }
});

const handleUpload = (req, res, next) => {
  upload.array("evidence", 5)(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: err.message });
    }
    next();
  });
};

app.post("/api/report", handleUpload, async (req, res) => {
  if (!supabase) {
    return res.status(500).json({ error: "Supabase is not configured." });
  }

  const { tag, reason, comments } = req.body || {};
  const evidenceFiles = Array.isArray(req.files) ? req.files : [];

  if (!tag || !TAG_REGEX.test(tag)) {
    return res.status(400).json({ error: "Invalid tag. Use username#1234." });
  }

  if (!reason || !ALLOWED_REASONS.has(reason)) {
    return res.status(400).json({ error: "Invalid report reason." });
  }

  const normalizedTag = tag.toLowerCase();

  try {
    const { data: raider, error: raiderError } = await supabase
      .from("raiders")
      .upsert({ tag: normalizedTag }, { onConflict: "tag" })
      .select()
      .single();

    if (raiderError) {
      throw raiderError;
    }

    const evidenceUrls = [];

    for (const file of evidenceFiles) {
      const safeName = file.originalname.replace(/\s+/g, "_");
      const storagePath = `raider/${raider.id}/${Date.now()}-${safeName}`;

      const { error: uploadError } = await supabase.storage
        .from("evidence")
        .upload(storagePath, file.buffer, {
          contentType: file.mimetype,
          cacheControl: "3600",
          upsert: false,
        });

      if (uploadError) {
        throw uploadError;
      }

      const { data: publicData } = supabase.storage
        .from("evidence")
        .getPublicUrl(storagePath);

      if (publicData?.publicUrl) {
        evidenceUrls.push(publicData.publicUrl);
      }
    }

    const { error: reportError } = await supabase.from("reports").insert({
      raider_id: raider.id,
      reason,
      comments: comments ? String(comments) : null,
      evidence_urls: evidenceUrls.length ? evidenceUrls : null,
    });

    if (reportError) {
      throw reportError;
    }

    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message || "Unexpected error" });
  }
});

app.listen(PORT, () => {
  console.log(`RaidersWatch listening on http://localhost:${PORT}`);
});
