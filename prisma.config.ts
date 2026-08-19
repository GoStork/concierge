import 'dotenv/config';

// The CLI (migrate deploy / db push / studio) must use a DIRECT (session)
// connection: through the pgbouncer transaction pooler (DATABASE_URL, :6543,
// ?pgbouncer=true) `prisma migrate deploy` hangs on its advisory lock -
// observed 2026-08-19 on the first prod auto-deploy. The runtime client does
// not read this file (server/db.ts builds its own pg Pool from DATABASE_URL).
export default {
  schema: 'prisma/schema.prisma',
  datasource: {
    url: process.env.DIRECT_URL || process.env.DATABASE_URL,
  },
};
