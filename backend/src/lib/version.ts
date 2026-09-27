// The application version, read from backend/package.json so it is stated in
// one place. src/ and dist/ sit at the same depth (tsconfig.build.json rootDir),
// and the runtime image keeps backend/package.json beside dist/.

import { readFileSync } from 'node:fs';

export const APP_VERSION: string = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
