// Shared map for resolving analytics.* name drifts against master_managers.
// Three known variants the integrator's MySQL feed uses vs our canonical form:
//   - Maksim → Latin spelling
//   - Сираждинова → Latin "C" in the Cyrillic name
//   - Єлизавета → Ukrainian "Є" vs Russian "Е"
// Keep this as the SINGLE source of truth. build-response.ts and
// analytics-calls.ts both import from here.

export const NAME_ALIASES: Record<string, string[]> = {
  "Максим Алекперов": ["Maksim Alekperov"],
  "Гульназ Сираждинова": ["Гульназ Cираждинова"],
  "Елизавета Трапезникова": ["Єлизавета Трапезникова"],
};

/** Resolve an analytics-side name map into a master_managers.id map using the
 *  shared alias table. Returns a new Map keyed by master id. */
export function resolveByAlias<T>(
  managers: ReadonlyArray<{ id: string; name: string }>,
  byName: ReadonlyMap<string, T>,
): Map<string, T> {
  const byMaster = new Map<string, T>();
  for (const m of managers) {
    let v = byName.get(m.name);
    if (v === undefined) {
      for (const alias of NAME_ALIASES[m.name] ?? []) {
        const hit = byName.get(alias);
        if (hit !== undefined) { v = hit; break; }
      }
    }
    if (v !== undefined) byMaster.set(m.id, v);
  }
  return byMaster;
}
