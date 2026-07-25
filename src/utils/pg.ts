import { Client } from "pg";

// Raw pg connection, used instead of the shared Prisma client for the
// background jobs (src/jobs/*.ts) specifically. Prisma's query engine has
// been unable to open a TLS connection to this Postgres instance in every
// environment tested so far, while plain pg/libpq connects reliably — so the
// jobs responsible for reliability/alerting shouldn't depend on the one DB
// client known to be unreliable against this server.
export async function withPgClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const dbUrl = new URL(process.env.DATABASE_URL as string);
  dbUrl.search = "";
  const client = new Client({ connectionString: dbUrl.toString(), ssl: { rejectUnauthorized: true } });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}
