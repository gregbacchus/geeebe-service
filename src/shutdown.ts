import { Duration } from '@geeebe/common';
import { logger } from '@geeebe/logging';
import { Service } from './service';

const log = logger.child({ module: 'service:shutdown' });

function run(fn: (() => any | Promise<any>) | undefined, done: () => any): void {
  if (!fn) {
    done();
    return;
  }
  Promise.all([fn()]).finally(done);
}

/**
 * Enable graceful shutdown triggered by SIGINT or SIGTERM
 * @param grace grace period in milliseconds before forcing shutdown
 * @param prepare callback to start shutdown
 * @param finish callback to force shutdown after grace period has expired
 */
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
}

export type ServiceFactory = (isReady: () => boolean) => Service;

export class Graceful implements Service {
  public static service(grace: Duration, factory: ServiceFactory): Promise<void> {
    const service = new Graceful(grace, factory);
    return service.start();
  }

  private readonly service: Service;

  private running = false;

  private constructor(grace: Duration, factory: ServiceFactory) {
    this.service = factory(this.isReady);
    graceful(
      grace,
      () => this.service.shutdown(),
      () => this.service.destroy(),
    );
  }

  public isReady = (): boolean => this.running;

  public start = (): Promise<void> => {
    this.running = true;
    return this.service.start();
  }

  public shutdown = (): Promise<void> => {
    this.running = false;
    return this.service.shutdown();
  }

  public destroy = (): Promise<void> => this.service.destroy();
}
