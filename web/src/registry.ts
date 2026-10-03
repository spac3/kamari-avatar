/** Name -> factory registry for browser components. */
type Factory<T> = (options: Record<string, unknown>) => T;

const factories = new Map<string, Map<string, Factory<unknown>>>();

export function register<T>(kind: string, name: string, factory: Factory<T>): void {
  const impls = factories.get(kind) ?? new Map<string, Factory<unknown>>();
  if (impls.has(name)) throw new Error(`${kind} implementation "${name}" is already registered`);
  impls.set(name, factory);
  factories.set(kind, impls);
}

export function create<T>(kind: string, spec: { impl: string; options?: Record<string, unknown> }): T {
  const factory = factories.get(kind)?.get(spec.impl);
  if (!factory) {
    const known = [...(factories.get(kind)?.keys() ?? [])].sort().join(', ') || 'none';
    throw new Error(`no ${kind} implementation named "${spec.impl}" (known: ${known})`);
  }
  return factory(spec.options ?? {}) as T;
}

export function available(kind: string): string[] {
  return [...(factories.get(kind)?.keys() ?? [])].sort();
}
