/**
 * Errors are `domain:CODE` strings, thrown server-side and mapped to plain
 * language at the edge. A cashier mid-service must never be shown a raw
 * Postgres error or a stack trace — they need to know whether to take the money
 * again, and nothing else.
 */
export class DomainError extends Error {
  readonly code: string
  readonly statusCode: number
  readonly detail: string | undefined

  constructor(code: string, statusCode: number, message: string, detail?: string) {
    super(message)
    this.name = 'DomainError'
    this.code = code
    this.statusCode = statusCode
    this.detail = detail
  }
}

/** Plain-language message shown to the person at the counter. */
export const MESSAGES: Record<string, string> = {
  'auth:INVALID_CREDENTIALS': 'Incorrect email or password.',
  'auth:INVALID_PIN': 'Wrong PIN. Try again.',
  'auth:NO_PIN_SET': 'This account has no counter PIN set.',
  'auth:UNAUTHORIZED': 'Please sign in again.',

  'shift:ALREADY_OPEN': 'A shift is already open. Close it before opening another.',
  'shift:NOT_FOUND': 'That shift no longer exists.',
  'shift:ALREADY_CLOSED': 'This shift has already been closed.',
  'shift:UNSYNCED_ORDERS':
    'Some sales have not reached the server yet. Reconnect and wait for them before closing.',

  'checkout:EMPTY_ORDER': 'Add at least one item before taking payment.',
  'checkout:UNKNOWN_PRODUCT': 'An item on this order is no longer on the menu.',
  'checkout:UNKNOWN_MODIFIER': 'An option on this order is no longer available.',
  'checkout:GROSS_MISMATCH':
    'The total does not match the current menu prices. Rebuild the order and try again.',
  'checkout:SHIFT_NOT_OPEN': 'No shift is open. Open a shift before taking payment.',
  'checkout:PERIOD_LOCKED': 'That business date is in a month that has already been settled.',

  'validation:INVALID_REQUEST': 'Something about that request was not valid.',
  'server:UNEXPECTED': 'Something went wrong. The sale was not recorded — try again.',
}

export function messageFor(code: string): string {
  return MESSAGES[code] ?? MESSAGES['server:UNEXPECTED'] ?? 'Something went wrong.'
}

export const badRequest = (code: string, detail?: string) =>
  new DomainError(code, 400, messageFor(code), detail)

export const unauthorized = (code: string, detail?: string) =>
  new DomainError(code, 401, messageFor(code), detail)

export const notFound = (code: string, detail?: string) =>
  new DomainError(code, 404, messageFor(code), detail)

export const conflict = (code: string, detail?: string) =>
  new DomainError(code, 409, messageFor(code), detail)
