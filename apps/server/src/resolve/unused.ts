import type { ResolveDeps } from '../routes/resolve.ts'

const unused = (name: string) => () =>
  Promise.reject(new Error(`${name} is not stubbed in this test`))

/** For tests of other routes: resolve services that fail loudly if a request reaches them. */
export const UNUSED_RESOLVE_DEPS: ResolveDeps = {
  resolver: { resolve: unused('resolver.resolve') },
  enricher: { enrich: unused('enricher.enrich') },
}
