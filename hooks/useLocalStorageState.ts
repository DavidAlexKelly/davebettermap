import { useState, useCallback, useEffect } from "react";

/**
 * A drop-in replacement for `useState` that persists the value to
 * `localStorage` under the given `key`.
 *
 * - On first render the hook reads from `localStorage`; if a stored
 *   value exists and can be parsed it becomes the initial state,
 *   otherwise `defaultValue` is used.
 * - Every time `setValue` is called the new value is written to
 *   `localStorage` synchronously.
 * - A custom `serialize` / `deserialize` pair can be provided for
 *   values that are not plain JSON (e.g. `Set`).
 */
export function useLocalStorageState<T>(
  key: string,
  defaultValue: T,
  options?: {
    serialize?: (value: T) => string;
    deserialize?: (raw: string) => T;
  }
): [T, (value: T | ((prev: T) => T)) => void] {
  const serialize = options?.serialize ?? JSON.stringify;
  const deserialize = options?.deserialize ?? JSON.parse;

  const [state, setStateRaw] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key);
      if (stored != null) {
        return deserialize(stored);
      }
    } catch {
      // Corrupted or unreadable — fall through to default
    }
    return defaultValue;
  });

  // Write to localStorage whenever the value changes
  useEffect(() => {
    try {
      localStorage.setItem(key, serialize(state));
    } catch {
      // Storage full or unavailable — silently ignore
    }
  }, [key, state, serialize]);

  const setState = useCallback((value: T | ((prev: T) => T)) => {
    setStateRaw(value);
  }, []);

  return [state, setState];
}
