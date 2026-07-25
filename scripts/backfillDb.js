// Backfills the DB from Slack (the source of truth) using the CSVs produced
// by diffNinjaHistory.js. This script NEVER calls the Slack API and NEVER
// posts anything — it only writes to Postgres.
//
//   missing-from-db.csv  → upsert the row with the already-known
//                          postedMessageId (it's already posted in Slack).
//                          announce = true — safe, because reactionAdd.ts
//                          checks postedMessageId FIRST: any row that already
//                          has one always goes through chat.update (editing
//                          the existing message), never chat.postMessage,
//                          regardless of the announce flag.
//   drifted-unposted.csv → update stars to the live count. announce = false
//                          — these have no postedMessageId yet, so this is
//                          the only thing preventing a live star crossing
//                          the threshold again from triggering a brand new,
//                          unreviewed post.
//
// The only way a drifted row becomes eligible to actually be sent is if you
// later flip its announce flag back to true yourself, or — the intended
// path — use scripts/postMissingToThread.js to surface it in a review thread
// on request. scripts/sendPendingAnnouncements.js exists as a safety-gated
// fallback for the "flip it back to true" case.
//
// Usage: node scripts/backfillDb.js [--apply]
// Default is a DRY RUN — prints what would change, writes nothing.
// Requires DATABASE_URL in .env.

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const OUTPUT_DIR = path.join(__dirname, "output");
const MISSING_CSV = path.join(OUTPUT_DIR, "missing-from-db.csv");
const DRIFTED_CSV = path.join(OUTPUT_DIR, "drifted-unposted.csv");

function parseCsv(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const [header, ...lines] = fs.readFileSync(filePath, "utf8").trim().split("\n");
  const columns = header.split(",");
  return lines
    .filter(Boolean)
    .map((line) => {
      const values = line.slice(1, -1).split('","');
      const row = {};
      columns.forEach((col, i) => (row[col] = values[i]));
      return row;
    });
}

function dedupeByOrigin(rows) {
  const byOrigin = new Map();
  for (const row of rows) {
    const key = `${row.originChannel}:${row.originTs}`;
    const existing = byOrigin.get(key);
    if (!existing || Number(row.stars) > Number(existing.stars)) byOrigin.set(key, row);
  }
  return [...byOrigin.values()];
}

async function main() {
  const apply = process.argv.includes("--apply");

  const backfillRows = dedupeByOrigin(parseCsv(MISSING_CSV));
  const driftedRows = parseCsv(DRIFTED_CSV);

  console.log(`Loaded ${backfillRows.length} backfill rows (missing-from-db.csv, deduped by origin)`);
  console.log(`Loaded ${driftedRows.length} drift-correction rows (drifted-unposted.csv)\n`);

  if (!apply) {
    console.log("=== DRY RUN — no writes will be made ===\n");
    console.log("Sample backfill upserts (first 5):");
    for (const r of backfillRows.slice(0, 5)) {
      console.log(`  INSERT/UPDATE messageId=${r.originTs} channelId=${r.originChannel} stars=${r.stars} postedMessageId=${r.postedTs} announce=true`);
    }
    console.log("\nSample drift corrections (first 5):");
    for (const r of driftedRows.slice(0, 5)) {
      console.log(`  UPDATE messageId=${r.messageId} stars: ${r.dbStars} -> ${r.liveStars} announce=false`);
    }
    console.log("\nRe-run with --apply to perform these writes for real.");
    return;
  }

  const dbUrl = new URL(process.env.DATABASE_URL);
  dbUrl.search = "";
  const db = new Client({ connectionString: dbUrl.toString(), ssl: { rejectUnauthorized: true } });

  console.log("[db] connecting...");
  await db.connect();
  console.log("[db] connected\n");

  try {
    console.log(`[backfill] upserting ${backfillRows.length} rows from missing-from-db.csv (announce=true)...`);
    let backfillCount = 0;
    for (const row of backfillRows) {
      await db.query(
        `INSERT INTO "Message" ("messageId", "channelId", stars, "postedMessageId", announce)
         VALUES ($1, $2, $3, $4, true)
         ON CONFLICT ("messageId") DO UPDATE SET
           "channelId" = EXCLUDED."channelId",
           stars = EXCLUDED.stars,
           "postedMessageId" = EXCLUDED."postedMessageId",
           announce = true`,
        [row.originTs, row.originChannel, Number(row.stars), row.postedTs]
      );
      backfillCount++;
      if (backfillCount % 500 === 0) console.log(`[backfill] ${backfillCount}/${backfillRows.length}...`);
    }
    console.log(`[backfill] done, ${backfillCount} rows upserted\n`);

    console.log(`[drift] correcting ${driftedRows.length} rows from drifted-unposted.csv (announce=false)...`);
    let driftCount = 0;
    for (const row of driftedRows) {
      await db.query(`UPDATE "Message" SET stars = $2, announce = false WHERE "messageId" = $1`, [row.messageId, Number(row.liveStars)]);
      driftCount++;
      if (driftCount % 200 === 0) console.log(`[drift] ${driftCount}/${driftedRows.length}...`);
    }
    console.log(`[drift] done, ${driftCount} rows corrected\n`);

    console.log("=== Summary ===");
    console.log(`Backfilled rows: ${backfillCount} (announce=true — already posted, updates only from here)`);
    console.log(`Drift-corrected rows: ${driftCount} (announce=false — never posted, won't auto-send)`);
    console.log("\nNo Slack message was posted. Use scripts/postMissingToThread.js to surface specific");
    console.log("drifted entries in a review thread on request.");
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
