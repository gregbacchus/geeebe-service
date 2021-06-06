import { HrTime, Statuses } from '@geeebe/common';
import { Logger, WithLogger } from '@geeebe/logging';
import { RouterContext } from '@koa/router';
import { Middleware } from 'koa';
import { Tracer } from 'koa-opentracing';
import { Span } from 'opentracing';
import { Summary } from 'prom-client';
import { formatError } from './error';

const responseSummary = new Summary({
  help: 'Response timing (seconds)',
  labelNames: ['method', 'route', 'status'],
  name: 'http_response',
});

interface WithTracer {
  tracer: Tracer;
}

export interface WithSpan {
  span: Span;
}

type ServiceContext = RouterContext & WithLogger & WithTracer & WithSpan;

export interface MonitorRequest {
  duration: number;
  method: string;
  path: string;
  status: number;
}

export type Monitor = (details: MonitorRequest) => void;

export interface ObserveMiddlewareOptions {
  useLogger?: boolean;
  loggerIgnorePath?: RegExp;
  monitor?: Monitor;
}

/**
 * Returns error formatting middleware
 */
export const errorMiddleware = (): Middleware => async (ctx, next) => {
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

/**
 * Call listed child middleware except for given paths
 * @param paths
 * @param middleware
 */
export const ignorePaths = (paths: string[], middleware: Middleware): Middleware => {
  // tslint:disable-next-line: space-before-function-paren
  return async function (this: any, ctx, next) {
    if (paths.includes(ctx.path)) {
      await next();
    } else {
      // must .call() to explicitly set the receiver
      await middleware.call(this, ctx, next);
    }
  };
};

/**
 * Adds headers for additional security
 */
export const maxCacheMiddleware = (): Middleware => async (ctx, next: () => Promise<any>): Promise<void> => {
  await next();

  ctx.set('Cache-Control', 'immutable');
};

export const livenessEndpoint = (isAlive?: () => Promise<boolean>) => async (ctx: RouterContext): Promise<void> => {
  let alive;
  try {
    alive = isAlive ? await isAlive() : true;
  } catch (err) {
    alive = false;
  }
  ctx.body = { alive };
  if (!alive) {
    ctx.status = Statuses.SERVICE_UNAVAILABLE;
    const headers = ctx.response.headers as Record<string, unknown>;
    headers['Retry-After'] = 30;
  }
};

export const readinessEndpoint = (isReady?: () => Promise<boolean>) => async (ctx: RouterContext): Promise<void> => {
  let ready;
  try {
    ready = isReady ? await isReady() : true;
  } catch (err) {
    ready = false;
  }
  ctx.body = { ready };
  if (!ready) {
    ctx.status = Statuses.SERVICE_UNAVAILABLE;
    const headers = ctx.response.headers as Record<string, unknown>;
    headers['Retry-After'] = 30;
  }
};

export const observeMiddleware = (logger: Logger, options: ObserveMiddlewareOptions): Middleware => {
  const middleware = async (ctx: ServiceContext, next: () => Promise<unknown>): Promise<void> => {
    const started = process.hrtime();

    const spanContext = ctx.tracer.extract('http-header', ctx.request.headers) || undefined;
    const span = ctx.span = ctx.tracer.startSpan(ctx.path, {
      childOf: spanContext,
      startTime: HrTime.toMs(started),
    });
    const { spanId, traceId } = span.context() as unknown as Record<string, string>;

    ctx.logger = logger.child({
      host: ctx.host,
      ip: ctx.ip,
      method: ctx.method,
      path: ctx.request.url,
      spanId,
      traceId,
    });

    if (options.useLogger !== false && !options.loggerIgnorePath?.test(ctx.request.url)) {
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

      options.monitor && options.monitor({
        duration: durationMs,
        method: ctx.method,
        path: ctx.path,
        status: ctx.status,
      });
      if (options.useLogger !== false && !options.loggerIgnorePath?.test(ctx.request.url)) {
        ctx.logger('-->', { duration: durationMs, status: ctx.status });
      }
    } catch (err) {
      ctx.logger.error(err);
    }
  };
  return middleware as Middleware;
};
