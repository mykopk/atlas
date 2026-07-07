import { Logger } from "@myko.pk/logger";

export enum CircuitState {
  CLOSED = "CLOSED",
  OPEN = "OPEN",
  HALF_OPEN = "HALF_OPEN",
}

export interface CircuitBreakerConfig {
  failureThreshold: number;
  cooldownMs: number;
  halfOpenMaxRequests: number;
  successThreshold: number;
}

export interface CircuitBreakerMetrics {
  state: CircuitState;
  failureCount: number;
  totalOpens: number;
  totalHalfOpenProbes: number;
  totalSuccessesAfterOpen: number;
  p99Ms: number;
  failureThreshold: number;
  cooldownMs: number;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  cooldownMs: 30_000,
  halfOpenMaxRequests: 1,
  successThreshold: 2,
};

const LATENCY_WINDOW_SIZE = 100;
const LATENCY_HIGH_WARN_MS = 500;

/**
 * Generic circuit breaker with P99 latency tracking and load-shedding support.
 *
 * @description
 * Implements the standard CLOSED → OPEN → HALF_OPEN → CLOSED state machine.
 * In OPEN state all calls fail-fast. After `cooldownMs` transitions to HALF_OPEN
 * allowing a probe request. If `successThreshold` consecutive probes succeed,
 * transitions back to CLOSED. Any failure in HALF_OPEN re-opens immediately.
 *
 * P99 latency tracking uses a sliding window of the last 100 samples.
 * `shouldShedLoad()` returns true when p99 exceeds the given threshold
 * while the circuit is CLOSED, enabling graceful degradation under load.
 */
export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount = 0;
  private successCountInHalfOpen = 0;
  private halfOpenRequests = 0;
  private lastOpenTime = 0;
  private config: CircuitBreakerConfig;

  private totalOpens = 0;
  private totalHalfOpenProbes = 0;
  private totalSuccessesAfterOpen = 0;

  private readonly latencySamples: number[] = new Array(
    LATENCY_WINDOW_SIZE,
  ).fill(0);
  private latencyIndex = 0;
  private latencyCount = 0;

  private readonly logger: Logger;

  constructor(
    config?: Partial<CircuitBreakerConfig>,
    name = "CircuitBreaker",
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = new Logger(name);
  }

  get stateLabel(): string {
    return this.state;
  }

  getMetrics(): CircuitBreakerMetrics {
    return {
      state: this.state,
      failureCount: this.failureCount,
      totalOpens: this.totalOpens,
      totalHalfOpenProbes: this.totalHalfOpenProbes,
      totalSuccessesAfterOpen: this.totalSuccessesAfterOpen,
      p99Ms: this.getP99Ms(),
      failureThreshold: this.config.failureThreshold,
      cooldownMs: this.config.cooldownMs,
    };
  }

  shouldShedLoad(p99ThresholdMs = LATENCY_HIGH_WARN_MS): boolean {
    return (
      this.state === CircuitState.CLOSED && this.getP99Ms() > p99ThresholdMs
    );
  }

  private evaluateState(): void {
    if (this.state !== CircuitState.OPEN) return;
    const elapsed = Date.now() - this.lastOpenTime;
    if (elapsed >= this.config.cooldownMs) {
      this.state = CircuitState.HALF_OPEN;
      this.halfOpenRequests = 0;
      this.successCountInHalfOpen = 0;
      this.logger.log("Circuit HALF_OPEN — probing");
    }
  }

  isAvailable(): boolean {
    this.evaluateState();
    if (this.state === CircuitState.OPEN) return false;
    if (
      this.state === CircuitState.HALF_OPEN &&
      this.halfOpenRequests >= this.config.halfOpenMaxRequests
    )
      return false;
    return true;
  }

  onSuccess(durationMs?: number): void {
    if (durationMs !== undefined) {
      this.recordLatency(durationMs);
    }

    if (this.state === CircuitState.HALF_OPEN) {
      this.totalHalfOpenProbes++;
      this.successCountInHalfOpen++;
      if (this.successCountInHalfOpen >= this.config.successThreshold) {
        this.totalSuccessesAfterOpen++;
        this.reset();
      }
    } else if (this.state === CircuitState.CLOSED) {
      this.failureCount = 0;
    }
  }

  onFailure(): void {
    this.failureCount++;
    if (this.state === CircuitState.HALF_OPEN) {
      this.trip();
      return;
    }
    if (this.failureCount >= this.config.failureThreshold) {
      this.trip();
    }
  }

  onAttempt(): void {
    if (this.state === CircuitState.HALF_OPEN) {
      this.halfOpenRequests++;
    }
  }

  private trip(): void {
    this.state = CircuitState.OPEN;
    this.lastOpenTime = Date.now();
    this.halfOpenRequests = 0;
    this.successCountInHalfOpen = 0;
    this.totalOpens++;
    this.logger.warn(
      `Circuit OPEN (${this.totalOpens}) after ${this.failureCount} failures — calls will fail fast`,
    );
  }

  private reset(): void {
    this.state = CircuitState.CLOSED;
    this.failureCount = 0;
    this.successCountInHalfOpen = 0;
    this.halfOpenRequests = 0;
    this.lastOpenTime = 0;
    this.logger.log("Circuit CLOSED — operational");
  }

  private recordLatency(ms: number): void {
    this.latencySamples[this.latencyIndex] = ms;
    this.latencyIndex = (this.latencyIndex + 1) % LATENCY_WINDOW_SIZE;
    if (this.latencyCount < LATENCY_WINDOW_SIZE) {
      this.latencyCount++;
    }
  }

  private getP99Ms(): number {
    if (this.latencyCount === 0) return 0;
    const sorted = this.latencySamples
      .slice(0, this.latencyCount)
      .sort((a, b) => a - b);
    const idx = Math.ceil(this.latencyCount * 0.99) - 1;
    return sorted[Math.max(0, idx)];
  }
}

export class CircuitBreakerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CircuitBreakerError";
  }
}

function failureResult<T>(error: Error): { success: false; error: Error } {
  return { success: false, error };
}

/**
 * Wrap a DatabaseServiceInterface with a circuit breaker via Proxy.
 *
 * @description
 * Intercepts all method calls on the given `DatabaseServiceInterface` instance.
 * When the circuit is OPEN, returns a `failure()` DatabaseResult immediately
 * instead of calling the underlying method. Tracks successes/failures and
 * delegates to the `CircuitBreaker` state machine.
 *
 * The `adapter` property access is always passed through (not circuit-broken).
 *
 * @param db - The DatabaseServiceInterface instance to wrap (or null)
 * @param config - Optional circuit breaker config overrides
 * @param name - Optional name for logger context
 * @returns A proxied DatabaseServiceInterface, or null if input was null
 */
export function withDbCircuitBreaker<T extends { adapter: unknown }>(
  db: T | null,
  config?: Partial<CircuitBreakerConfig>,
  name = "DbCircuitBreaker",
): T | null {
  if (!db) return null;
  const breaker = new CircuitBreaker(config, name);

  return new Proxy(db, {
    get(target, prop) {
      if (prop === "adapter") {
        return target.adapter;
      }
      if (prop === "getCircuitMetrics") {
        return breaker.getMetrics.bind(breaker);
      }
      const value = (target as unknown as Record<string | symbol, unknown>)[prop];
      if (typeof value !== "function") return value;

      return function (this: unknown, ...args: unknown[]) {
        if (!breaker.isAvailable()) {
          return failureResult(
            new CircuitBreakerError("Database circuit is open"),
          );
        }
        breaker.onAttempt();
        try {
          const result = value.apply(target, args);
          if (result instanceof Promise) {
            return result
              .then((res: unknown) => {
                if (
                  res &&
                  typeof res === "object" &&
                  "success" in (res as Record<string, unknown>)
                ) {
                  if ((res as Record<string, unknown>).success) {
                    breaker.onSuccess();
                  } else {
                    breaker.onFailure();
                  }
                }
                return res;
              })
              .catch((err: Error) => {
                breaker.onFailure();
                throw err;
              });
          }
          return result;
        } catch (err) {
          breaker.onFailure();
          throw err;
        }
      };
    },
  });
}
