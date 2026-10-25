/** Widevine system ID per the DASH-IF/CENC content protection registry (no dashes, lowercase hex). */
const WIDEVINE_SYSTEM_ID = 'edef8ba979d64acea3c827dcd51d21ed';

const CONTAINER_BOX_TYPES: Record<string, true> = {
  moov: true,
  trak: true,
  mdia: true,
  minf: true,
  stbl: true,
  moof: true,
  traf: true,
  mvex: true,
  edts: true,
  udta: true,
  meta: true,
  mfra: true,
};

function scanBoxes(buffer: Buffer, start: number, end: number, results: Buffer[]): void {
  let offset = start;
  while (offset + 8 <= end) {
    const declaredSize = buffer.readUInt32BE(offset);
    let size = declaredSize;
    let headerSize = 8;
    if (declaredSize === 1) {
      if (offset + 16 > end) break;
      size = Number(buffer.readBigUInt64BE(offset + 8));
      headerSize = 16;
    } else if (declaredSize === 0) {
      // Per ISO-BMFF, size 0 means "box extends to the end of the enclosing container" (only valid
      // for the last box in that container).
      size = end - offset;
    }
    if (size < headerSize || offset + size > end) break;
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (type === 'pssh') results.push(buffer.subarray(offset, offset + size));
    else if (CONTAINER_BOX_TYPES[type]) scanBoxes(buffer, offset + headerSize, offset + size, results);
    offset += size;
  }
}

/** Recursively scans an ISO-BMFF buffer (e.g. a DASH/HLS fMP4 initialization segment) for Widevine `pssh` boxes. */
export function findWidevinePsshBoxes(buffer: Buffer): string[] {
  const boxes: Buffer[] = [];
  scanBoxes(buffer, 0, buffer.length, boxes);
  const widevineBoxes = boxes.filter(box => box.length >= 28 && box.subarray(12, 28).toString('hex') === WIDEVINE_SYSTEM_ID);
  return widevineBoxes.map(box => box.toString('base64'));
}
