/**
 * Minimal circuit breaker.
 *
 * Purpose here is less about protecting the upstream and more about protecting
 * *our own latency budget*: if the Panchang service is hard-down, every request
 * would otherwise burn its full timeout + retries before degrading. Opening the
 * circuit lets us fail that source instantly and spend the time on the LLM call
 * instead. Astrology answers degrade gracefully; slow answers do not.
 */
export type CircuitState = 'closed' | 'open' | 'half-open';

export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private state: CircuitState = 'closed';

  constructor(
    private readonly failureThreshold = 5,
    private readonly cooldownMs = 10_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** True when the call should be short-circuited. */
  shouldTrip(): boolean {
    if (this.state === 'open') {
      if (this.now() - this.openedAt >= this.cooldownMs) {
        this.state = 'half-open';
        return false; // let one probe request through
      }
      return true;
    }
    return false;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.state = 'closed';
  }

  recordFailure(): void {
    this.failures += 1;
    if (this.state === 'half-open' || this.failures >= this.failureThreshold) {
      this.state = 'open';
      this.openedAt = this.now();
    }
  }

  getState(): CircuitState {
    return this.state;
  }
}
