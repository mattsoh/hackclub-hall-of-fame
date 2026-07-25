require("dotenv").config();
const { Client } = require("pg");

async function main() {
  const cutoff = process.argv[2];
  const dbUrl = new URL(process.env.DATABASE_URL);
  dbUrl.search = "";
  const db = new Client({ connectionString: dbUrl.toString(), ssl: { rejectUnauthorized: true } });
  await db.connect();
  try {
    const res = await db.query(
      `SELECT "messageId", "channelId", stars, "postedMessageId", announce FROM "Message"
       WHERE "messageId" >= $1
       ORDER BY "messageId" ASC`,
      [cutoff]
    );
    console.log(`Total messages in last 24h: ${res.rows.length}`);
    const eligible = res.rows.filter(r => r.announce && r.stars >= 5 && (!r.postedMessageId || r.postedMessageId === ''));
    console.log(`Eligible to post: ${eligible.length}`);
    for (const r of eligible) {
      console.log(`  ${r.stars}⭐ https://hackclub.slack.com/archives/${r.channelId}/p${r.messageId.replace(".", "")}`);
    }
    console.log("\nAll rows in window (for reference):");
    for (const r of res.rows) {
      console.log(`  ts=${r.messageId} stars=${r.stars} announce=${r.announce} posted=${r.postedMessageId || ''}`);
    }
  } finally {
    await db.end();
  }
}
main().catch(e => { console.error(e); process.exit(1); });
