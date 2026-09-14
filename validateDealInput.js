'use strict';

/**
 * validateDealInput
 * §39 — prevents invalid values and returns educational (non-blocking)
 * warnings for unusual-but-not-invalid inputs. Blocking errors and
 * advisory warnings are kept separate so the caller can decide to still
 * show results alongside the warnings, per "Warnings should educate
 * rather than unnecessarily block users."
 */
function validateDealInput(input) {
  const errors = [];
  const warnings = [];

  if (typeof input.sellingPrice !== 'number' || input.sellingPrice <= 0) {
    errors.push('sellingPrice must be a positive number.');
  }
  if (input.termMonths == null || input.termMonths <= 0) {
    errors.push('termMonths must be a positive number.');
  }
  if (input.trade && input.trade.hasTrade) {
    if (input.trade.tradeValue < 0) errors.push('trade.tradeValue cannot be negative.');
    if (input.trade.payoff < 0) errors.push('trade.payoff cannot be negative.');
  }
  if (input.downPayment != null && input.downPayment < 0) {
    errors.push('downPayment cannot be negative.');
  }

  // --- advisory warnings, non-blocking ---
  if (input.trade && input.trade.hasTrade) {
    const equity = input.trade.tradeValue - input.trade.payoff;
    if (equity < -8000) {
      warnings.push(
        'This trade has significant negative equity. Rolling it into the new loan will substantially increase the amount financed.'
      );
    }
  }
  if (input.targetPayment != null && input.sellingPrice) {
    const impliedMinPayment = input.sellingPrice / (84 * 3); // rough sanity floor
    if (input.targetPayment < impliedMinPayment * 0.3) {
      warnings.push(
        'The target payment entered is unusually low relative to the vehicle price and may not be achievable without a large down payment or price reduction.'
      );
    }
  }
  if (input.termMonths > 84) {
    warnings.push('Loan terms beyond 84 months are unusual and mean paying significantly more interest over time.');
  }
  if (
    input.cashAvailable != null &&
    input.downPayment != null &&
    input.downPayment > input.cashAvailable
  ) {
    warnings.push('The down payment entered exceeds the cash available you specified.');
  }

  return { errors, warnings, isValid: errors.length === 0 };
}

module.exports = { validateDealInput };
