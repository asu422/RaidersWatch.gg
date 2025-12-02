#!/usr/bin/env node
/**
 * Seed mock raider reports into Supabase so charts have data.
 *
 * Usage: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/seed-mock-data.js [username#1234]
 */
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env.");
  process.exit(1);
}

const tagArg = process.argv[2] || "demo#1234";
const TAG_REGEX = /^[A-Za-z0-9_-]+#\d{4}$/;

if (!TAG_REGEX.test(tagArg)) {
  console.error("Tag must match username#1234 format.");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

const reasons = [
  "betrayal",
  "rat-tactics",
  "afk-griefing",
  "verbal-abuse",
  "cheating-exploiting",
  "offensive-name",
];

const comments = [
  "Griefed team during extraction.",
  "Caught using questionable tactics.",
  "Went AFK mid-match.",
  "Toxic language in voice chat.",
  "Possible wallhacks.",
  "Name is offensive.",
  "Repeated rat tactics on objective.",
  "Suspected exploiting a map glitch.",
  "Team betrayal near the end.",
  "Multiple betrayals reported this week.",
  "Objective thrown intentionally.",
  "Suspicious radar-like awareness.",
];

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function isoDaysAgo(daysAgo) {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString();
}

async function main() {
  const normalizedTag = tagArg.toLowerCase();

  const { data: raider, error: raiderError } = await supabase
    .from("raiders")
    .upsert({ tag: normalizedTag }, { onConflict: "tag" })
    .select()
    .single();

  if (raiderError) {
    console.error("Failed to upsert raider:", raiderError);
    process.exit(1);
  }

  const rows = [];
  const days = 14;

  for (let day = days; day >= 0; day--) {
    const created_at = isoDaysAgo(day);

    // Heavier weighting on betrayal
    const betrayalCount = 2 + Math.floor(Math.random() * 4); // 2-5 per day
    for (let i = 0; i < betrayalCount; i++) {
      rows.push({
        raider_id: raider.id,
        reason: "betrayal",
        comments: Math.random() > 0.5 ? pickRandom(comments) : null,
        created_at,
        evidence_urls: null,
      });
    }

    // Other reasons 0-2 each day
    reasons
      .filter((r) => r !== "betrayal")
      .forEach((reason) => {
        const count = Math.floor(Math.random() * 3); // 0-2
        for (let i = 0; i < count; i++) {
          rows.push({
            raider_id: raider.id,
            reason,
            comments: Math.random() > 0.7 ? pickRandom(comments) : null,
            created_at,
            evidence_urls: null,
          });
        }
      });
  }

  const { error: insertError } = await supabase.from("reports").insert(rows);
  if (insertError) {
    console.error("Failed to insert reports:", insertError);
    process.exit(1);
  }

  console.log(
    `Seeded ${rows.length} reports for ${normalizedTag}. Check your chart.`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
