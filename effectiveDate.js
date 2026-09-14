'use strict';

/**
 * pickEffectiveRow
 * Given a set of rows that each carry effective_date / expiration_date /
 * is_active, returns the single row that applies "as of" a given date —
 * the same logic spec §7/§9/§18 all rely on and that Test 12 (§54) checks.
 *
 * Rule: effective_date <= asOf AND (expiration_date IS NULL OR expiration_date > asOf)
 * Among matches, the most recently effective row wins (so an admin
 * correction with a later effective_date always takes precedence).
 */
function pickEffectiveRow(rows, asOfDate) {
  const asOf = new Date(asOfDate);
  if (Number.isNaN(asOf.getTime())) {
    throw new RangeError(`Invalid asOfDate: ${asOfDate}`);
  }

  const candidates = (rows || []).filter((row) => {
    if (row.is_active === false) return false;
    const effective = new Date(row.effective_date);
    if (effective > asOf) return false;
    if (row.expiration_date) {
      const expiration = new Date(row.expiration_date);
      if (expiration <= asOf) return false;
    }
    return true;
  });

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => new Date(b.effective_date) - new Date(a.effective_date));
  return candidates[0];
}

module.exports = { pickEffectiveRow };
