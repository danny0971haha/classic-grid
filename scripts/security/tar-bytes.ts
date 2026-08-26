import { gunzipSync, gzipSync } from "node:zlib";

export type TarType = "file" | "hardlink" | "symlink" | "directory" | "device" | "fifo" | "other";

export type TarEntry = {
  name: string;
  type: TarType;
  typeflag: string;
  mode: number;
  size: number;
  linkname: string;
  data: Buffer;
};

const TYPE_MAP: Record<string, TarType> = {
  "0": "file",
  "\0": "file",
  "1": "hardlink",
  "2": "symlink",
  "3": "device",
  "4": "device",
  "5": "directory",
  "6": "fifo",
};

function readCString(buf: Buffer, start: number, len: number): string {
  const slice = buf.subarray(start, start + len);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? len : end).toString("utf8");
}

function readOctal(buf: Buffer, start: number, len: number): number {
  const raw = readCString(buf, start, len).replace(/^[0\s]+/, "").trim();
  if (!raw) return 0;
  return Number.parseInt(raw, 8);
}

function writeOctal(value: number, len: number): Buffer {
  const body = value.toString(8).padStart(len - 1, "0");
  const out = Buffer.alloc(len, 0);
  Buffer.from(`${body} `).copy(out);
  return out;
}

function checksumHeader(header: Buffer): number {
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += header[i] ?? 0;
  return sum;
}

function typeFromFlag(flag: string): TarType {
  return TYPE_MAP[flag] ?? "other";
}

export function parseTarBuffer(buf: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  let pendingLongName: string | undefined;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const typeflag = String.fromCharCode(header[156] ?? 0);
    const size = readOctal(header, 124, 12);
    const mode = readOctal(header, 100, 8);
    const linkname = readCString(header, 157, 100);
    const name = readCString(header, 0, 100);
    const prefix = readCString(header, 345, 155);
    let fullName = prefix ? `${prefix}/${name}` : name;
    if (pendingLongName) {
      fullName = pendingLongName;
      pendingLongName = undefined;
    }
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    const data = buf.subarray(dataStart, Math.min(dataEnd, buf.length));
    offset = dataStart + Math.ceil(size / 512) * 512;
    if (typeflag === "L") {
      pendingLongName = readCString(data, 0, data.length);
      continue;
    }
    if (typeflag === "x" || typeflag === "g") continue;
    entries.push({
      name: fullName,
      type: typeFromFlag(typeflag),
      typeflag: typeflag === "\0" ? "0" : typeflag,
      mode,
      size,
      linkname,
      data: Buffer.from(data),
    });
  }
  return entries;
}

export function parseTgzBuffer(tgz: Buffer): TarEntry[] {
  return parseTarBuffer(gunzipSync(tgz));
}

function writeHeader(p: {
  name: string;
  typeflag: string;
  mode: number;
  size: number;
  linkname?: string;
}): Buffer {
  const header = Buffer.alloc(512, 0);
  const name = p.name.length > 100 ? p.name.slice(0, 100) : p.name;
  Buffer.from(name).copy(header, 0);
  writeOctal(p.mode, 8).copy(header, 100);
  writeOctal(0, 8).copy(header, 108);
  writeOctal(0, 8).copy(header, 116);
  writeOctal(p.size, 12).copy(header, 124);
  writeOctal(Math.floor(Date.now() / 1000), 12).copy(header, 136);
  header.fill(0x20, 148, 156);
  header[156] = p.typeflag.charCodeAt(0);
  if (p.linkname) Buffer.from(p.linkname).copy(header, 157);
  Buffer.from("ustar\0").copy(header, 257);
  Buffer.from("00").copy(header, 263);
  const sum = checksumHeader(header);
  Buffer.from(sum.toString(8).padStart(6, "0") + "\0 ").copy(header, 148);
  return header;
}

export function buildTarBuffer(entries: Array<{
  name: string;
  typeflag?: string;
  mode?: number;
  data?: Buffer | string;
  linkname?: string;
}>): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data)
      ? entry.data
      : Buffer.from(entry.data ?? "", "utf8");
    const typeflag = entry.typeflag ?? "0";
    const size = typeflag === "0" || typeflag === "\0" ? data.length : 0;
    chunks.push(
      writeHeader({
        name: entry.name,
        typeflag,
        mode: entry.mode ?? 0o644,
        size,
        linkname: entry.linkname,
      }),
    );
    if (size > 0) {
      chunks.push(data);
      const pad = (512 - (size % 512)) % 512;
      if (pad) chunks.push(Buffer.alloc(pad, 0));
    }
  }
  chunks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(chunks);
}

export function buildTgzBuffer(
  entries: Array<{
    name: string;
    typeflag?: string;
    mode?: number;
    data?: Buffer | string;
    linkname?: string;
  }>,
): Buffer {
  return gzipSync(buildTarBuffer(entries));
}

export function modeString(mode: number): string {
  return (mode & 0o777).toString(8).padStart(4, "0");
}
