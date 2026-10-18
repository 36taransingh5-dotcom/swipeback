/* global document */
// Illustrative scenarios only. This preview never sends email or creates expenses.
const scenarios = {
  coffee: {
    subject: "Coffee with the team",
    message:
      "Here's the receipt for our team coffee this morning. Paid on the company card.",
    merchant: "The Daily Grind",
    detail: "Receipt attached · company card",
    amount: "£11.50",
    tone: "clear",
    symbol: "✓",
    label: "ALL CLEAR",
    title: "Coffee's on the company.",
    description:
      "Receipt matched. Within the meal allowance. Cleared without a trip to finance.",
    checks: [
      "Receipt read and matched",
      "Company policy checked",
      "Confirmation sent in the same thread",
    ],
  },
  lunch: {
    subject: "Lunch receipt",
    message: "Sending over the receipt from lunch. Paid on the company card.",
    merchant: "Little Table",
    detail: "Receipt attached · company card",
    amount: "£64.00",
    tone: "question",
    symbol: "?",
    label: "ONE QUICK QUESTION",
    title: "Who joined you for lunch?",
    description:
      "The receipt is here. The business purpose is missing. Swipeback asks you in the same thread.",
    checks: [
      "Receipt read and matched",
      "Business purpose needed to check policy",
      "Reply by email — no new form to fill in",
    ],
  },
  hotel: {
    subject: "Overnight stay for the client visit",
    message:
      "One night near the client office. Paid on the company card. Receipt attached.",
    merchant: "The Borough Hotel",
    detail: "Receipt attached · one night",
    amount: "£210.00",
    tone: "review",
    symbol: "↗",
    label: "OVER TO FINANCE",
    title: "A little over. A human call.",
    description:
      "This stay is £30 above the sample £180 nightly limit. Finance gets the receipt and the reason to review.",
    checks: [
      "Receipt and card transaction matched",
      "Outside the accommodation allowance",
      "Sent to finance with the full context",
    ],
  },
};

const fields = {
  subject: "example-subject",
  message: "example-message",
  merchant: "example-merchant",
  detail: "example-detail",
  amount: "example-amount",
  symbol: "result-symbol",
  label: "result-label",
  title: "result-title",
  description: "result-description",
};
const buttons = document.querySelectorAll("[data-scenario]");
buttons.forEach((button) => {
  button.addEventListener("click", () => {
    const scenario = scenarios[button.dataset.scenario];
    if (!scenario) return;
    buttons.forEach((item) =>
      item.setAttribute("aria-pressed", String(item === button)),
    );
    for (const [key, id] of Object.entries(fields))
      document.getElementById(id).textContent = scenario[key];
    document.querySelector(".demo-output").dataset.tone = scenario.tone;
    document.getElementById("result-checks").replaceChildren(
      ...scenario.checks.map((text) => {
        const item = document.createElement("li");
        item.textContent = text;
        return item;
      }),
    );
  });
});
