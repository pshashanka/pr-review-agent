/** Narrows a state channel that an earlier node must have set. A miss is a wiring bug. */
export function requireValue<T>(value: T | null, name: string): T {
  if (value === null) throw new Error(`Graph invariant violated: ${name} is not set.`);
  return value;
}
