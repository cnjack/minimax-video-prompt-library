/**
 * Wraps an async Express handler so rejected promises are forwarded to the
 * error middleware (Express 4 does not catch them automatically).
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ErrorCode } from '@h3/shared';
import { ApiError } from '../errors.js';

export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/** Read a required route param, throwing a clean error if absent. */
export function routeParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ApiError(ErrorCode.BAD_REQUEST, `Missing route parameter "${name}".`);
  }
  return value;
}

/** Parse a value with a zod schema, throwing a zod error on failure. */
export function parseBody<T>(schema: { parse: (v: unknown) => T }, value: unknown): T {
  return schema.parse(value);
}
