import { logger, Logger } from '@geeebe/logging';
import * as Router from '@koa/router';
import * as Koa from 'koa';
import { Server } from 'net';
import 'reflect-metadata';
import { onError } from './error';
import { errorMiddleware, livenessEndpoint, readinessEndpoint } from './middleware';
import { prometheusMetricsEndpoint } from './prometheus';
import { Service } from './service';

export interface MonitorServiceOptions {
  isAlive?: () => Promise<boolean>;
  isReady?: () => Promise<boolean>;
  logger?: Logger;
  port: number | string; // server port
}

export class MonitorService<TOptions extends MonitorServiceOptions = MonitorServiceOptions> extends Koa implements Service {
  public readonly logger: Logger;

  private server: Server | undefined;

  /**
   * Create Koa app
   * @param options
   */
  constructor(public readonly options: TOptions) {
    super();

    this.logger = this.options.logger || logger;
    this.use(errorMiddleware());

    this.on('error', onError(this.options.port, this.logger));
  }

  public start(): Promise<void> {
    if (this.server) throw new Error('Already started');

    const router = new Router();
    router.get('/alive', livenessEndpoint(this.options.isAlive));
    router.get('/metrics', prometheusMetricsEndpoint());
    router.get('/ready', readinessEndpoint(this.options.isReady));

    this.use(router.routes());
    this.use(router.allowedMethods());

    // start server
    return new Promise((resolve, reject) => {
      if (this.server) return reject(new Error('Already started'));
      this.server = this.listen(this.options.port, () => {
        this.logger(`Monitoring started on http://localhost:${this.options.port}/`);
        resolve();
      });
    });
  }

  public shutdown(): Promise<void> {
    return Promise.resolve();
  }

  public destroy(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this.server) return resolve();

      this.server.close((err) => {
        if (err) {
          return reject(err);
        }
        this.server = undefined;
        resolve();
      });
    });
  }
}
