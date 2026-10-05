/** Every provider ID a factory can create; `createProviders` rejects an ID missing from this list. */
export const PROVIDER_IDS = [
  'ceskatelevize', 'streamcz', 'iprima', 'oneplay', 'novaplus', 'tncz', 'markizaplus', 'markizavoyo',
  'jojplay', 'sledovanitv', 'tvprimadoma', 'tvbarrandov', 'tvautosalon', 'stvr', 'html5', 'youtube', 'direct',
] as const;
