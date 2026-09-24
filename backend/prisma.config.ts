import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    // No seed: hospital data enters through the bootstrap and the baseline import
    // (docs/DATABASE_ARCHITECTURE.md §7), never through `prisma db seed`.
    path: 'prisma/migrations',
  },
  datasource: {
    // Migrations connect as the migration role when it is configured
    // (ops/db/README.md); the API and worker always use DATABASE_URL.
    url: process.env.MIGRATION_DATABASE_URL || env('DATABASE_URL'),
  },
});
