import * as Sentry from '@sentry/node';
import { config } from './config.js';

if (config.sentryDsn) Sentry.init({ dsn: config.sentryDsn, environment: config.env });

const { buildApp } = await import('./app.js');
const app = await buildApp();

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    app.log.info({ sig }, 'shutting down');
    await app.close();
    await Sentry.close(2000);
    process.exit(0);
  });
}

try {
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
