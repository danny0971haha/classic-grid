import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

const netLog = process.env.NETWORK_LOG;
const canaryRoot = process.env.CANARY_ROOT;
if (!canaryRoot) throw new Error("CANARY_ROOT_MISSING");

function allowedHost(host: string): boolean {
  const h = host.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "::1";
}

function recordNetwork(target: string): void {
  if (!netLog) return;
  try {
    fs.appendFileSync(netLog, `${target}\n`);
  } catch {
    /* ignore */
  }
}

function deny(target: string): never {
  recordNetwork(target);
  throw new Error(`UNEXPECTED_NETWORK:${target}`);
}

function hostFromUrl(value: string): string {
  try {
    return new URL(value).hostname;
  } catch {
    return value;
  }
}

const origFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const raw = typeof input === "string" || input instanceof URL ? String(input) : input.url;
  const host = hostFromUrl(raw);
  if (!allowedHost(host)) deny(`fetch:${host}`);
  return origFetch(input as never, init);
}) as typeof fetch;

function patchRequest(mod: typeof http | typeof https, label: string): void {
  const orig = mod.request;
  const origGet = mod.get;
  const wrapped = function (this: unknown, ...args: unknown[]) {
    const first = args[0];
    let host = "";
    if (typeof first === "string" || first instanceof URL) host = hostFromUrl(String(first));
    else if (first && typeof first === "object") {
      const opts = first as http.RequestOptions;
      host = String(opts.hostname || opts.host || "");
    }
    if (host && !allowedHost(host)) deny(`${label}:${host}`);
    return orig.apply(this, args as never);
  };
  (mod as { request: typeof orig }).request = wrapped as typeof orig;
  (mod as { get: typeof origGet }).get = function (this: unknown, ...args: unknown[]) {
    return wrapped.apply(this, args);
  } as typeof origGet;
}

patchRequest(http, "http");
patchRequest(https, "https");

const origConnect = net.connect;
const origCreateConnection = net.createConnection;
function wrapConnect(this: unknown, ...args: unknown[]) {
  const first = args[0];
  let host = "";
  if (typeof first === "number") host = String(args[1] || "");
  else if (typeof first === "string") host = first;
  else if (first && typeof first === "object") {
    const opts = first as net.TcpNetConnectOpts;
    host = String(opts.host || "");
  }
  if (host && !allowedHost(host)) deny(`net:${host}`);
  return origConnect.apply(this, args as never);
}
(net as { connect: typeof origConnect }).connect = wrapConnect as typeof origConnect;
(net as { createConnection: typeof origCreateConnection }).createConnection =
  wrapConnect as typeof origCreateConnection;

const entry = path.join(canaryRoot, "src/cli/run-extended-canary.ts");
if (!process.argv.includes("--once")) process.argv.push("--once");
await import(pathToFileURL(entry).href);
