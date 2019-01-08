import { Duration } from '@geeebe/common';
import { logger } from '@geeebe/logging';

const log = logger.child({ module: 'service:shutdown' });

export function graceful(grace: Duration, callback?: () => void) {
  const status = { shuttingDown: false };

  // signal handlers
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGQUIT'];
  signals.forEach((signal: NodeJS.Signals) => {
    process.once(signal, () => {
      log(`Signal ${signal} received - shutting down`);
      status.shuttingDown = true;
      setTimeout(() => {
        callback ? callback() : process.exit(0);
      }, grace);
    });
  });

  // unhandled exceptions
  process.once('uncaughtException', (err) => {
    log.error(err);
    status.shuttingDown = true;
    callback ? callback() : process.exit(0);
  });

  return status;
}
