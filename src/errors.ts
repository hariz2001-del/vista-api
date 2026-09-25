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
  'auth:TOO_MANY_ATTEMPTS': 'Too many attempts. Wait 15 minutes and try again.',
  'auth:EMAIL_TAKEN': 'An account with that email already exists. Sign in instead.',
  'auth:HANDOFF_INVALID': 'That sign-in link has expired. Go back to vistahub.my and choose again.',

  'shift:ALREADY_OPEN': 'A shift is already open. Close it before opening another.',
  'shift:NOT_FOUND': 'That shift no longer exists.',
  'shift:ALREADY_CLOSED': 'This shift has already been closed.',
  'shift:UNSYNCED_ORDERS':
    'Some sales or corrections have not reached the server yet. Reconnect and wait before closing.',

  'checkout:EMPTY_ORDER': 'Add at least one item before taking payment.',
  'checkout:UNKNOWN_PRODUCT': 'An item on this order is no longer on the menu.',
  'checkout:UNKNOWN_MODIFIER': 'An option on this order is no longer available.',
  'checkout:GROSS_MISMATCH':
    'The total does not match the current menu prices. Rebuild the order and try again.',
  'checkout:SHIFT_NOT_OPEN': 'No shift is open. Open a shift before taking payment.',
  'checkout:PERIOD_LOCKED': 'That business date is in a month that has already been settled.',
  'checkout:DUPLICATE_TRANSACTION':
    'This sale could not be recorded. Start a new order and take payment again.',
  'correction:DUPLICATE_TRANSACTION':
    'This correction could not be recorded. Reopen the sale and try again.',

  'correction:ORDER_NOT_FOUND': 'That paid sale could not be found.',
  'correction:SHIFT_NOT_OPEN': 'That shift is already closed.',
  'correction:PERIOD_LOCKED': 'That sale belongs to a month that has already been settled.',
  'correction:ALREADY_CANCELLED': 'That sale has already been fully cancelled.',
  'correction:DELTA_MISMATCH':
    'The amount to collect or return has changed. Reopen the sale and try again.',
  'correction:TOTAL_MISMATCH':
    'The amended ticket does not match the current menu. Reopen it and try again.',
  'correction:OFFLINE_TOTAL_MISMATCH':
    'The offline correction does not add up to the amount recorded on this device.',

  'auth:FORBIDDEN': 'This session is for the counter only. Sign in to the dashboard to see the books.',

  'rms:INVALID_RANGE': 'The start date must be on or before the end date.',
  'rms:PERIOD_LOCKED': 'That date falls in a period that has already been settled.',
  'rms:PERIOD_OVERLAPS': 'Part of that range has already been settled.',
  'rms:SHIFT_STILL_OPEN': 'A shift in that range is still open. Close it before settling.',
  'rms:SHIFT_NOT_OPEN': 'That shift is not open.',
  'rms:EXPENSE_NOT_FOUND': 'That expense no longer exists.',
  'rms:NOT_AN_ADVANCE': 'Only a cost a partner paid out of pocket can be settled.',
  'rms:ALREADY_SETTLED': 'That payment has already been settled.',
  'rms:UNKNOWN_BRAND': 'That brand does not exist.',
  'rms:PRODUCT_NOT_FOUND': 'That item is no longer on the menu.',
  'rms:NOTHING_TO_CHANGE': 'Nothing to change.',
  'rms:PARTNER_NOT_FOUND': 'That partner no longer exists.',
  'rms:SETTLEMENT_OFF':
    'Partner settlement is switched off for this business. Turn it on in Settings first.',
  'rms:SETTLEMENT_NEEDS_TWO_BRANDS':
    'Partner settlement needs exactly two brands, one for each partner. Set them up in Menu first.',

  'menu:BRAND_NOT_FOUND': 'That brand no longer exists.',
  'menu:CATEGORY_NOT_FOUND': 'That category no longer exists.',
  'menu:GROUP_NOT_FOUND': 'That option group no longer exists.',
  'menu:OPTION_NOT_FOUND': 'That option no longer exists.',
  'menu:NAME_TAKEN': 'Something with that name already exists here.',
  'menu:IN_USE': 'That has been sold or still has items in it, so it cannot be deleted. Hide it instead.',
  'menu:LAST_BRAND': 'A business needs at least one brand.',
  'menu:INVALID_SELECTION': 'The minimum cannot be more than the maximum.',

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

export const forbidden = (code: string, detail?: string) =>
  new DomainError(code, 403, messageFor(code), detail)

export const notFound = (code: string, detail?: string) =>
  new DomainError(code, 404, messageFor(code), detail)

export const conflict = (code: string, detail?: string) =>
  new DomainError(code, 409, messageFor(code), detail)
