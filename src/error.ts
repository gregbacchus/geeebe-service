import { Statuses } from '@geeebe/common';
import { logger, WithLogger } from '@geeebe/logging';
import { Context } from 'koa';

const debug = logger.child({});

//noinspection JSUnusedGlobalSymbols
/**
 * Formats the given error into the Koa context - Should never throw any exception
 * @param {object} ctx - koa.js context
 * @param {string} ctx.request.url - URL of original requires
 * @param {number} ctx.status - HTTP response status
 * @param {function} ctx.set - set response header
 * @param {*} ctx.body - HTTP response body
 * @param {Error} err - error to format
 * @param {object[]} [err.errors] - validation errors
 */
export function formatError(ctx: Context & Partial<WithLogger>, err: any): void {
  const data: any = { type: err.name, message: err.message };
  const logger = ctx.logger || debug;

  switch (err.name) {
    case 'ValidationError':
      logger(`${ctx.request.method} ${ctx.request.url}`, { errors: err.errors, errorMessage: err.message });
      if (err.errors) {
        data.failures = err.errors.map(
          (error: any) => ({ message: error.kind, parameter: error.path }),
        );
      }
      ctx.status = Statuses.BAD_REQUEST;
      break;
    case 'UnauthorizedError':
      ctx.set('Cache-Control', 'max-age=0');
      ctx.set('Pragma', 'no-cache');
      ctx.status = err.status || Statuses.UNAUTHORIZED;
      break;
    default:
      logger(`${ctx.request.method} ${ctx.request.url}`, { error: err });
      ctx.set('Cache-Control', 'max-age=0');
      ctx.set('Pragma', 'no-cache');
      ctx.status = err.status || Statuses.SERVER_ERROR;
      break;
  }
  ctx.body = { error: data };
}
