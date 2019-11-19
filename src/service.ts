import { HrTime, Statuses } from '@geeebe/common';
import { logger, Logger, WithLogger } from '@geeebe/logging';
import Validator from 'better-validator';
import { Koa2Middleware } from 'better-validator/src/middleware/Koa2Middleware';
import * as Koa from 'koa';
import { Middleware } from 'koa';
import * as koaOpentracing from 'koa-opentracing';
import * as Router from 'koa-router';
import { RouterContext } from 'koa-router';
import { Server } from 'net';
import * as Opentracing from 'opentracing';
import { collectDefaultMetrics, register, Summary } from 'prom-client';
import 'reflect-metadata';
import { formatError } from './error';

const bodyParser = require('koa-bodyparser');
const compress = require('koa-compress');
const conditional = require('koa-conditional-get');
const etag = require('koa-etag');
const serveStatic = require('koa-static');

const EXIT_ERROR = 1;
const DEFAULT_OPTIONS = {
  observe: true,
  omitMonitoringEndpoints: false,
  port: 80,
  serviceName: 'service',
};

if (process.env.JEST_WORKER_ID === undefined) {
  collectDefaultMetrics();
}

const MONITORING_ENDPOINTS = ['/alive', '/metrics', '/ready'];

const responseSummary = new Summary({
  help: 'Response timing (seconds)',
  labelNames: ['method', 'route', 'status'],
  name: 'http_response',
});

export interface Service {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface MonitorRequest {
  duration: number;
  method: string;
  path: string;
  status: number;
}

interface WithTracer {
  tracer: Opentracing.Tracer;
}

export interface WithSpan {
  span: Opentracing.Span;
}

type ServiceContext = RouterContext & WithLogger & WithTracer & WithSpan;

export type Monitor = (details: MonitorRequest) => void;

export interface ServiceOptions {
  disableCache?: boolean;
  isAlive?: () => Promise<boolean>;
  isReady?: () => Promise<boolean>;
  logger?: Logger;
  monitor?: Monitor;
  observe?: boolean;
  omitMonitoringEndpoints?: boolean;
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

function ignorePaths(paths: string[], middleware: Middleware): Middleware {
  // tslint:disable-next-line: space-before-function-paren
  return async function (ctx: RouterContext, next) {
    if (paths.includes(ctx.path)) {
      await next();
    } else {
      // must .call() to explicitly set the receiver
      await middleware.call(this, ctx, next);
    }
  };
}

//noinspection JSUnusedGlobalSymbols
export abstract class KoaService<TOptions extends ServiceOptions> extends Koa implements Service {

  /**
   * Returns error formatting middleware
   */
  private static errorMiddleware(): Middleware {
    return async (ctx: RouterContext, next) => {
      try {
        await next();

        if (ctx.status === Statuses.NOT_FOUND) {
          ctx.body = { error: { type: 'NotFoundError', message: 'Not Found' } };
          ctx.status = Statuses.NOT_FOUND;
        }
      } catch (err) {
        formatError(ctx, err);
      }
    };
  }

  /**
   * Renders monitoring metrics for Prometheus
   */
  private static async prometheusMetricsEndpoint(ctx: RouterContext): Promise<void> {
    ctx.type = register.contentType;
    ctx.body = register.metrics();
  }

  public readonly options: TOptions;

  public readonly logger: Logger;

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

    koaOpentracing(this, {
      appname: this.options.serviceName || DEFAULT_OPTIONS.serviceName,
      carrier: {
        'http-header': {
          extract(header: any) {
            const traceId = String(header['x-request-id']).substr(0, 32);
            const spanId = String(header['x-request-id']).substr(32, 16);
            return { traceId, spanId };
          },
          inject(spanContext: any): any {
            return { 'x-request-id': spanContext.traceId + spanContext.spanId };
          },
        },
      },
      httpCarrier: null,
    });

    if (this.options.observe) {
      this.use(ignorePaths(
        MONITORING_ENDPOINTS,
        this.observeMiddleware(),
      ));
    }
    this.use(KoaService.errorMiddleware());
    this.use(this.securityHeaderMiddleware());
    this.use(conditional());
    this.use(etag());
    this.use(compress());
    if (this.options.staticPath) {
      this.logger(`Serving static content from ${this.options.staticPath}`);
      this.use(serveStatic(this.options.staticPath));
    }
    this.use(bodyParser());

    this.on('error', this.onError);
  }

  //noinspection JSUnusedGlobalSymbols
  /**
   * Start the app
   */
  public start(): Promise<void> {
    if (this.server) throw new Error('Already started');

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
    return this.startServer();
  }

  public stop(): Promise<void> {
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

  protected observeMiddleware(): Middleware {
    const middleware = async (ctx: ServiceContext, next: () => Promise<any>): Promise<void> => {
      const started = process.hrtime();

      const spanContext = ctx.tracer.extract('http-header', ctx.request.headers) || undefined;
      const span = ctx.span = ctx.tracer.startSpan(ctx.path, {
        childOf: spanContext,
        startTime: HrTime.toMs(started),
      });
      const { spanId, traceId } = span.context() as any;

      ctx.logger = this.logger.child({
        host: ctx.host,
        ip: ctx.ip,
        method: ctx.method,
        path: ctx.request.url,
        spanId,
        traceId,
      });

      if (this.options.useLogger !== false) {
        ctx.logger('<--');
      }
      await next();

      const duration = process.hrtime(started);
      const durationMs = HrTime.toMs(duration);
      span.finish(HrTime.toMs(started) + durationMs);
      try {
        responseSummary.observe({
          method: ctx.method,
          status: String(ctx.status),
        }, HrTime.toSeconds(duration));

        this.options.monitor && this.options.monitor({
          duration: durationMs,
          method: ctx.method,
          path: ctx.path,
          status: ctx.status,
        });
        if (this.options.useLogger !== false) {
          ctx.logger('-->', { duration: durationMs, status: ctx.status });
        }
      } catch (err) {
        ctx.logger.error(err);
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

      const cacheableExtension = ctx.path.endsWith('.js') || ctx.path.endsWith('.css') || ctx.path.endsWith('.html');
      if (!this.options.disableCache && cacheableExtension) {
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
  protected startServer(): Promise<void> {
    return new Promise((resolve) => {
      this.server = this.listen(this.options.port, () => {
        this.logger(`HTTP started on http://localhost:${this.options.port}/`);
        resolve();
      });
    });
  }

  /**
   * Handle Koa app errors
   */
  private onError(error: any): void | never {
    this.logger.error(error);
    if (error.syscall !== 'listen') {
      return;
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
    const endpoint = async (ctx: RouterContext): Promise<void> => {
      let alive;
      try {
        alive = this.options.isAlive ? await this.options.isAlive() : true;
      } catch (err) {
        alive = false;
      }
      ctx.body = { alive };
      if (!alive) {
        ctx.status = Statuses.SERVICE_UNAVAILABLE;
        ctx.response.headers['Retry-After'] = 30;
      }
    };
    return endpoint.bind(this);
  }

  private readinessEndpoint() {
    const endpoint = async (ctx: RouterContext): Promise<void> => {
      let ready;
      try {
        ready = this.options.isReady ? await this.options.isReady() : true;
      } catch (err) {
        ready = false;
      }
      ctx.body = { ready };
      if (!ready) {
        ctx.status = Statuses.SERVICE_UNAVAILABLE;
        ctx.response.headers['Retry-After'] = 30;
      }
    };
    return endpoint.bind(this);
  }
}
