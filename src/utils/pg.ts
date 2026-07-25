import { Client } from "pg";

// The server's TLS cert is issued for the external tier2 hostname, but in
// production DATABASE_URL points at the internal Kubernetes service DNS name
// (a different hostname for the same database) — so strict hostname
// verification against the connection string's own host would always fail.
// Overriding SNI/verification target to the name the cert actually covers
// fixes this without weakening verification: it's still a full chain + name
// check against a real CA-signed cert, just checked against the right name.
const CERT_SERVERNAME = "a.db.tier2.infra.hackclub.com";

// Raw pg connection, used instead of the shared Prisma client for the
// background jobs (src/jobs/*.ts) specifically. Prisma's query engine has
// been unable to open a TLS connection to this Postgres instance in every
// environment tested so far, while plain pg/libpq connects reliably — so the
// jobs responsible for reliability/alerting shouldn't depend on the one DB
// client known to be unreliable against this server.
export async function withPgClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const dbUrl = new URL(process.env.DATABASE_URL as string);
  dbUrl.search = "";
  const client = new Client({
    connectionString: dbUrl.toString(),
    ssl: { rejectUnauthorized: true, servername: CERT_SERVERNAME },
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}
