import { HrTime } from '@geeebe/common';
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
import { collectDefaultMetrics, Summary } from 'prom-client';
import 'reflect-metadata';
import { onError } from './error';
import { errorMiddleware, ignorePaths, livenessEndpoint, noCacheMiddleware, readinessEndpoint, securityHeaderMiddleware } from './middleware';
import { prometheusMetricsEndpoint } from './prometheus';
import { Service } from './service';

const bodyParser = require('koa-bodyparser');
const compress = require('koa-compress');
const conditional = require('koa-conditional-get');
const etag = require('koa-etag');
const serveStatic = require('koa-static');

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
  loggerIgnorePath?: RegExp;
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

//noinspection JSUnusedGlobalSymbols
export abstract class KoaService<TOptions extends ServiceOptions = ServiceOptions> extends Koa implements Service {
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

    koaOpentracing(this as any, {
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
    this.use(errorMiddleware());
    this.use(securityHeaderMiddleware());
    if (this.options.disableCache) {
      this.use(noCacheMiddleware());
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

  //noinspection JSUnusedGlobalSymbols
  /**
   * Start the app
   */
  public start(): Promise<void> {
    if (this.server) throw new Error('Already started');

    const router = new Router();
    if (!this.options.omitMonitoringEndpoints) {
      router.get('/alive', livenessEndpoint(this.options.isAlive));
      router.get('/metrics', prometheusMetricsEndpoint());
      router.get('/ready', readinessEndpoint(this.options.isReady));
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

      if (this.options.useLogger !== false && !this.options.loggerIgnorePath?.test(ctx.request.url)) {
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
        if (this.options.useLogger !== false && !this.options.loggerIgnorePath?.test(ctx.request.url)) {
          ctx.logger('-->', { duration: durationMs, status: ctx.status });
        }
      } catch (err) {
        ctx.logger.error(err);
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
    return new Promise((resolve, reject) => {
      if (this.server) return reject(new Error('Already started'));
      this.server = this.listen(this.options.port, () => {
        this.logger(`HTTP started on http://localhost:${this.options.port}/`);
        resolve();
      });
    });
  }
}
