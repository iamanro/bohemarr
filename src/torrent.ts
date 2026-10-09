import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

type BValue = number | Buffer | BValue[] | { [key: string]: BValue };

const RELEASE_KEY = 'x-bohemarr-release';
const SIGNATURE_KEY = 'x-bohemarr-signature';
const MAX_DEPTH = 32;

/** A Task descriptor: a signed .torrent that names one Release and carries no content of its own. */
export interface TaskTorrent {
  content: Buffer;
  /** Lowercase hex SHA-1 of the bencoded info dictionary, which Sonarr and Radarr use as the download ID. */
  infoHash: string;
}

export function encode(value: BValue): Buffer {
  const parts: Buffer[] = [];
  const write = (item: BValue): void => {
    if (typeof item === 'number') {
      if (!Number.isSafeInteger(item)) throw new Error('Bencoded integers must be safe integers');
      parts.push(Buffer.from(`i${item}e`));
    } else if (Buffer.isBuffer(item)) {
      parts.push(Buffer.from(`${item.length}:`), item);
    } else if (Array.isArray(item)) {
      parts.push(Buffer.from('l'));
      for (const child of item) write(child);
      parts.push(Buffer.from('e'));
    } else {
      parts.push(Buffer.from('d'));
      // Keys are raw byte strings sorted by their bytes, which BEP 3 requires for a canonical info hash.
      const keys = Object.keys(item).map(key => Buffer.from(key, 'latin1')).sort(Buffer.compare);
      for (const key of keys) {
        write(key);
        write(item[key.toString('latin1')]!);
      }
      parts.push(Buffer.from('e'));
    }
  };
  write(value);
  return Buffer.concat(parts);
}

/** Decodes one bencoded top-level dictionary and returns it with the raw bytes of its `info` value. */
function decodeTorrent(content: Buffer): { torrent: Record<string, BValue>; info: Buffer } {
  let position = 0;
  let info: Buffer | undefined;
  const fail = (): never => { throw new Error('Invalid torrent file'); };
  const digits = (end: number): number => {
    const text = content.toString('latin1', position, end);
    if (!/^(0|-?[1-9]\d*)$/.test(text)) fail();
    const result = Number(text);
    if (!Number.isSafeInteger(result)) fail();
    return result;
  };
  const read = (depth: number): BValue => {
    if (depth > MAX_DEPTH || position >= content.length) fail();
    const marker = content[position]!;
    if (marker === 0x69) { // i
      const end = content.indexOf(0x65, ++position);
      if (end < 0) fail();
      const result = digits(end);
      position = end + 1;
      return result;
    }
    if (marker === 0x6c) { // l
      position++;
      const list: BValue[] = [];
      while (content[position] !== 0x65) list.push(read(depth + 1));
      position++;
      return list;
    }
    if (marker === 0x64) { // d
      position++;
      const dict: Record<string, BValue> = Object.create(null);
      while (content[position] !== 0x65) {
        const key = read(depth + 1);
        if (!Buffer.isBuffer(key)) fail();
        const name = (key as Buffer).toString('latin1');
        const start = position;
        dict[name] = read(depth + 1);
        if (depth === 0 && name === 'info') info = content.subarray(start, position);
      }
      position++;
      return dict;
    }
    const colon = content.indexOf(0x3a, position);
    if (colon < 0) fail();
    const length = digits(colon);
    if (length < 0 || colon + 1 + length > content.length) fail();
    position = colon + 1 + length;
    return content.subarray(colon + 1, position);
  };
  const torrent = read(0);
  if (position !== content.length || Buffer.isBuffer(torrent) || Array.isArray(torrent) || typeof torrent !== 'object' || !info) fail();
  return { torrent: torrent as Record<string, BValue>, info: info! };
}

function infoDictionary(releaseId: string, name: string): Record<string, BValue> {
  // One one-byte piece: a structurally valid single-file torrent whose identity is the Release and its title.
  return {
    length: 1, name: Buffer.from(name), 'piece length': 16384,
    pieces: createHash('sha1').update(releaseId).digest(), private: 1,
    [RELEASE_KEY]: Buffer.from(releaseId),
  };
}

function sign(secret: string, infoHash: string): Buffer {
  return createHmac('sha256', secret).update(infoHash).digest();
}

/** The lowercase hex v1 info hash of any .torrent. */
export function infoHashOf(content: Buffer): string {
  return createHash('sha1').update(decodeTorrent(content).info).digest('hex');
}

/** The info hash of the Task descriptor for a Release published under `name`. */
export function taskInfoHash(releaseId: string, name: string): string {
  return createHash('sha1').update(encode(infoDictionary(releaseId, name))).digest('hex');
}

export function createTaskTorrent(releaseId: string, name: string, secret: string): TaskTorrent {
  const infoHash = taskInfoHash(releaseId, name);
  const content = encode({
    'created by': Buffer.from('Bohemarr'), info: infoDictionary(releaseId, name),
    [SIGNATURE_KEY]: Buffer.from(sign(secret, infoHash).toString('hex')),
  });
  return { content, infoHash };
}

/** The Release ID and info hash of a Task descriptor signed by this instance; rejects foreign or altered torrents. */
export function parseTaskTorrent(content: Buffer, secret: string): { releaseId: string; infoHash: string } {
  const { torrent, info } = decodeTorrent(content);
  const fields = torrent.info as Record<string, BValue>;
  const releaseId = fields[RELEASE_KEY];
  const signature = torrent[SIGNATURE_KEY];
  if (!Buffer.isBuffer(releaseId) || !Buffer.isBuffer(signature) || !/^[a-f0-9]{64}$/.test(signature.toString('latin1'))) {
    throw new Error('Only task torrents from this Bohemarr instance are supported; this is not a BitTorrent client');
  }
  const infoHash = createHash('sha1').update(info).digest('hex');
  if (!timingSafeEqual(Buffer.from(signature.toString('latin1'), 'hex'), sign(secret, infoHash))) throw new Error('Invalid task torrent signature');
  return { releaseId: releaseId.toString('utf8'), infoHash };
}
