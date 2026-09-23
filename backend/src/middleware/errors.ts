import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '../lib/prisma.js';
import { HttpError, notFound } from '../lib/http-errors.js';
import { describeError, logger } from '../lib/logger.js';

// Business rules enforced by the database (migration SQL) surface here. Each
// named constraint maps to the stable code a client reacts to; the database
// message itself is never returned (it contains SQL, column names and row data).
const CONSTRAINT_ERRORS: Record<string, HttpError> = {
  no_overlapping_active_contracts: new HttpError(409, 'CONTRACT_PERIOD_OVERLAP', 'This period overlaps another approved or active contract for the same employee'),
  chk_contracts_dates: new HttpError(422, 'CONTRACT_DATES_INVALID', 'The contract end date must be after its start date'),
  employees_job_number_ci_key: new HttpError(409, 'JOB_NUMBER_TAKEN', 'An employee with this job number already exists'),
  chk_waiver_max_window: new HttpError(422, 'WAIVER_WINDOW_EXCEEDED', 'A waiver can last at most 72 hours'),
  chk_waiver_future: new HttpError(422, 'WAIVER_EXPIRY_IN_PAST', 'A waiver must expire in the future'),
  shift_assignments_employee_slot_key: new HttpError(409, 'SHIFT_SLOT_TAKEN', 'This employee already holds this shift on this date'),
  role_assignments_active_key: new HttpError(409, 'ROLE_ALREADY_ASSIGNED', 'This user already holds an active assignment for this role and scope type'),
  approval_requests_pending_key: new HttpError(409, 'APPROVAL_ALREADY_PENDING', 'An approval request for this action is already pending'),
  chk_units_bed_count: new HttpError(422, 'BED_COUNT_OUT_OF_RANGE', 'Bed count must be between 0 and 500'),
};

interface DriverCause { originalCode?: string; originalMessage?: string; constraint?: { index?: string } }

/** SQLSTATE and constraint name from a Prisma 7 driver-adapter error, when present. */
function driverCause(e: Prisma.PrismaClientKnownRequestError): { sqlState?: string; constraint?: string } {
  const cause = (e.meta?.driverAdapterError as { cause?: DriverCause } | undefined)?.cause;
  if (!cause) return {};
  const constraint = cause.constraint?.index ?? /constraint "([^"]+)"/.exec(cause.originalMessage ?? '')?.[1];
  return { sqlState: cause.originalCode, constraint };
}

/** Translates a Prisma error into a client-safe HttpError. Exported for tests. */
export function fromPrismaError(e: Prisma.PrismaClientKnownRequestError): HttpError {
  const { sqlState, constraint } = driverCause(e);
  const known = constraint ? CONSTRAINT_ERRORS[constraint] : undefined;
  if (known) return known;
  if (e.code === 'P2025') return notFound();
  if (e.code === 'P2002' || sqlState === '23505') return new HttpError(409, 'DUPLICATE', 'A record with this value already exists');
  if (e.code === 'P2003' || sqlState === '23503') return new HttpError(409, 'RELATED_RECORD_MISSING', 'A related record does not exist or is still in use');
  if (sqlState === '23514' || sqlState === '23P01') return new HttpError(422, 'CONSTRAINT_VIOLATION', 'The request breaks a data rule');
  return new HttpError(400, 'INVALID_REQUEST', 'The request could not be processed');
}

/** 404 for any /api path no router handled. */
export const unknownRoute: RequestHandler = (_req, _res, next) => {
  next(new HttpError(404, 'ROUTE_NOT_FOUND', 'No such endpoint'));
};

/** Final error handler: every error leaves as {error: {code, message, details?}}. */
export const errorHandler: ErrorRequestHandler = (err: unknown, _req, res, next) => {
  if (res.headersSent) return next(err);
  const requestId = res.locals.requestId;
  let httpError: HttpError;

  if (err instanceof HttpError) {
    httpError = err;
  } else if (err instanceof ZodError) {
    httpError = new HttpError(400, 'VALIDATION_FAILED', 'The request is invalid',
      err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  } else if (err instanceof Prisma.PrismaClientKnownRequestError) {
    httpError = fromPrismaError(err);
    logger.warn('rejected by database', { requestId, prismaCode: err.code, ...driverCause(err), mappedTo: httpError.code });
  } else if (isBodyParserError(err)) {
    httpError = err.type === 'entity.too.large'
      ? new HttpError(413, 'PAYLOAD_TOO_LARGE', 'The request body is too large')
      : new HttpError(400, 'MALFORMED_BODY', 'The request body could not be parsed');
  } else {
    logger.error('unexpected error', { requestId, ...describeError(err) });
    httpError = new HttpError(500, 'INTERNAL_ERROR', 'Internal server error');
  }

  res.status(httpError.status).json(httpError.toBody());
};

function isBodyParserError(e: unknown): e is { type: string; status: number } {
  return typeof e === 'object' && e !== null && typeof (e as { type?: unknown }).type === 'string'
    && typeof (e as { status?: unknown }).status === 'number' && (e as { status: number }).status < 500;
}
