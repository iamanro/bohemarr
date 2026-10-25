import type { Catalogue, Program, Release } from '../src/types.ts';

interface FakeProgram extends Program {
  bound: boolean;
}

/**
 * An in-memory Catalogue: `listing()` is the provider's unbound catalogue (one Program per
 * `programId`, else per release), `listing(id)` the Releases of the bound Program `id`.
 */
export function fakeCatalogue(listing: (boundProgramId?: string) => Release[]): Catalogue<FakeProgram> {
  const programOf = (release: Release): FakeProgram => ({
    id: release.programId ?? release.id,
    title: release.series ?? release.title,
    kind: release.kind,
    bound: false,
  });
  return {
    async *programs() {
      const seen = new Set<string>();
      for (const release of listing()) {
        const program = programOf(release);
        if (!seen.has(program.id)) {
          seen.add(program.id);
          yield program;
        }
      }
    },
    async program(id) {
      return { id, title: id, bound: true };
    },
    async *releases(program) {
      if (program.bound) yield* listing(program.id);
      else yield* listing().filter(release => programOf(release).id === program.id);
    },
  };
}
