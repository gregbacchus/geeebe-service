import { logger, Logger } from '@geeebe/logging';
import * as Router from '@koa/router';
import Validator from 'better-validator';
import { Koa2Middleware } from 'better-validator/src/middleware/Koa2Middleware';
import * as Koa from 'koa';
import { DefaultContext, DefaultState } from 'koa';
import * as helmet from 'koa-helmet';
import * as koaOpentracing from 'koa-opentracing';
import { Server } from 'net';
import { collectDefaultMetrics } from 'prom-client';
import 'reflect-metadata';
import { onError } from './error';
import { DEFAULT_HELMET_OPTIONS, HelmetOptions } from './helmet';
import { errorMiddleware, Monitor, observeMiddleware } from './middleware';
import { Service } from './service';

import bodyParser = require('koa-bodyparser');
import compress = require('koa-compress');
import conditional = require('koa-conditional-get');
import etag = require('koa-etag');
import serveStatic = require('koa-static');

const DEFAULT_OPTIONS = {
  helmetOptions: DEFAULT_HELMET_OPTIONS,
  observe: true,
  port: 80,
  serviceName: 'service',
};

if (process.env.JEST_WORKER_ID === undefined) {
  collectDefaultMetrics();
}

export interface ServiceOptions {
  helmetOptions?: HelmetOptions;
  isAlive?: () => Promise<boolean>;
  isReady?: () => Promise<boolean>;
  logger?: Logger;
  loggerIgnorePath?: RegExp;
  monitor?: Monitor;
  observe?: boolean;
  port: number | string; // server port
  serviceName?: string; // name of service, used for tracing
  staticPath?: string; // directory from which to serve static files
  useLogger?: boolean; // include koa logger
}

const WrapperFormatter = Validator.format.response.WrapperFormatter;
const FailureFormatter = Validator.format.failure.FailureFormatter;

export const validatorMiddleware: Koa2Middleware = Validator.koa2Middleware({
  failureFormatter: new FailureFormatter({}),
  responseFormatter: new WrapperFormatter({}),
});

// noinspection JSUnusedGlobalSymbols
export abstract class KoaService<TOptions extends ServiceOptions = ServiceOptions, StateT extends DefaultState = DefaultState, CustomT extends DefaultContext = DefaultContext> extends Koa<StateT, CustomT> implements Service {
  readonly options: TOptions;

  readonly logger: Logger;

  private server: Server | undefined;

  /**
   * Create Koa app
   * @param options
   */
  constructor(options: TOptions) {
    super();

    this.options = {
      ...DEFAULT_OPTIONS,
      ...options,
    };
    this.logger = this.options.logger || logger;

    koaOpentracing(this as unknown as Koa, {
      appname: this.options.serviceName || DEFAULT_OPTIONS.serviceName,
      carrier: {
        'http-header': {
          extract(header: { [key: string]: string }): koaOpentracing.spanContextCarrier {
            const traceId = String(header['x-request-id']).substr(0, 32);
            const spanId = String(header['x-request-id']).substr(32, 16);
            return { traceId, spanId };
          },
          inject(spanContext: koaOpentracing.SpanContext): any {
            const { traceId, spanId } = spanContext as unknown as { [key: string]: string };
            return { 'x-request-id': traceId + spanId };
          },
        },
      },
      httpCarrier: null,
    });

    if (this.options.observe) {
      this.use(observeMiddleware(this.logger, this.options));
    }
    this.use(errorMiddleware());
    if (this.options.helmetOptions) {
      this.use(helmet(this.options.helmetOptions));
    }
    this.use(conditional());
    this.use(etag());
    this.use(compress());
    if (this.options.staticPath) {
      this.logger(`Serving static content from ${this.options.staticPath}`);
      this.use(serveStatic(this.options.staticPath));
    }
    this.use(bodyParser());

    this.on('error', onError(this.options.port, this.logger));
  }

  /**
   * Start the app
   */
  start(): Promise<void> {
    const router = new Router();
    this.mountApi(router);

    this.use(router.routes());
    this.use(router.allowedMethods());

    // start server
    return this.startServer();
  }

  stop(): Promise<void> {
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

  dispose(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Start the web server
   */
  private startServer = (): Promise<void> => new Promise<void>((resolve, reject) => {
    if (this.server) return reject(new Error('Already started'));
    this.server = this.listen(this.options.port, () => {
      this.logger(`HTTP started on http://localhost:${this.options.port}/`);
      resolve();
    });
  })

  /**
   * Override to mount API routes
   */
  protected abstract mountApi(router: Router): void;
}
