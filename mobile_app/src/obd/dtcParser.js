/**
 * obd/dtcParser.js — pure DTC parsing/validation helpers, no BLE/Capacitor deps.
 * Split out of obd/index.js so this logic can be unit-tested directly (see
 * obd/__tests__/dtcParser.test.mjs) without needing a Capacitor runtime.
 */

// Ghost codes that are ALWAYS padding / J1979 artefacts — never real faults
export const GHOST_CODES = new Set([
  'P0000','C0000','B0000','U0000',
  'C0300','C0700','C0A00',
]);

// DTC codes are 5 chars total: letter + digit(0-3) + 3 more hex chars
// (e.g. "P0597" = P,0,5,9,7). Kept in sync with decoders.js dtc_uds's own check.
export function isStructurallyValidDtc(baseCode) {
  if (GHOST_CODES.has(baseCode))                  return false;
  if (/^[PCBU]0{4}$/.test(baseCode))              return false;
  if (!/^[PCBU][0-3][0-9A-F]{3}$/.test(baseCode)) return false;
  const numericPart = baseCode.substring(1);
  if (numericPart === '0000' || numericPart === 'FFFF') return false;
  return true;
}

// Turns a raw multi-line adapter response into one concatenated hex string,
// stripping ISO-TP frame sequence numbers (e.g. "1:", "2:", "A:").
export function assembleHexPayload(response) {
  const lines = response
    .split(/[\r\n]+/)
    .map(l => l.replace(/[\s>]/g, '').toUpperCase());

  let fullHexPayload = '';
  for (let line of lines) {
    if (!line) continue;
    line = line.replace(/^[0-9A-F]{1,2}:/, '');
    fullHexPayload += line;
  }
  return fullHexPayload;
}

// Strips genuine 7F<svc><nrc> negative-response markers from a multi-ECU
// payload (e.g. "5902FF5902FF7F197859027F"), leaving anything that merely
// looks like 0x7F but isn't a recognized NRC (could be real data) untouched.
export function stripNegativeResponses(hexPayload) {
  return hexPayload.replace(/7F[0-9A-F]{2}[0-9A-F]{2}/g, (match) => {
    const nrc = match.substring(4, 6);
    const VALID_NRCS = new Set(['10','11','12','13','14','21','22','24','25','26','27',
                                 '28','29','2A','2B','2C','2D','2E','31','33','35','37',
                                 '38','39','3A','3B','3C','3D','3E','3F','70','71','72',
                                 '73','74','78','7E','7F']);
    return VALID_NRCS.has(nrc) ? '' : match;
  });
}

// Mode 03 / 07 / 0A: parse each ECU's block independently, union + dedup.
export function parseLegacyModeDtc(cmd, fullHexPayload, decoderFunc) {
  const expectedPrefix = '4' + cmd.charAt(1);
  let idx = fullHexPayload.indexOf(expectedPrefix);
  if (idx === -1) return null;

  const perEcuCodes = [];

  while (idx !== -1) {
    const nextIdx = fullHexPayload.indexOf(expectedPrefix, idx + 2);
    let ecuRaw    = nextIdx !== -1
      ? fullHexPayload.substring(idx + 2, nextIdx)
      : fullHexPayload.substring(idx + 2);

    if (ecuRaw.length % 2 !== 0) ecuRaw = ecuRaw.substring(1);

    const ecuCodes = decoderFunc(ecuRaw);
    if (Array.isArray(ecuCodes)) perEcuCodes.push(ecuCodes);

    idx = nextIdx;
  }

  if (perEcuCodes.length === 0) return null;

  const seen    = new Set();
  const unified = [];
  for (const list of perEcuCodes) {
    for (const code of list) {
      if (!seen.has(code)) { seen.add(code); unified.push(code); }
    }
  }
  return unified;
}

// UDS (19xx) and KWP (18xx): pass full payload, dedup by base code.
export function parseUdsKwpDtc(fullHexPayload, decoderFunc) {
  const decoded = decoderFunc(fullHexPayload);
  if (!Array.isArray(decoded)) return null;

  const seen   = new Set();
  return decoded.filter(item => {
    const key = typeof item === 'object' ? item.base : item;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}
