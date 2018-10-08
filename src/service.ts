import { Api } from '@geeebe/api';
import { Statuses } from '@geeebe/common';
import { logger } from '@geeebe/logging';
import Validator from 'better-validator';
import { Koa2Middleware } from 'better-validator/src/middleware/Koa2Middleware';
import * as Koa from 'koa';
import { Middleware } from 'koa';
import Router = require('koa-router');
import { collectDefaultMetrics, register, Summary } from 'prom-client';
import 'reflect-metadata';

const bodyParser = require('koa-bodyparser');
const compress = require('koa-compress');
const conditional = require('koa-conditional-get');
const etag = require('koa-etag');
const koaLogger = require('koa-logger');
const serveStatic = require('koa-static');

const EXIT_ERROR = 1;
const DEFAULT_OPTIONS = {
  port: 80,
};

const log = logger.child({ module: 'common:service' });

collectDefaultMetrics();

const responseSummary = new Summary({
  help: 'Response timing',
  labelNames: ['method', 'route', 'status'],
  name: 'response',
});

export interface Service {
  start(): void;
}

export interface MonitorRequest {
  duration: number;
  method: string;
  path: string;
  route: string;
  status: number;
}

export type Monitor = (details: MonitorRequest) => void;

export interface ServiceOptions {
  port: number | string; // server port
  staticPath?: string; // directory from which to serve static files
  useLogger?: boolean; // include koa logger
  disableCache?: boolean;
  monitor?: Monitor;
  isAlive?: () => Promise<boolean>;
  isReady?: () => Promise<boolean>;
  omitMonitoringEndpoints?: boolean;
}

const WrapperFormatter = Validator.format.response.WrapperFormatter;
const FailureFormatter = Validator.format.failure.FailureFormatter;

export const validatorMiddleware: Koa2Middleware = Validator.koa2Middleware({
  failureFormatter: new FailureFormatter({}),
  responseFormatter: new WrapperFormatter({}),
});

//noinspection JSUnusedGlobalSymbols
export abstract class KoaService<TOptions extends ServiceOptions> extends Koa implements Service {

  /**
   * Returns error formatting middleware
   */
  private static errorMiddleware(): Middleware {
    return async (ctx: Router.IRouterContext, next) => {
      try {
        await next();

        if (ctx.status === Statuses.NOT_FOUND) {
          ctx.body = { error: { type: 'NotFoundError', message: 'Not Found' } };
          ctx.status = Statuses.NOT_FOUND;
        }
      } catch (err) {
        Api.formatError(ctx, err);
      }
    };
  }

  /**
   * Renders monitoring metrics for Prometheus
   */
  private static async prometheusMetricsEndpoint(ctx: Router.IRouterContext): Promise<void> {
    ctx.type = register.contentType;
    ctx.body = register.metrics();
  }

  public readonly options: TOptions;

  /**
   * Create Koa app
   * @param options
   */
  constructor(options: TOptions) {
    super();

    this.options = Object.assign({}, DEFAULT_OPTIONS, options);

    // use a real logger in production
    // hide the logger during tests because it's annoying
    if (this.env !== 'production' && this.env !== 'test' && this.options.useLogger !== false) {
      this.use(koaLogger());
    }

    this.use(this.monitorMiddleware());
    this.use(KoaService.errorMiddleware());
    this.use(this.securityHeaderMiddleware());
    this.use(conditional());
    this.use(etag());
    this.use(compress());
    if (this.options.staticPath) {
      log(`Serving static content from ${this.options.staticPath}`);
      this.use(serveStatic(this.options.staticPath));
    }
    this.use(bodyParser());

    this.on('error', this.onError);
  }

  //noinspection JSUnusedGlobalSymbols
  /**
   * Start the app
   */
  public start(): void {
    const router = new Router();
    if (!this.options.omitMonitoringEndpoints) {
      router.get('/alive', this.livenessEndpoint());
      router.get('/metrics', KoaService.prometheusMetricsEndpoint);
      router.get('/ready', this.readinessEndpoint());
    }
    this.mountApi(router);

    this.use(router.routes());
    this.use(router.allowedMethods());

    // start server
    this.startServer();
  }

  protected monitorMiddleware(): Middleware {
    const middleware = async (ctx: Router.IRouterContext, next: () => Promise<any>): Promise<void> => {
      const started = Date.now();

      await next();

      const duration = Date.now() - started;
      try {
        if (['/alive', '/metrics', '/ready'].includes(ctx.path)) {
          responseSummary.observe({
            method: ctx.method,
            route: (ctx as any)._matchedRoute,
            status: String(ctx.status),
          }, duration);
        }

        if (!this.options.monitor) return;
        await this.options.monitor({
          duration,
          method: ctx.method,
          path: ctx.path,
          route: (ctx as any)._matchedRoute,
          status: ctx.status,
        });
      } catch (err) {
        log.error(err);
      }
    };
    return middleware.bind(this);
  }

  /**
   * Adds headers for additional security
   */
  protected securityHeaderMiddleware(): Middleware {
    const middleware = async (ctx: Router.IRouterContext, next: () => Promise<any>): Promise<void> => {
      await next();

      ctx.set('X-Frame-Options', 'DENY');
      ctx.set('X-XSS-Protection', '1; mode=block');
      ctx.set('X-Content-Type-Options', 'nosniff');

      const cacheablePath = /\/(node_modules|scripts)\//.test(ctx.path);
      const cacheableExtension = ctx.path.endsWith('.js') || ctx.path.endsWith('.css') || ctx.path.endsWith('.html');
      if (!this.options.disableCache && cacheablePath && cacheableExtension) {
        ctx.set('Cache-Control', 'max-age=3600');
      } else {
        ctx.set('Cache-Control', 'max-age=0');
        ctx.set('Pragma', 'no-cache');
      }
    };
    return middleware.bind(this);
  }

  /**
   * Override to mount API routes
   */
  protected abstract mountApi(router: Router): void;

  /**
   * Start the web server
   */
  protected startServer(): void {
    this.listen(this.options.port, () => {
      log(`HTTP started on http://localhost:${this.options.port}/`);
    });
  }

  /**
   * Handle Koa app errors
   */
  private onError(error: any): void | never {
    log.error(error);
    if (error.syscall !== 'listen') {
      throw error;
    }

    const bind = typeof this.options.port === 'string'
      ? `Pipe ${this.options.port}`
      : `Port ${this.options.port}`;

    // handle specific listen errors with friendly messages
    switch (error.code) {
      case 'EACCES':
        console.error(`${bind} requires elevated privileges`);
        process.exit(EXIT_ERROR); // eslint-disable-line no-process-exit
        break;
      case 'EADDRINUSE':
        console.error(`${bind} is already in use`);
        process.exit(EXIT_ERROR); // eslint-disable-line no-process-exit
        break;
      default:
        throw error;
    }
  }

  private livenessEndpoint() {
    const endpoint = async (ctx: Router.IRouterContext): Promise<void> => {
      let alive;
      try {
        alive = this.options.isAlive ? await this.options.isAlive() : true;
      } catch (err) {
        alive = false;
      }
      ctx.body = { alive };
      if (alive) {
        ctx.status = Statuses.SERVICE_UNAVAILABLE;
        ctx.response.headers['Retry-After'] = 30;
      }
    };
    return endpoint.bind(this);
  }

  private readinessEndpoint() {
    const endpoint = async (ctx: Router.IRouterContext): Promise<void> => {
      let ready;
      try {
        ready = this.options.isReady ? await this.options.isReady() : true;
      } catch (err) {
        ready = false;
      }
      ctx.body = { ready };
      if (ready) {
        ctx.status = Statuses.SERVICE_UNAVAILABLE;
        ctx.response.headers['Retry-After'] = 30;
      }
    };
    return endpoint.bind(this);
  }
}
