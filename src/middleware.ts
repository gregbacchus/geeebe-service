import { Statuses } from '@geeebe/common';
import { Middleware } from 'koa';
import { RouterContext } from 'koa-router';
import { formatError } from './error';

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
  return async function (ctx, next) {
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
export const securityHeaderMiddleware = (): Middleware => async (ctx, next: () => Promise<any>): Promise<void> => {
  await next();

  ctx.set('X-Frame-Options', 'DENY');
  ctx.set('X-XSS-Protection', '1; mode=block');
  ctx.set('X-Content-Type-Options', 'nosniff');
};

export const noCacheMiddleware = (): Middleware => async (ctx, next: () => Promise<any>): Promise<void> => {
  await next();

  ctx.set('Cache-Control', 'max-age=0');
  ctx.set('Pragma', 'no-cache');
};

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
    ctx.response.headers['Retry-After'] = 30;
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
    ctx.response.headers['Retry-After'] = 30;
  }
};
