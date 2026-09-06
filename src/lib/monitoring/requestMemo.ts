import { getRequestTrace } from "./requestTrace";

const scopes = new WeakMap<object, Map<string, Promise<unknown>>>();
function scope() {
  const trace = getRequestTrace();
  if (!trace || trace.closed) return null; // Background work must not share request credentials.
  let entries = scopes.get(trace);
  if (!entries) { entries = new Map(); scopes.set(trace, entries); }
  return entries;
}
export function forgetRequestMemo(key: string): void { scope()?.delete(key); }

/** Deduplicate only within one request, with an explicit validity predicate.
 * Invalidating while a load is pending cannot let that load restore its slot.
 */
export async function requestMemo<T>(key: string, load: () => Promise<T>, valid: (value: T) => boolean): Promise<T> {
  const entries = scope();
  if (!entries) return load();
  const existing = entries.get(key) as Promise<T> | undefined;
  if (existing) {
    const value = await existing;
    if (entries.get(key) === existing && valid(value)) return value;
    if (entries.get(key) !== existing) return requestMemo(key, load, valid);
    entries.delete(key);
  }
  const pending = load();
  entries.set(key, pending);
  try {
    const value = await pending;
    if (entries.get(key) !== pending) return requestMemo(key, load, valid);
    if (!valid(value)) { entries.delete(key); return load(); }
    return value;
  } catch (error) {
    if (entries.get(key) === pending) entries.delete(key);
    throw error;
  }
}
