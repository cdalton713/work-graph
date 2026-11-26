import { createVercelApp } from "../server/vercel.ts";

import { startSentry } from "../server/sentry.ts";

if (process.env.WG_SENTRY_DSN) await startSentry(process.env);

export default createVercelApp(process.env).entry;
