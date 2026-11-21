export interface RouteSize {
  /** Route path, e.g. "/checkout". */
  route: string;
  /** Size in bytes (the unit is decided by the caller, e.g. gzip). */
  bytes: number;
}

export interface Budget {
  /** Route path, or "*" as the default for routes without their own budget. */
  route: string;
  maxBytes: number;
}

export interface Violation {
  route: string;
  bytes: number;
  maxBytes: number;
  overBy: number;
}

export interface GateResult {
  ok: boolean;
  violations: Violation[];
}

/** Compare measured route sizes with budgets. A route's own budget wins over "*". */
export function evaluate(sizes: RouteSize[], budgets: Budget[]): GateResult {
  const byRoute = new Map(budgets.map((b) => [b.route, b.maxBytes]));
  const fallback = byRoute.get("*");

  const violations: Violation[] = [];
  for (const { route, bytes } of sizes) {
    const maxBytes = byRoute.get(route) ?? fallback;
    if (maxBytes === undefined || bytes <= maxBytes) continue;
    violations.push({ route, bytes, maxBytes, overBy: bytes - maxBytes });
  }

  return { ok: violations.length === 0, violations };
}
