/**
 * Request-id middleware. Every request gets an id (from the `X-Request-Id`
 * header when provided, otherwise generated) and tags the response header so
 * clients can trace a request end-to-end.
 */

import type { Request, Response, NextFunction } from 'express';
import { newId } from '../util.js';

export const REQUEST_ID_HEADER = 'x-request-id';

export function requestId(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const incoming = req.header(REQUEST_ID_HEADER);
  const id = incoming && incoming.trim().length > 0 ? incoming.trim() : newId();
  res.locals.requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
}
