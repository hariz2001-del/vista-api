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
  'rms:EXPENSE_FROM_PAYROLL': 'Staff wages come from a paid payslip and cannot be changed here.',
  'rms:EXPENSE_REIMBURSED':
    'The partner has already been paid back for this, so who paid and how much can no longer change.',
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
  'menu:BRAND_HAS_STOCK': 'That brand still has items on the stock list. Move or delete them first.',
  'stock:ITEM_NOT_FOUND': 'That stock item no longer exists.',
  'stock:COUNT_NOT_FOUND': 'That stock count no longer exists.',
  'stock:ORDER_MISMATCH': 'The stock list changed while you were arranging it. It has been reloaded — try again.',
  'stock:UNKNOWN_STAFF': 'That staff member is no longer on the team.',
  'stock:WHO_COUNTED': 'Pick or type who did the count.',
  'menu:INVALID_SELECTION': 'The minimum cannot be more than the maximum.',
  'promo:NOT_FOUND': 'That promotion no longer exists.',
  'promo:UNKNOWN_TARGET': 'An item or category in that promotion is no longer on the menu.',
  'menu:ORDER_MISMATCH': 'The menu changed while you were arranging it. It has been reloaded — try again.',

  'team:ORG_NOT_FOUND': 'We could not find that workplace. Check the email or code with your manager.',
  'team:INVALID_LOGIN': 'That PIN is not right. Try again, or ask your manager for your PIN.',
  'team:PIN_SHARED': 'Someone else has the same PIN. Ask your manager to give you a new one.',
  'team:PIN_TAKEN': 'Another staff member already has that PIN. Pick a different one, or leave it blank for a random one.',
  'team:STAFF_NOT_FOUND': 'That staff member no longer exists.',
  'team:STAFF_HAS_HISTORY': 'They have hours or pay on record, so they cannot be deleted. Deactivate them instead — their history stays and they can no longer sign in.',
  'team:STAFF_CODE_TAKEN': 'Another staff member already has that Staff ID.',
  'team:WORK_TYPE_NOT_FOUND': 'That work type no longer exists.',
  'team:WORK_TYPE_NAME_TAKEN': 'A work type with that name already exists.',
  'team:TARGET_ABOVE_MAX': 'The usual number of shifts cannot be more than the maximum.',
  'team:NOT_FOUND': 'That no longer exists.',
  'team:RANGE_BACKWARDS': 'The end date must be on or after the start date.',
  'team:TIMES_BACKWARDS': 'The end time must be after the start time.',
  'team:WEEK_NOT_FOUND': 'That roster week no longer exists.',
  'team:WEEK_NOT_MONDAY': 'A roster week starts on a Monday.',
  'team:WEEK_EXISTS': 'There is already a roster for that week.',
  'team:WEEK_PUBLISHED': 'This roster is published. Change it shift by shift, or move it back to review first.',
  'team:DATE_OUTSIDE_WEEK': 'That date is not in this roster week.',
  'team:HAS_ATTENDANCE': 'Someone has already clocked in against this, so it cannot be deleted.',
  'team:SHIFT_NOT_FOUND': 'That shift no longer exists.',
  'team:ASSIGNMENT_NOT_FOUND': 'That shift assignment no longer exists.',
  'team:ALREADY_ASSIGNED': 'They are already on this shift.',
  'team:STAFF_INACTIVE': 'That staff member is deactivated.',
  'team:COVERAGE_NOT_FOUND': 'That cover request no longer exists.',
  'team:COVERAGE_CLOSED': 'That shift has already been covered or the request was cancelled.',
  'team:APPLICATIONS_CLOSED': 'Applications for this week are closed.',
  'team:APPLICATION_LIMIT': 'You have applied for the most shifts allowed this week. Remove one to pick another.',
  'team:NOT_PUBLISHED': 'This roster has not been published yet.',
  'team:WITHDRAW_DEADLINE_PASSED': 'It is too close to this shift to pull out here. Contact your manager.',
  'team:OFFER_NOT_FOUND': 'That offer no longer exists.',
  'team:OFFER_GONE': 'Someone else has already covered this shift, or it was cancelled.',
  'team:OFFER_CLASH': 'You are already working at that time.',
  'team:ALREADY_CLOCKED_IN': 'You are already clocked in.',
  'team:NOT_CLOCKED_IN': 'You are not clocked in.',
  'team:ATTENDANCE_NOT_FOUND': 'That attendance record no longer exists.',
  'team:NO_CLOCK_OUT': 'Set an end time before approving.',
  'team:NO_RATE': 'Some approved time has no work type or rate. Give the person a usual work type, or set one on the record.',
  'team:NOTHING_TO_PAY': 'There is no approved time to pay for in this period.',
  'team:PAYSLIP_EXISTS': 'This period already has a payslip for them.',
  'team:PAYSLIP_NOT_FOUND': 'That payslip no longer exists.',
  'team:PAYSLIP_PAID': 'That payslip is paid and cannot change. Use an adjustment instead.',
  'team:PAYSLIP_CHANGED': 'That payslip changed while it was being paid. Reload and try again.',
  'team:ADJUSTMENT_CLOSED': 'That adjustment has already been settled.',
  'team:ORG_CODE_TAKEN': 'Another workplace already uses that code. Pick a different one.',

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
