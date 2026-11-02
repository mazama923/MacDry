export function text(facts, key) {
  return typeof facts[key] === "string" ? facts[key] : "";
}

export function number(facts, key) {
  return Number.isSafeInteger(facts[key]) ? facts[key] : -1;
}

export function numberText(value) {
  return String(value);
}
