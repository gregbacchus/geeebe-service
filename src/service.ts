import { Api } from '@geeebe/api';
import { Statuses } from '@geeebe/common';
import { logger } from '@geeebe/logging';
import Validator from 'better-validator';
import { Koa2Middleware } from 'better-validator/src/middleware/Koa2Middleware';
import * as Koa from 'koa';
import { Middleware } from 'koa';
import Router = require('koa-router');
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

export interface IService {
  start(): void;
}

export interface IServiceOptions {
  port: number | string; // server port
  staticPath?: string; // directory from which to serve static files
  useLogger?: boolean; // include koa logger
  disableCache?: boolean;
}

const WrapperFormatter = Validator.format.response.WrapperFormatter;
const FailureFormatter = Validator.format.failure.FailureFormatter;

export const validatorMiddleware: Koa2Middleware = Validator.koa2Middleware({
  failureFormatter: new FailureFormatter({}),
  responseFormatter: new WrapperFormatter({}),
});

//noinspection JSUnusedGlobalSymbols
export abstract class KoaService<TOptions extends IServiceOptions> extends Koa implements IService {

  /**
   * Returns error formatting middleware
   */
  private static errorMiddleware(): Middleware {
    return async (ctx, next) => {
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

    // TODO this.use(Shared.instance.stats.monitorMiddleware());
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
    this.mountApi(router);

    this.use(router.routes());
    this.use(router.allowedMethods());

    // start server
    this.startServer();
  }

  /**
   * Adds headers for additional security
   */
  protected securityHeaderMiddleware(): Middleware {
    const middleware = (ctx: Router.IRouterContext, next: () => Promise<any>): Promise<void> => {
      return next()
        .then(() => {
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
        });
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
}
