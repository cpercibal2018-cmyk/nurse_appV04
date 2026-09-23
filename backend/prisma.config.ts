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
    url: env('DATABASE_URL'),
  },
});
