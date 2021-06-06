import { Duration } from '@geeebe/common';
import { logger } from '@geeebe/logging';
import { Service } from './service';

const log = logger.child({ module: 'service:shutdown' });

const run = (fn: (() => unknown | Promise<unknown>) | undefined, done: () => unknown): void => {
  if (!fn) {
    done();
    return;
  }
  Promise.all([fn()]).finally(done);
};

/**
 * Enable graceful shutdown triggered by SIGINT or SIGTERM
 * @param grace grace period in milliseconds before forcing shutdown
 * @param prepare callback to start shutdown
 * @param finish callback to force shutdown after grace period has expired
 */
export const graceful = (grace: Duration, prepare?: () => unknown | Promise<unknown>, finish?: () => unknown | Promise<unknown>): { shuttingDown: boolean } => {
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

  /**
   * Log and shutdown on uncaught exceptions
   */
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
};

export type ServiceFactory = (isReady: () => boolean) => Service;

export class Graceful implements Service {
  static service(grace: Duration, factory: ServiceFactory): Promise<unknown> {
    const service = new Graceful(grace, factory);
    return service.start();
  }

  private readonly service: Service;

  private running = false;

  private constructor(grace: Duration, factory: ServiceFactory) {
    this.service = factory(this.isReady);
    graceful(
      grace,
      () => this.service.stop(),
      () => this.service.dispose(),
    );
  }

  isReady(): boolean {
    return this.running;
  }

  start(): Promise<unknown> {
    this.running = true;
    return this.service.start();
  }

  stop(): Promise<unknown> {
    this.running = false;
    return this.service.stop();
  }

  dispose(): Promise<unknown> {
    return this.service.dispose();
  }
}
