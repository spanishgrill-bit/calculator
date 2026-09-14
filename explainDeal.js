'use strict';

/**
 * explainDeal / explainForDealer
 * §32/§33/§34 — this is the "AI EXPLANATION LAYER" in the architecture
 * diagram. It is intentionally template-based rather than an LLM call:
 * it only ever reads numbers that computeScenario/scoreScenarios already
 * produced, and turns them into the sentences the spec's examples show.
 * This guarantees it can never hallucinate a number.
 *
 * SWAPPING IN A REAL LLM LATER: keep this function's signature and only
 * change its body to call the Anthropic API with these same already-
 * verified numbers in the prompt (never let the model invent its own).
 * That keeps the "AI never computes numbers" architecture intact even
 * after the wording gets more natural/varied.
 */

function money(n) {
  return `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

/** Customer-facing explanation (§32 "EXPLAIN MY DEAL"). */
function explainDeal({ tradeEquity, scenarios, recommended, objective, paymentGap }) {
  const lines = [];

  if (tradeEquity > 0) {
    lines.push(
      `Your trade has approximately ${money(tradeEquity)} of positive equity. This reduces the amount you need to finance.`
    );
  } else if (tradeEquity < 0) {
    lines.push(
      `Your trade currently has about ${money(Math.abs(tradeEquity))} of negative equity, meaning it's rolled into the amount financed rather than reducing it.`
    );
  }

  lines.push(
    `Based on the selected estimated APR and ${recommended.termMonths}-month term, your estimated payment on the current structure is ${money(
      recommended.monthlyPayment
    )}.`
  );

  if (paymentGap && paymentGap.direction !== 'on_target') {
    const word = paymentGap.direction === 'above_target' ? 'above' : 'below';
    lines.push(`That's ${money(paymentGap.difference)} ${word} your target payment.`);
  }

  const objectiveLabel = {
    lowest_payment: 'keeping your payment as low as possible',
    lowest_total_cost: 'minimizing total cost',
    lowest_cash: 'minimizing cash required',
    fastest_payoff: 'paying off the loan as fast as possible',
    best_balance: 'the best overall balance',
  }[objective] || 'your stated priority';

  lines.push(
    `Since ${objectiveLabel} is your priority, "${recommended.scenarioLabel}" is the strongest match: ${money(
      recommended.monthlyPayment
    )}/month, ${money(recommended.totalInterest)} in total interest, and ${money(recommended.cashRequired)} cash required.`
  );

  return lines.join(' ');
}

/** Dealer-facing neutral explanation (§33 "HOW SHOULD I EXPLAIN THIS?"). */
function explainForDealer({ paymentGap, scenarios }) {
  const lines = [];
  if (paymentGap && paymentGap.direction === 'above_target') {
    lines.push(
      `The current structure is approximately ${money(paymentGap.difference)} above the customer's target payment. The mathematical alternatives include:`
    );
    const alternativeLabels = scenarios
      .filter((s) => s.scenarioLabel !== 'CURRENT DEAL')
      .map((s) => `${s.scenarioLabel} (${money(s.monthlyPayment)}/mo)`);
    lines.push(alternativeLabels.join('; ') + '.');
  } else {
    lines.push('The current structure already meets or beats the customer\'s target payment.');
  }
  lines.push(
    'Present these as mathematical trade-offs, not pressure tactics — the customer decides which trade-off fits them.'
  );
  return lines.join(' ');
}

module.exports = { explainDeal, explainForDealer, money };
