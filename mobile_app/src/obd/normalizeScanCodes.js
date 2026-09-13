/**
 * Turn raw scanner output into the exact list the UI renders.
 *
 * This lived inline inside TelemetryContext.scanErrors(), which meant the stage
 * standing between the decoder and the user's screen was the one stage no test
 * could reach — a scan could be provably correct in `dtcScanner` and still show
 * something else on the phone. It is a pure function now so the end-to-end test
 * drives the same code the app does.
 *
 * Keep it free of React and of module state: given the same scan result it must
 * always produce the same errors array.
 */

/** ISO 14229-1 §D.3 status byte → the two buckets the UI renders.
 *
 * Kept in step with parseDtcStatusByte() in dtcScanner.js. A code that is
 * failing right now but not yet confirmed is still active: the test car's
 * thermostat reports 0x27 that way, and calling that merely "pending" understated
 * a fault the driver could feel. Only codes with no current-failure bit at all
 * (e.g. 0x20 — failed some time since the last clear) fall through to history.
 */
export function dtcStatusCategory(statusByte) {
  if (statusByte === null || statusByte === undefined) return 'active';
  if (statusByte & 0x01) return 'active';   // bit 0: test currently failing
  if (statusByte & 0x02) return 'active';   // bit 1: failed this drive cycle
  if (statusByte & 0x04) return 'active';   // bit 2: pending DTC
  if (statusByte & 0x08) return 'active';   // bit 3: confirmed DTC
  return 'historic';
}

export function classifyDtcSeverity(code) {
  if (!code) return 'Невідомо';
  const prefix = code.substring(0, 3);
  if (prefix === 'P03') return 'Високий';
  if (prefix === 'P01' || prefix === 'P02') return 'Середній';
  return 'Низький';
}

export function estimateDtcCost(code) {
  if (!code) return 'Невідомо';
  const prefix = code.substring(0, 3);
  if (prefix === 'P03') return '₴1500 – ₴5000';
  if (prefix === 'P02') return '₴500 – ₴3000';
  if (prefix === 'P01') return '₴300 – ₴2000';
  return '₴200 – ₴1500';
}

// Lower number = higher priority. Names must match what index.js sets in
// method.name (legacy path) — the full scan sets richer labels that fall
// through to 99, which is fine: it only breaks ties between two sightings of
// the SAME base code.
const VARIANT_PRIORITY = {
  'Mode 03': 0,
  'Mode UDS 09': 1,
  'Mode UDS 08': 1,
  'Mode UDS 01': 1,
  'Mode UDS 04': 1,
  'Mode 07': 2,
  'Mode 0A': 3,
  'KWP 00': 4,
  'KWP FF': 4,
};

/**
 * @param {Array} rawCodes      result.codes from DtcScanRunner / smartReadDTC
 * @param {Object} dtcDictionary  codes.json
 * @param {string} scanVariant  result.variant, used when a code carries none
 * @param {Function} [log]      optional sink for dropped-code diagnostics
 * @returns {Array} the errors array the UI consumes
 */
export function normalizeScanCodes(rawCodes, dtcDictionary = {}, scanVariant = '', log = () => {}) {
  return (rawCodes || [])
    // ── 1. Structural validity only ──────────────────────────────────────────
    // This used to drop every code missing from the local dictionary, which
    // silently discarded exactly the manufacturer-specific codes (P1xxx/B1xxx/
    // U1xxx) that a brand like Mercedes stores its thermostat and charging
    // faults under. A code the ECU reports is real whether or not we happen to
    // have a description for it — show it, and label it.
    .filter(codeItem => {
      const base = codeItem.base || codeItem.code;
      const ok = /^[PCBU][0-3][0-9A-F]{3}$/.test(base);
      if (!ok) log(`[DTC] Dropping structurally invalid: ${base}`);
      return ok;
    })
    // ── 2. Deduplicate — keep highest-priority source per base code ──────────
    .reduce((acc, codeItem) => {
      const existing = acc.find(e => e.base === codeItem.base);
      if (!existing) {
        acc.push(codeItem);
      } else {
        const newP = VARIANT_PRIORITY[codeItem.variant] ?? 99;
        const exstP = VARIANT_PRIORITY[existing.variant] ?? 99;
        if (newP < exstP) acc[acc.indexOf(existing)] = codeItem;
      }
      return acc;
    }, [])
    // ── 3. Map to final shape ────────────────────────────────────────────────
    .map(codeItem => {
      const baseCode = codeItem.base;
      const v = codeItem.variant ?? '';

      /**
       * Protocol-level status takes precedence over the UDS status byte:
       *   full scan → statusCategory already derived from the status byte
       *   Mode 07   → pending (failed this drive cycle)
       *   Mode 0A   → permanent (survives Mode 04 clear)  → historic
       *   Mode 03 / KWP → confirmed active in ECU memory  → active
       *   otherwise → UDS status byte bitmask (ISO 14229-1)
       */
      let statusCategory;
      if (codeItem.statusCategory) {
        statusCategory = codeItem.statusCategory;
      } else if (v.includes('Mode 07')) {
        statusCategory = 'active';   // failed this drive cycle — happening now
      } else if (v.includes('Mode 0A')) {
        statusCategory = 'historic';
      } else if (v.includes('Mode 03') || v.includes('KWP')) {
        statusCategory = 'active';
      } else {
        statusCategory = dtcStatusCategory(codeItem.statusByte ?? null);
      }

      const isKnown = !!dtcDictionary[baseCode];
      return {
        code: codeItem.code,
        title: isKnown ? codeItem.title : `Код виробника ${baseCode}`,
        desc: codeItem.ecu
          ? `${codeItem.ecu} · ${codeItem.variant || scanVariant}`
          : `Протокол: ${codeItem.variant || scanVariant}`,
        severity: classifyDtcSeverity(baseCode),
        cost: estimateDtcCost(baseCode),
        statusCategory,
        statusByte: codeItem.statusByte ?? null,
        ecu: codeItem.ecu ?? null,
        ecuAddress: codeItem.ecuAddress ?? null,
        isManufacturerCode: !isKnown,
      };
    });
}
