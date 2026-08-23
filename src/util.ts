export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

/**
 * All of noble's `*Async` methods are promisified event listeners without any
 * timeout of their own: `connectAsync()` for example resolves when the
 * `connect` event arrives and never settles when it does not.
 *
 * That happens regularly in practice - the macOS bindings drop a request
 * silently when CoreBluetooth does not know the peripheral (anymore), e.g.
 * right after the adapter reported `resetting`. Without a timeout the whole
 * plugin dead-locks and only a Homebridge restart brings the light back, so
 * every BLE call has to be wrapped in here.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** noble rejects with plain strings in a lot of places, so `err.message` is not enough */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return String(error);
}

export function seconds(ms: number): string {
  return `${Math.round(ms / 1000)}s`;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
