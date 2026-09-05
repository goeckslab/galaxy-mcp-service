import { createGalaxyContext } from "@galaxyproject/galaxy-ops";

export function createRequestGalaxyContext(
  connection: { baseUrl: string; apiKey: string; fetchImpl?: typeof fetch },
  signal: AbortSignal,
) {
  const fetchImpl = connection.fetchImpl ?? fetch;
  return createGalaxyContext({
    baseUrl: connection.baseUrl,
    apiKey: connection.apiKey,
    signal,
    fetchImpl: (input, init) => {
      const requestSignal = AbortSignal.any([
        signal,
        ...(input instanceof Request ? [input.signal] : []),
        ...(init?.signal ? [init.signal] : []),
        // Each HTTP exchange has a deadline; a job may still be polled for longer.
        AbortSignal.timeout(60_000),
      ]);
      requestSignal.throwIfAborted();
      return fetchImpl(input, { ...init, redirect: "error", signal: requestSignal });
    },
  });
}
