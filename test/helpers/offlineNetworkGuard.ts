import dns from "node:dns";
import dnsPromises from "node:dns/promises";

const EXTENDED_HOSTS = new Set([
  "api.starknet.extended.exchange",
  "api.starknet.sepolia.extended.exchange",
  "starknet.sepolia.extended.exchange",
]);

export function installOfflineNetworkGuard(): () => void {
  const origFetch = globalThis.fetch;
  const origLookup = dns.lookup;
  const origLookupPromise = dnsPromises.lookup;

  globalThis.fetch = ((input: unknown) => {
    void input;
    return Promise.reject(new Error("TEST_NETWORK_GUARD_FETCH"));
  }) as typeof fetch;

  const guardedLookup = ((hostname: unknown, ...rest: unknown[]) => {
    if (EXTENDED_HOSTS.has(String(hostname))) {
      const err = new Error("TEST_NETWORK_GUARD_DNS");
      const cb = rest.find((item) => typeof item === "function") as
        | ((error: Error) => void)
        | undefined;
      if (cb) {
        cb(err);
        return;
      }
      throw err;
    }
    return (origLookup as (...args: unknown[]) => unknown)(hostname, ...rest);
  }) as typeof dns.lookup;
  dns.lookup = guardedLookup;

  dnsPromises.lookup = (async (hostname: unknown, options?: unknown) => {
    if (EXTENDED_HOSTS.has(String(hostname))) {
      throw new Error("TEST_NETWORK_GUARD_DNS");
    }
    return origLookupPromise(hostname as string, options as never);
  }) as typeof dnsPromises.lookup;

  return () => {
    globalThis.fetch = origFetch;
    dns.lookup = origLookup;
    dnsPromises.lookup = origLookupPromise;
  };
}
