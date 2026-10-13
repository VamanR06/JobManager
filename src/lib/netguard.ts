import dns from "dns/promises";
import net from "net";

/**
 * Outbound-fetch guard for user-supplied job links. Pasted URLs (and whatever
 * they redirect to) must only reach public internet hosts, never this machine,
 * the LAN, or cloud metadata endpoints. Each redirect hop is re-validated.
 *
 * Known limitation: DNS is resolved here and again by fetch, so a hostile DNS
 * server could rebind between the two. Acceptable for a single-user local tool.
 */

export class BlockedUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedUrlError";
  }
}

function v4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

const V4_BLOCKED: [string, number][] = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];

function isBlockedV4(ip: string): boolean {
  const n = v4ToInt(ip);
  return V4_BLOCKED.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (v4ToInt(base) & mask);
  });
}

/** Expands an IPv6 address to 8 hextets. */
function expandV6(ip: string): number[] {
  let addr = ip.toLowerCase();
  // Embedded dotted IPv4 tail (::ffff:1.2.3.4).
  const v4 = addr.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const n = v4ToInt(v4[1]);
    addr = addr.replace(v4[1], `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`);
  }
  const [head, tail] = addr.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined && tail ? tail.split(":") : [];
  const fill = tail !== undefined ? 8 - h.length - t.length : 0;
  return [...h, ...Array(fill).fill("0"), ...t].map((x) => parseInt(x || "0", 16));
}

function isBlockedV6(ip: string): boolean {
  const w = expandV6(ip);
  if (w.every((x) => x === 0)) return true; // ::
  if (w.slice(0, 7).every((x) => x === 0) && w[7] === 1) return true; // ::1
  if ((w[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((w[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  if ((w[0] & 0xff00) === 0xff00) return true; // multicast
  const embeddedV4 = () => `${w[6] >> 8}.${w[6] & 0xff}.${w[7] >> 8}.${w[7] & 0xff}`;
  // ::ffff:a.b.c.d mapped, and 64:ff9b::/96 NAT64 — judge by the IPv4 inside.
  if (w.slice(0, 5).every((x) => x === 0) && w[5] === 0xffff) return isBlockedV4(embeddedV4());
  if (w[0] === 0x64 && w[1] === 0xff9b && w.slice(2, 6).every((x) => x === 0)) return isBlockedV4(embeddedV4());
  return false;
}

export function isBlockedIp(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) return isBlockedV4(ip);
  if (kind === 6) return isBlockedV6(ip);
  return true;
}

export type Resolver = (host: string) => Promise<string[]>;

const defaultResolver: Resolver = async (host) =>
  (await dns.lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/** Throws BlockedUrlError unless the URL points at a public http(s) host on a standard port. */
export async function assertPublicUrl(raw: string | URL, resolve: Resolver = defaultResolver): Promise<URL> {
  const u = typeof raw === "string" ? new URL(raw) : raw;
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new BlockedUrlError("Only http(s) links are allowed");
  if (u.username || u.password) throw new BlockedUrlError("Links with credentials are not allowed");
  if (u.port && u.port !== "80" && u.port !== "443") throw new BlockedUrlError("Non-standard ports are not allowed");

  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || /\.(localhost|local|internal|home|lan|corp)$/.test(host)) {
    throw new BlockedUrlError("Local network hosts are not allowed");
  }
  let addrs: string[];
  if (net.isIP(host)) {
    addrs = [host];
  } else {
    try {
      addrs = await resolve(host);
    } catch {
      throw new BlockedUrlError(`Could not resolve ${host}`);
    }
  }
  if (!addrs.length || addrs.some(isBlockedIp)) {
    throw new BlockedUrlError("Link resolves to a private or local address");
  }
  return u;
}

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export interface SafeResponse {
  status: number;
  ok: boolean;
  /** Where the content actually came from after redirects. */
  finalUrl: string;
  /** Every URL visited, starting with the requested one. */
  chain: string[];
  contentType: string;
  body: string;
}

const MAX_BODY_BYTES = 5 * 1024 * 1024;

async function readCapped(res: Response, maxBytes: number): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("Response too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

type SafeFetchOptions = { accept?: string; timeoutMs?: number; maxRedirects?: number; maxBytes?: number; resolve?: Resolver };

/**
 * GET with manual redirects, validating every hop against the guard. Returns the
 * final body (capped) along with the redirect chain so both URLs can be stored.
 */
export async function safeFetch(url: string, opts: SafeFetchOptions = {}): Promise<SafeResponse> {
  const { bytes, ...rest } = await safeFetchBytes(url, opts);
  return { ...rest, body: bytes.toString("utf8") };
}

/** safeFetch for binary content (e.g. a PDF): the body as raw bytes. */
export async function safeFetchBytes(url: string, opts: SafeFetchOptions = {}): Promise<Omit<SafeResponse, "body"> & { bytes: Buffer }> {
  const chain: string[] = [];
  let current = url;
  const deadline = AbortSignal.timeout(opts.timeoutMs ?? 20_000);
  for (let hop = 0; hop <= (opts.maxRedirects ?? 5); hop++) {
    await assertPublicUrl(current, opts.resolve);
    chain.push(current);
    const res = await fetch(current, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: opts.accept ?? "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "manual",
      signal: deadline,
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      current = new URL(res.headers.get("location")!, current).toString();
      await res.body?.cancel();
      continue;
    }
    return {
      status: res.status,
      ok: res.ok,
      finalUrl: current,
      chain,
      contentType: res.headers.get("content-type") ?? "",
      bytes: await readCapped(res, opts.maxBytes ?? MAX_BODY_BYTES),
    };
  }
  throw new Error("Too many redirects");
}
