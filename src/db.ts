// Every database access in the project. Two tables, raw SQL, one pool.
//
// This replaces a split where the live event handlers used Prisma while the
// background jobs used raw pg — with a comment in the pg helper explaining
// that Prisma's query engine has never been able to open a TLS connection to
// this Postgres instance in any environment tested. That made the live path
// (the thing that actually posts to #hall-of-fame) the one part of the system
// running on the client known not to work here. Prisma is gone entirely: no
// query engine, no generate step in the Docker build, no second connection
// story.

import { Pool, PoolClient } from "pg";
import * as tls from "tls";
import { log } from "./log";

// The server's TLS cert is issued for the external tier2 hostname, but in
// production DATABASE_URL points at the internal Kubernetes service DNS name
// (a different hostname for the same database) — so strict hostname
// verification against the connection string's own host would always fail.
// Overriding the verification target to the name the cert actually covers
// fixes this without weakening verification: it is still a full chain + name
// check against a real CA-signed cert, just checked against the right name.
//
// pg's connection.js unconditionally overwrites ssl.servername with the
// connection host right before the TLS handshake, clobbering any override
// there — so this has to be done via checkServerIdentity, which pg does not
// touch.
const CERT_SERVERNAME = "a.db.tier2.infra.hackclub.com";

export interface MessageRow {
  messageId: string;
  channelId: string;
  stars: number;
  postedMessageId: string | null;
  skip: boolean;
  // Timestamp of the approval request posted in the log channel, when this
  // message hit a rate limit and is waiting on a human. Non-null means "already
  // asked" — that is what stops it being asked about on every reconcile run.
  approvalTs: string | null;
}

export interface StateRow {
  scanCursor: string | null;
  lastReconcileAt: Date | null;
}

// A real Slack ts, as opposed to '' or NULL. Used everywhere "is this actually
// posted?" is asked, so the answer is the same in every query.
const POSTED = "\"postedMessageId\" ~ '^[0-9]+\\.[0-9]+$'";
const NOT_POSTED = "(\"postedMessageId\" IS NULL OR \"postedMessageId\" !~ '^[0-9]+\\.[0-9]+$')";

let pool: Pool | undefined;

function connectionString(): string {
  const url = new URL(process.env.DATABASE_URL as string);
  // Prisma-style parameters (?schema=, ?sslmode=, ?connection_limit=) are not
  // valid libpq connection parameters and make pg fail at connect, so the
  // query string is dropped. A non-default schema would silently be ignored,
  // which is worth saying out loud rather than debugging later.
  const schema = url.searchParams.get("schema");
  if (schema && schema !== "public") {
    log.warn(`DATABASE_URL requests schema "${schema}", which is ignored — tables are read from the default search_path.`);
  }
  url.search = "";
  return url.toString();
}

export function db(): Pool {
  if (pool) return pool;
  pool = new Pool({
    connectionString: connectionString(),
    ssl: {
      rejectUnauthorized: true,
      checkServerIdentity: (_hostname, cert) => tls.checkServerIdentity(CERT_SERVERNAME, cert),
    },
    // A reconcile run spans tens of minutes but issues short queries, so the
    // pool hands one back between them rather than holding a single connection
    // open across the whole run with no keepalive — which is how the old job
    // did it, and is a good way to discover an idle-timeout the hard way.
    max: 4,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
    keepAlive: true,
  });
  // Without a listener, an idle client erroring out (a server restart, a
  // network blip) is an unhandled 'error' event, which takes the process down.
  pool.on("error", (err) => log.warn("Idle database client errored", err));
  return pool;
}

export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const res = await db().query(sql, params);
  return res.rows as T[];
}

// Idempotent schema setup, run once at boot and nowhere else — the CLI relies on
// the app having done it, so no read-only command can alter the schema. Replaces
// `prisma migrate deploy`, which needs the same Rust TLS stack as the query
// engine that cannot reach this server.
export async function initSchema(): Promise<void> {
  const client: PoolClient = await db().connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS "Message" (
        "messageId"       TEXT PRIMARY KEY,
        "channelId"       TEXT NOT NULL,
        "stars"           INTEGER NOT NULL DEFAULT 0,
        "postedMessageId" TEXT,
        "skip"            BOOLEAN NOT NULL DEFAULT false,
        "claimedAt"       TIMESTAMPTZ,
        "approvalTs"      TEXT
      );
      CREATE TABLE IF NOT EXISTS "AppState" (
        "id"              INTEGER PRIMARY KEY,
        "scanCursor"      TEXT,
        "lastReconcileAt" TIMESTAMPTZ
      );

      ALTER TABLE "Message"  ADD COLUMN IF NOT EXISTS "skip"            BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE "Message"  ADD COLUMN IF NOT EXISTS "claimedAt"       TIMESTAMPTZ;
      ALTER TABLE "Message"  ADD COLUMN IF NOT EXISTS "approvalTs"      TEXT;
      ALTER TABLE "AppState" ADD COLUMN IF NOT EXISTS "scanCursor"      TEXT;
      ALTER TABLE "AppState" ADD COLUMN IF NOT EXISTS "lastReconcileAt" TIMESTAMPTZ;

      INSERT INTO "AppState" ("id") VALUES (1) ON CONFLICT DO NOTHING;

      CREATE INDEX IF NOT EXISTS "Message_channelId_idx" ON "Message" ("channelId");
    `);

    // Carry the old rotation cursor over, then retire the column.
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'AppState' AND column_name = 'lastSyncedTs') THEN
          UPDATE "AppState" SET "scanCursor" = COALESCE("scanCursor", "lastSyncedTs") WHERE id = 1;
          ALTER TABLE "AppState" DROP COLUMN "lastSyncedTs";
        END IF;
      END $$;
    `);

    // The `announce` flag is deliberately NOT carried over to `skip`.
    //
    // It was written by five different code paths with three different
    // meanings, and on unposted rows it meant "held back for good" — which is
    // the bug this rewrite exists to remove. Noticing that a message had been
    // missed was itself what disqualified it from ever being announced, so
    // every outage permanently retired the backlog it created (221 qualifying
    // rows, at last count). Carrying those over as `skip` would preserve
    // exactly that damage against the live handler, where an organic new star
    // on an old message is a legitimate entry.
    //
    // `skip` starts false for everyone. What the reconciler may post is now
    // decided by the origin's age (RULES.catchUpWindowHours), re-derived every
    // run, so it cannot be recorded wrongly. `skip` is set only by a
    // deliberate act: `hof skip`, or an admin deleting an announcement.
    await client.query("ALTER TABLE \"Message\" DROP COLUMN IF EXISTS \"announce\"");
    await client.query(`
      ALTER TABLE "AppState" DROP COLUMN IF EXISTS "statsWindowStart",
                             DROP COLUMN IF EXISTS "starsIncreased",
                             DROP COLUMN IF EXISTS "starsDecreased",
                             DROP COLUMN IF EXISTS "newPosts"
    `);
  } finally {
    client.release();
  }
}

const COLUMNS = "\"messageId\", \"channelId\", stars, \"postedMessageId\", skip, \"approvalTs\"";

export async function getMessage(messageId: string): Promise<MessageRow | undefined> {
  const rows = await query<MessageRow>(`SELECT ${COLUMNS} FROM "Message" WHERE "messageId" = $1`, [messageId]);
  return rows[0];
}

// Records the live star count, creating the row if this is the first star we
// have seen on the message. One statement rather than a find-then-create-or-
// update: the old handler returned early after creating a row, so the first
// star event ever recorded for a message could never announce it — a message
// that went from 0 to 5 stars while the bot was up still needed a sixth.
export async function recordStars(messageId: string, channelId: string, stars: number): Promise<MessageRow> {
  const rows = await query<MessageRow>(
    `INSERT INTO "Message" ("messageId", "channelId", stars) VALUES ($1, $2, $3)
     ON CONFLICT ("messageId") DO UPDATE SET stars = EXCLUDED.stars, "channelId" = EXCLUDED."channelId"
     RETURNING ${COLUMNS}`,
    [messageId, channelId, stars]
  );
  return rows[0];
}

// Which origin an announcement belongs to. Used when an announcement is
// deleted in #hall-of-fame and all we have is its own timestamp.
export async function getByPostedId(postedMessageId: string): Promise<MessageRow | undefined> {
  const rows = await query<MessageRow>(`SELECT ${COLUMNS} FROM "Message" WHERE "postedMessageId" = $1`, [
    postedMessageId,
  ]);
  return rows[0];
}

export async function setStars(messageId: string, stars: number): Promise<void> {
  await query("UPDATE \"Message\" SET stars = $2 WHERE \"messageId\" = $1", [messageId, stars]);
}

export async function setSkip(messageId: string, skip: boolean): Promise<number> {
  const res = await db().query("UPDATE \"Message\" SET skip = $2 WHERE \"messageId\" = $1", [messageId, skip]);
  return res.rowCount ?? 0;
}

// Reserves the right to post this message's announcement, returning false if
// someone else already holds it. Without this, two star events arriving on the
// same message at once both read postedMessageId as empty and both post — the
// channel already contains 362 duplicate announcements. A claim left behind by
// a process that died mid-post expires on its own.
export async function claimForPost(messageId: string, ttlMs: number): Promise<boolean> {
  const res = await db().query(
    `UPDATE "Message" SET "claimedAt" = now()
     WHERE "messageId" = $1 AND ${NOT_POSTED}
       AND ("claimedAt" IS NULL OR "claimedAt" < now() - ($2::int * interval '1 millisecond'))`,
    [messageId, ttlMs]
  );
  return (res.rowCount ?? 0) > 0;
}

export async function releaseClaim(messageId: string): Promise<void> {
  await query("UPDATE \"Message\" SET \"claimedAt\" = NULL WHERE \"messageId\" = $1", [messageId]);
}

// Records the announcement and releases the claim in the same statement, so a
// posted message can never be left looking unposted.
export async function setPosted(messageId: string, postedMessageId: string): Promise<void> {
  await query("UPDATE \"Message\" SET \"postedMessageId\" = $2, \"claimedAt\" = NULL WHERE \"messageId\" = $1", [
    messageId,
    postedMessageId,
  ]);
}

export async function clearPosted(messageId: string): Promise<void> {
  await query("UPDATE \"Message\" SET \"postedMessageId\" = NULL, \"claimedAt\" = NULL WHERE \"messageId\" = $1", [messageId]);
}

export async function deleteMessage(messageId: string): Promise<void> {
  await query("DELETE FROM \"Message\" WHERE \"messageId\" = $1", [messageId]);
}

// How many announcements this channel has had inside the burst window. The
// timestamp comparison is numeric on the Slack ts — the old handler read the
// ts as milliseconds instead of seconds, putting every comparison in January
// 1970, so the 3-per-channel limit never actually fired once.
export async function postsInChannelSince(channelId: string, sinceSeconds: number): Promise<number> {
  const rows = await query<{ count: string }>(
    `SELECT count(*) FROM "Message"
     WHERE "channelId" = $1 AND ${POSTED} AND "postedMessageId"::numeric >= $2`,
    [channelId, sinceSeconds]
  );
  return Number(rows[0]?.count ?? 0);
}

// How many announcements went into #hall-of-fame in the window, from any origin.
// The global pace limit — counted on the announcement's own timestamp, so the age
// of the starred message is irrelevant.
export async function postsSince(sinceSeconds: number): Promise<number> {
  const rows = await query<{ count: string }>(
    `SELECT count(*) FROM "Message" WHERE ${POSTED} AND "postedMessageId"::numeric >= $1`,
    [sinceSeconds]
  );
  return Number(rows[0]?.count ?? 0);
}

export async function setApprovalTs(messageId: string, approvalTs: string | null): Promise<void> {
  await query("UPDATE \"Message\" SET \"approvalTs\" = $2 WHERE \"messageId\" = $1", [messageId, approvalTs]);
}

// Outstanding approval requests: asked for, not yet decided. A decision clears
// approvalTs, whichever way it went.
export async function pendingApprovals(): Promise<number> {
  const rows = await query<{ count: string }>(
    `SELECT count(*) FROM "Message" WHERE "approvalTs" IS NOT NULL AND ${NOT_POSTED}`
  );
  return Number(rows[0]?.count ?? 0);
}

export async function postedRows(): Promise<MessageRow[]> {
  return query<MessageRow>(`SELECT ${COLUMNS} FROM "Message" WHERE ${POSTED}`);
}

export async function unpostedRows(): Promise<MessageRow[]> {
  return query<MessageRow>(`SELECT ${COLUMNS} FROM "Message" WHERE ${NOT_POSTED}`);
}

export async function rowsInChannel(channelId: string): Promise<MessageRow[]> {
  return query<MessageRow>(`SELECT ${COLUMNS} FROM "Message" WHERE "channelId" = $1`, [channelId]);
}

// Records an announcement that exists in #hall-of-fame but has no row (or lost
// its link to one). These are already posted, so recording them is what stops
// the reconciler treating them as never-announced and posting them a second
// time — the single largest source of duplicates in the channel's history.
export async function recordAnnounced(
  originTs: string,
  channelId: string,
  stars: number,
  postedMessageId: string
): Promise<void> {
  await query(
    `INSERT INTO "Message" ("messageId", "channelId", stars, "postedMessageId")
     VALUES ($1, $2, $3, $4)
     ON CONFLICT ("messageId") DO UPDATE SET
       "channelId" = EXCLUDED."channelId",
       stars = EXCLUDED.stars,
       "postedMessageId" = EXCLUDED."postedMessageId"`,
    [originTs, channelId, stars, postedMessageId]
  );
}

export async function getState(): Promise<StateRow> {
  const rows = await query<StateRow>("SELECT \"scanCursor\", \"lastReconcileAt\" FROM \"AppState\" WHERE id = 1");
  return rows[0] ?? { scanCursor: null, lastReconcileAt: null };
}

export async function setScanCursor(cursor: string): Promise<void> {
  await query("UPDATE \"AppState\" SET \"scanCursor\" = $1 WHERE id = 1", [cursor]);
}

export async function markReconciled(): Promise<void> {
  await query("UPDATE \"AppState\" SET \"lastReconcileAt\" = now() WHERE id = 1");
}

export interface Counts {
  tracked: number;
  posted: number;
  unposted: number;
  skipped: number;
  atThreshold: number;
}

export async function counts(threshold: number): Promise<Counts> {
  const rows = await query<Record<string, string>>(
    `SELECT count(*) AS tracked,
            count(*) FILTER (WHERE ${POSTED}) AS posted,
            count(*) FILTER (WHERE ${NOT_POSTED}) AS unposted,
            count(*) FILTER (WHERE skip) AS skipped,
            count(*) FILTER (WHERE ${NOT_POSTED} AND NOT skip AND stars >= $1) AS "atThreshold"
     FROM "Message"`,
    [threshold]
  );
  const row = rows[0] ?? {};
  return {
    tracked: Number(row.tracked ?? 0),
    posted: Number(row.posted ?? 0),
    unposted: Number(row.unposted ?? 0),
    skipped: Number(row.skipped ?? 0),
    atThreshold: Number(row.atThreshold ?? 0),
  };
}

export async function ping(): Promise<boolean> {
  try {
    await query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}
