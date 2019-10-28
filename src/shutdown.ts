import { Duration } from '@geeebe/common';
import { logger } from '@geeebe/logging';

const log = logger.child({ module: 'service:shutdown' });

function run(fn: (() => any | Promise<any>) | undefined, done: () => any): void {
  if (!fn) {
    done();
    return;
  }
  Promise.all([fn()]).finally(done);
}

export function graceful(grace: Duration, prepare?: () => any | Promise<any>, finish?: () => any | Promise<any>) {
  const status = { shuttingDown: false };

  // signal handlers
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGQUIT'];
  signals.forEach((signal: NodeJS.Signals) => {
    process.once(signal, () => {
      log(`Signal ${signal} received - shutting down`);
      status.shuttingDown = true;
      run(prepare, () => {
        setTimeout(() => {
          run(finish, () => {
            process.exit(0);
          });
        }, grace);
      });
    });
  });

  // unhandled exceptions
  process.once('uncaughtException', (err) => {
    log.error(err);
    status.shuttingDown = true;
    run(prepare, () => {
      run(finish, () => {
        process.exit(0);
      });
    });
  });

  return status;
}
