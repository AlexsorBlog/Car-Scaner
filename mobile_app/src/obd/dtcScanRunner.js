/**
 * obd/dtcScanRunner.js — drives a full multi-ECU DTC scan over an ELM327.
 *
 * Takes `sendCommand` by injection (no BLE import) so the entire flow can be
 * exercised against a mock adapter in tests. See dtcScanner.js for the protocol
 * constants and pure decoders, and __tests__/dtcScanner.test.mjs for the
 * simulated-car tests.
 *
 * Scan shape:
 *   1. establishProtocol  — reset, headers ON, auto-detect, wait for the search
 *   2. discoverEcus       — functional broadcast, then targeted probing
 *   3. per ECU            — generic OBD → UDS (session first) → KWP
 *   4. merge              — dedupe by code, keep the richest status, attribute
 *                           every code to the module that reported it
 *
 * Everything is strictly sequential: bleService.js keeps only ONE in-flight
 * command slot and silently drops whatever was pending when a new command is
 * written, so overlapping requests corrupt both responses.
 */

import {
  FUNCTIONAL_11BIT,
  FUNCTIONAL_29BIT,
  STANDARD_11BIT_REQUESTS,
  EXTENDED_11BIT_REQUESTS,
  ECU_NAMES,
  UDS_SESSION,
  DTC_REPORT,
  KWP_SERVICE,
  NRC,
  PROTOCOLS,
  protocolById,
  build29BitRequest,
  splitByEcuHeader,
  readNegativeResponse,
  decodeUdsDtcResponse,
  decodeLegacyDtcResponse,
  decodeKwpDtcResponse,
  decodeJ1939Dtcs,
  extractRespondingEcus,
  sanitizeResponse,
  isFlowControlOnly,
  formatDtcWithFtb,
  decodeMilStatus,
  decodeFreezeFrameDtc,
  decodeUdsDtcCount,
  decodeMode06Results,
} from './dtcScanner.js';
import { DiagnosticLog } from './diagnosticLog.js';

const isBadResponse = (r) => sanitizeResponse(r) === null;

// Plain-language NRC names, so a log reader doesn't need the ISO 14229 table
// open to understand why a module refused a request.
const NRC_MEANING = {
  0x11: 'serviceNotSupported',
  0x12: 'subFunctionNotSupported',
  0x13: 'incorrectMessageLength',
  0x22: 'conditionsNotCorrect (session/state required)',
  0x31: 'requestOutOfRange',
  0x33: 'securityAccessDenied',
  0x78: 'responsePending',
  0x7E: 'subFunctionNotSupportedInActiveSession',
  0x7F: 'serviceNotSupportedInActiveSession',
};

export class DtcScanRunner {
  /**
   * @param {(cmd: string) => Promise<string>} sendCommand
   * @param {{ log?: Function, onProgress?: Function, deepScan?: boolean }} opts
   */
  constructor(sendCommand, opts = {}) {
    this._send = sendCommand;
    this._log = opts.log || (() => {});
    this._onProgress = opts.onProgress || (() => {});
    // Deep scan also probes manufacturer-specific headers, which is where
    // body/chassis faults (thermostat, battery/charging) usually live. Costs
    // extra time, so it's opt-in from the UI.
    this._deepScan = opts.deepScan !== false;
    this._protocol = null;
    // Structured session log — every command, verbatim response, adapter state
    // and timing. Exportable as a replay fixture (see diagnosticLog.js).
    // Distinct from `opts.log`, which is just a text-line callback.
    this.log = opts.diagnosticLog instanceof DiagnosticLog
      ? opts.diagnosticLog
      : new DiagnosticLog();
    // Modules that told us how many faults they hold (UDS 19 01), used to spot
    // "the car has codes we couldn't read" vs "the car is actually clean".
    this._reportedCounts = [];
  }

  async _cmd(command, { settle = 0 } = {}) {
    const t0 = Date.now();
    try {
      const res = await this._send(command);
      const raw = res || '';
      // Record the exchange verbatim, with the adapter state the log infers
      // from the command stream, so the session can be replayed later.
      this.log?.record({
        cmd: command,
        raw,
        ms: Date.now() - t0,
        sanitized: sanitizeResponse(raw, command),
        outcome: sanitizeResponse(raw, command) ? 'ok' : 'rejected',
        detail: sanitizeResponse(raw, command) ? null : 'no usable payload',
      });
      if (settle) await new Promise((r) => setTimeout(r, settle));
      return raw;
    } catch (err) {
      this.log?.record({
        cmd: command, raw: '', ms: Date.now() - t0,
        outcome: 'error', detail: err.message,
      });
      this._log(`[scan] ${command} failed: ${err.message}`);
      return '';
    }
  }

  // ── 1. Protocol ───────────────────────────────────────────────────────────

  async establishProtocol() {
    await this._cmd('ATZ', { settle: 1200 });
    await this._cmd('ATE0', { settle: 100 });
    await this._cmd('ATL0', { settle: 100 });
    await this._cmd('ATS0', { settle: 100 });
    // Headers ON — without this every ECU's reply looks identical and there is
    // no way to attribute a code to a module. This is the single most important
    // difference from the old scanner.
    await this._cmd('ATH1', { settle: 100 });
    await this._cmd('ATCAF1', { settle: 100 }); // adapter builds ISO-TP framing
    await this._cmd('ATAT2', { settle: 100 });  // adaptive timing, max wait
    await this._cmd('ATST64', { settle: 100 }); // ~400ms per-request timeout
    await this._cmd('ATSP0', { settle: 200 });  // auto-detect protocol

    // ATSP0 doesn't search on the AT command — it searches on the first real
    // request, which can take seconds. Firing the next command mid-search
    // aborts it ("STOPPED"), so give it room and retry.
    for (let i = 0; i < 4; i++) {
      const res = await this._cmd('0100');
      if (sanitizeResponse(res, '0100')?.includes('4100')) {
        this._protocol = (await this._cmd('ATDPN')).replace(/[\s\r\n>]/g, '');
        this._log(`[scan] protocol established via auto-detect (ATDPN=${this._protocol})`);
        return true;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }

    // Auto-detect failed. Walk the protocol ladder explicitly — ATTP tries a
    // protocol without committing, so a wrong guess doesn't strand us. This is
    // what rescues older ISO 9141 / KWP / J1850 cars that ATSP0 gives up on.
    this._log('[scan] auto-detect failed; trying protocols explicitly');
    for (const proto of PROTOCOLS) {
      await this._cmd(`ATTP${proto.id}`, { settle: 150 });
      const res = sanitizeResponse(await this._cmd('0100'), '0100');
      if (res?.includes('4100')) {
        this._protocol = proto.id;
        this._protocolInfo = proto;
        this._log(`[scan] protocol ${proto.id} (${proto.name}) responded`);
        await this._cmd(`ATSP${proto.id}`, { settle: 150 }); // commit to it
        return true;
      }
      // J1939 rigs never answer 0100 — probe them with a DM1 request instead.
      if (proto.j1939) {
        const dm1 = sanitizeResponse(await this._cmd('ATDM1'), 'ATDM1');
        if (dm1) {
          this._protocol = proto.id;
          this._protocolInfo = proto;
          this._log('[scan] J1939 bus detected via DM1');
          await this._cmd(`ATSP${proto.id}`, { settle: 150 });
          return true;
        }
      }
    }

    this._log('[scan] no protocol confirmed; continuing best-effort');
    return false;
  }

  /** Protocol metadata for the currently negotiated protocol, if known. */
  get _proto() {
    return this._protocolInfo || protocolById(this._protocol) || null;
  }

  // ── 2. ECU discovery ──────────────────────────────────────────────────────

  async discoverEcus() {
    const found = new Map(); // request addr → { request, response, name }

    const add = (req, res) => {
      const key = req.toUpperCase();
      if (!found.has(key)) {
        found.set(key, { request: key, response: res, name: ECU_NAMES[key] || `Модуль ${key}` });
      }
    };

    // Functional broadcast: every emissions-capable module answers 0100 at once,
    // and with headers on we learn all their addresses from a single request.
    await this._cmd(`ATSH${FUNCTIONAL_11BIT}`);
    const broadcast = await this._cmd('0100');
    for (const ecu of extractRespondingEcus(broadcast)) add(ecu.request, ecu.response);
    this._log(`[scan] broadcast found ${found.size} module(s)`);

    // Some modules ignore functional addressing, so probe the standard physical
    // range directly with a tester-present ping (cheap, universally supported).
    for (const addr of STANDARD_11BIT_REQUESTS) {
      if (found.has(addr)) continue;
      await this._cmd(`ATSH${addr}`);
      const res = await this._cmd('3E00');
      if (!isBadResponse(res) && /7E|18DA/i.test(res)) {
        const blocks = splitByEcuHeader(res);
        add(addr, Object.keys(blocks)[0] || null);
      }
    }

    // Manufacturer/body modules — where thermostat & charging faults live.
    if (this._deepScan) {
      for (const addr of EXTENDED_11BIT_REQUESTS) {
        if (found.has(addr)) continue;
        await this._cmd(`ATSH${addr}`);
        const res = await this._cmd('3E00');
        if (!isBadResponse(res) && Object.keys(splitByEcuHeader(res)).length > 0) {
          add(addr, null);
        }
      }
    }

    // 29-bit addressing (ISO 15765-4 extended). Used by many commercial and
    // some passenger vehicles; the old scanner never touched it at all, so any
    // car on 29-bit was completely invisible to it. Request ids are 18DAxxF1.
    const proto = this._proto;
    if (proto?.bits === 29 || (this._deepScan && proto?.can)) {
      await this._cmd(`ATSH${FUNCTIONAL_29BIT}`);
      const bc29 = await this._cmd('0100');
      for (const ecu of extractRespondingEcus(bc29)) add(ecu.request, ecu.response);

      // Standard 29-bit targets: engine 00, transmission 03, ABS 28, body 40.
      for (const target of [0x00, 0x01, 0x03, 0x07, 0x0E, 0x17, 0x28, 0x33, 0x37, 0x40]) {
        const addr = build29BitRequest(target);
        if (found.has(addr)) continue;
        await this._cmd(`ATSH${addr}`);
        const res = await this._cmd('3E00');
        if (!isBadResponse(res) && Object.keys(splitByEcuHeader(res)).length > 0) {
          add(addr, null);
        }
      }
    }

    // Never come back empty — fall back to the engine ECU so a scan still runs.
    if (found.size === 0) add('7E0', '7E8');

    this._log(`[scan] ${found.size} module(s) total: ${[...found.keys()].join(', ')}`);
    return [...found.values()];
  }

  // ── 3. Per-ECU interrogation ──────────────────────────────────────────────

  /**
   * Turn one raw adapter reply into clean per-ECU payloads, dropping anything
   * that isn't real data. Every read path goes through here so no decoder ever
   * sees an echo, a status word, a flow-control frame or pad bytes.
   */
  _payloads(raw, cmd) {
    const cleaned = sanitizeResponse(raw, cmd);
    if (!cleaned) return [];
    const blocks = splitByEcuHeader(raw);
    const list = Object.keys(blocks).length ? Object.values(blocks) : [cleaned];
    return list
      .map((p) => (p || '').replace(/[^0-9A-F]/gi, '').toUpperCase())
      .filter((p) => p.length >= 4 && !isFlowControlOnly(p) && !/^(AA)+$/.test(p) && !/^0+$/.test(p));
  }

  /**
   * Mode 01 PID 01 — MIL lamp, confirmed-DTC count and readiness monitors.
   * Read BEFORE the code reads so we can tell "genuinely healthy" apart from
   * "has faults we failed to reach", which the old scanner reported identically.
   */
  async _readMilStatus() {
    const raw = await this._cmd('0101');
    for (const payload of this._payloads(raw, '0101')) {
      const status = decodeMilStatus(payload);
      if (status) {
        this._log(`[scan] MIL=${status.milOn ? 'ON' : 'off'} dtcCount=${status.dtcCount}`);
        return status;
      }
    }
    return null;
  }

  /** Mode 02 — which DTC caused the stored freeze frame. */
  async _readFreezeFrameDtc() {
    const raw = await this._cmd('0202');
    for (const payload of this._payloads(raw, '0202')) {
      const code = decodeFreezeFrameDtc(payload);
      if (code) return code;
    }
    return null;
  }

  /**
   * Mode 06 — on-board monitor test results. Surfaces tests failing against the
   * ECU's own limits, which is where a marginal fault shows up before it
   * matures into a stored DTC.
   */
  async _readMonitorTests() {
    const failing = [];
    // 0x00 asks which MIDs are supported; then read the common CAN MID range.
    for (const mid of ['00', '01', '02', '20', '21', 'A0', 'A1']) {
      const raw = await this._cmd(`06${mid}`);
      for (const payload of this._payloads(raw, `06${mid}`)) {
        for (const t of decodeMode06Results(payload)) {
          if (!t.passed) failing.push(t);
        }
      }
    }
    return failing;
  }

  /** Generic OBD-II modes (SAE J1979). Emissions-related modules only. */
  async _readLegacy() {
    const out = [];
    for (const mode of ['03', '07', '0A']) {
      const raw = await this._cmd(mode);
      for (const payload of this._payloads(raw, mode)) {
        if (readNegativeResponse(payload)) continue;
        for (const d of decodeLegacyDtcResponse(payload, mode)) {
          out.push({
            ...d,
            source: `Mode ${mode}`,
            // Mode 03 = stored/confirmed, 07 = pending this drive cycle,
            // 0A = permanent (survives a Mode 04 clear).
            category: mode === '07' ? 'pending' : mode === '0A' ? 'historic' : 'active',
          });
        }
      }
    }
    return out;
  }

  /** J1939 (commercial vehicles). Faults are SPN+FMI, not Pxxxx codes. */
  async _readJ1939() {
    const out = [];
    for (const [cmd, label, category] of [
      ['ATDM1', 'J1939 DM1 (active)', 'active'],
      ['ATDM2', 'J1939 DM2 (stored)', 'historic'],
    ]) {
      const raw = await this._cmd(cmd);
      for (const payload of this._payloads(raw, cmd)) {
        for (const d of decodeJ1939Dtcs(payload)) {
          out.push({ ...d, source: label, category });
        }
      }
    }
    return out;
  }

  /**
   * UDS 0x19. Many modules only answer this inside an extended diagnostic
   * session, so try to open one first — that omission is a common reason a
   * scan tool reports "no faults" on a car that plainly has them.
   */
  async _readUds(ecu) {
    const out = [];

    // Open a session; ignore failure, some ECUs serve 0x19 in default session.
    await this._cmd(`10${UDS_SESSION.EXTENDED_DIAGNOSTIC.toString(16).padStart(2, '0')}`);
    await this._cmd('3E00'); // tester present, keeps the session alive

    // Cheap capability probe: ask how many faults this module holds. A non-zero
    // count here with nothing readable below means the codes exist but our
    // sub-function set didn't reach them — worth recording rather than
    // silently reporting "clean".
    const countRaw = await this._cmd('190100');
    for (const payload of this._payloads(countRaw, '190100')) {
      if (readNegativeResponse(payload)) continue;
      const n = decodeUdsDtcCount(payload);
      if (n != null && n > 0) {
        this._reportedCounts.push({ ecu: ecu.request, count: n });
        this._log(`[scan] ${ecu.request} reports ${n} stored DTC(s)`);
      }
    }

    const subFunctions = [
      { sub: DTC_REPORT.DTC_BY_STATUS_MASK, mask: 'FF', label: 'UDS 1902FF (all)' },
      { sub: DTC_REPORT.DTC_BY_STATUS_MASK, mask: '08', label: 'UDS 190208 (confirmed)' },
      { sub: DTC_REPORT.DTC_BY_STATUS_MASK, mask: '04', label: 'UDS 190204 (pending)' },
      { sub: DTC_REPORT.DTC_BY_STATUS_MASK, mask: '2F', label: 'UDS 19022F (failed/stored)' },
      { sub: DTC_REPORT.DTC_WITH_PERMANENT_STATUS, mask: null, label: 'UDS 1915 (permanent)' },
      { sub: DTC_REPORT.MIRROR_MEMORY_DTC_BY_STATUS_MASK, mask: 'FF', label: 'UDS 190FFF (mirror)' },
      { sub: DTC_REPORT.EMISSIONS_RELATED_OBD_DTC_BY_STATUS_MASK, mask: 'FF', label: 'UDS 1913FF (emissions)' },
      { sub: DTC_REPORT.SUPPORTED_DTC, mask: null, label: 'UDS 190A (supported)' },
      { sub: DTC_REPORT.MOST_RECENT_CONFIRMED_DTC, mask: null, label: 'UDS 190E (most recent)' },
    ];

    // Modules that don't implement 0x19 at all reject the very first
    // sub-function with serviceNotSupported — stop pestering them rather than
    // firing eight more doomed requests at every module on the bus.
    let serviceUnsupported = false;

    for (const { sub, mask, label } of subFunctions) {
      if (serviceUnsupported) break;
      const subHex = sub.toString(16).toUpperCase().padStart(2, '0');
      const cmd = `19${subHex}${mask || ''}`;
      let raw = await this._cmd(cmd);

      // NRC 0x78 = "still working, ask again" — retry a few times.
      for (let i = 0; i < 3; i++) {
        const neg = readNegativeResponse(sanitizeResponse(raw, cmd) || '');
        if (!neg || neg.nrc !== NRC.RESPONSE_PENDING) break;
        await new Promise((r) => setTimeout(r, 600));
        raw = await this._cmd(cmd);
      }

      for (const payload of this._payloads(raw, cmd)) {
        const neg = readNegativeResponse(payload);
        if (neg) {
          // A per-service rejection is information, not a failure: it says this
          // module doesn't offer that view of its DTC memory. Log it so a real
          // scan can be debugged from the log alone.
          const nrcHex = `0x${neg.nrc.toString(16).toUpperCase()}`;
          this._log(`[scan] ${ecu.request} ${label}: NRC ${nrcHex}`);
          this.log?.note(`${ecu.request} ${label} rejected`, { nrc: nrcHex, meaning: NRC_MEANING[neg.nrc] || 'unknown' });
          if (neg.nrc === NRC.SERVICE_NOT_SUPPORTED) serviceUnsupported = true;
          continue;
        }
        for (const d of decodeUdsDtcResponse(payload, sub)) {
          out.push({
            ...d,
            // Keep the failure-type byte visible (P0128-00) — it distinguishes
            // "circuit low" from "circuit high" on the same base code.
            displayCode: formatDtcWithFtb(d.code, d.ftb),
            source: label,
            category: d.status?.category || 'active',
          });
        }
      }
    }
    return out;
  }

  /**
   * KWP2000 (ISO 14230). Older European modules — including plenty still fitted
   * to otherwise-CAN cars — expose faults only here.
   *   0x13 readDiagnosticTroubleCodes
   *   0x18 readDiagnosticTroubleCodesByStatus
   *   0x17 readStatusOfDiagnosticTroubleCodes
   */
  async _readKwp() {
    const out = [];
    const requests = [
      { cmd: '1802FF00', service: KWP_SERVICE.READ_DTC_BY_STATUS, label: 'KWP 18 02FF00' },
      { cmd: '18000000', service: KWP_SERVICE.READ_DTC_BY_STATUS, label: 'KWP 18 000000' },
      { cmd: '13',       service: KWP_SERVICE.READ_DTC,           label: 'KWP 13' },
      { cmd: '1300FF00', service: KWP_SERVICE.READ_DTC,           label: 'KWP 13 00FF00' },
      { cmd: '17FF00',   service: KWP_SERVICE.READ_STATUS_OF_DTC, label: 'KWP 17 FF00' },
    ];

    for (const { cmd, service, label } of requests) {
      const raw = await this._cmd(cmd);
      for (const payload of this._payloads(raw, cmd)) {
        const neg = readNegativeResponse(payload);
        if (neg) {
          this._log(`[scan] ${label}: NRC 0x${neg.nrc.toString(16).toUpperCase()}`);
          continue;
        }
        for (const d of decodeKwpDtcResponse(payload, service)) {
          out.push({ ...d, source: label, category: d.status?.category || 'active' });
        }
      }
    }
    return out;
  }

  // ── 4. Full scan ──────────────────────────────────────────────────────────

  async scan(dtcDictionary = {}) {
    const started = Date.now();
    await this.establishProtocol();

    // J1939 rigs don't do per-ECU OBD addressing at all — DM1/DM2 are broadcast
    // on the bus. Handle that shape separately instead of pretending it's OBD.
    if (this._proto?.j1939) {
      const faults = await this._readJ1939();
      const codes = faults.map((d) => ({
        code: d.code, base: d.code,
        title: dtcDictionary[d.code] || `SPN ${d.spn} / FMI ${d.fmi}`,
        desc: `J1939 · повторень: ${d.occurrence}`,
        ecu: 'J1939 шина', ecuAddress: 'J1939',
        variant: d.source, statusByte: null, statusFlags: null,
        statusCategory: d.category, spn: d.spn, fmi: d.fmi,
      }));
      return {
        codes, ecus: [{ request: 'J1939', name: 'J1939 шина', codeCount: codes.length }],
        protocol: this._protocol, durationMs: Date.now() - started,
        variant: codes.length ? `J1939: знайдено ${codes.length}` : 'J1939: помилок не виявлено',
      };
    }

    const ecus = await this.discoverEcus();

    // Emissions-side overview first — this is what lets us distinguish a truly
    // healthy car from one whose faults we simply failed to reach.
    await this._cmd('ATSH7E0');
    const milStatus = await this._readMilStatus();
    const freezeFrameDtc = await this._readFreezeFrameDtc();
    const failingMonitors = this._deepScan ? await this._readMonitorTests() : [];

    const byCode = new Map();
    const scannedEcus = [];

    for (let i = 0; i < ecus.length; i++) {
      const ecu = ecus[i];
      this._onProgress({ phase: 'ecu', index: i, total: ecus.length, ecu: ecu.name });

      await this._cmd(`ATSH${ecu.request}`);
      // Accept only this module's replies where the adapter supports it, so a
      // chatty neighbour can't bleed into this module's results.
      if (ecu.response) await this._cmd(`ATCRA${ecu.response}`);

      let found = [];
      try {
        found = found.concat(await this._readLegacy());
        found = found.concat(await this._readUds(ecu));
        found = found.concat(await this._readKwp());
      } catch (err) {
        this._log(`[scan] ${ecu.request} errored: ${err.message}`);
      }
      await this._cmd('ATCRA'); // clear the receive filter

      scannedEcus.push({ ...ecu, codeCount: found.length });

      for (const d of found) {
        const prev = byCode.get(d.code);
        // Prefer the record that carries a real status byte, and prefer a
        // confirmed fault over a merely pending sighting of the same code.
        const better =
          !prev ||
          (d.statusByte != null && prev.statusByte == null) ||
          (d.status?.confirmed && !prev.status?.confirmed);
        if (better) {
          byCode.set(d.code, {
            code: d.displayCode || d.code,
            base: d.code,
            title: dtcDictionary[d.code] || 'Невідома помилка',
            desc: dtcDictionary[d.code] ? 'Знайдено в базі' : 'Код виробника',
            ecu: ecu.name,
            ecuAddress: ecu.request,
            variant: d.source,
            statusByte: d.statusByte,
            statusFlags: d.status,
            statusCategory: d.category,
          });
        }
      }
    }

    // Restore a sane state for live polling.
    await this._cmd('ATCRA');
    await this._cmd('ATSH7E0');
    await this._cmd('ATH0');
    await this._cmd('ATAT1');
    await this._cmd('ATST26');

    const codes = [...byCode.values()].sort((a, b) => {
      const known = (x) => (x.title !== 'Невідома помилка' ? 0 : 1);
      return known(a) - known(b) || a.code.localeCompare(b.code);
    });

    // ── Cross-check: does the car claim faults we didn't manage to read? ────
    // The ECU's own counters (Mode 01 PID 01, UDS 19 01) are independent of the
    // code reads. If they say "N faults" and we produced fewer, the difference
    // is real and must be surfaced — reporting "no errors" in that case is how
    // the old scanner hid a genuine thermostat + battery fault.
    const claimedByModules = this._reportedCounts.reduce((n, r) => n + r.count, 0);
    const claimedTotal = Math.max(milStatus?.dtcCount || 0, claimedByModules);
    const unreadCount = Math.max(0, claimedTotal - codes.length);

    const warnings = [];
    if (unreadCount > 0) {
      warnings.push(
        `Авто повідомляє про ${claimedTotal} несправність(ей), але вдалося прочитати ${codes.length}. ` +
        `${unreadCount} код(ів) зберігається у форматі виробника, недоступному через стандартні протоколи.`
      );
    }
    if (milStatus?.milOn && codes.length === 0) {
      warnings.push('Лампа Check Engine увімкнена, але жодного коду не зчитано — коди виробника.');
    }
    if (failingMonitors.length > 0) {
      warnings.push(
        `${failingMonitors.length} бортовий тест(и) поза межами норми (Mode 06) — можлива несправність, ще не збережена як код.`
      );
    }
    for (const w of warnings) this._log(`[scan] ⚠ ${w}`);

    this.log?.note('scan complete', {
      codes: codes.map((c) => `${c.code}@${c.ecuAddress}`),
      claimedTotal, unreadCount, warnings,
    });

    return {
      codes,
      ecus: scannedEcus,
      protocol: this._protocol,
      durationMs: Date.now() - started,
      // Full structured session — every command + verbatim response + adapter
      // state. `.toReplayFixture()` turns it into a runnable test case.
      diagnosticLog: this.log,
      milOn: milStatus?.milOn ?? null,
      reportedDtcCount: claimedTotal || null,
      unreadDtcCount: unreadCount || null,
      readinessMonitors: milStatus?.monitors ?? [],
      freezeFrameDtc,
      failingMonitors,
      warnings,
      variant: codes.length
        ? `Знайдено на ${new Set(codes.map((c) => c.ecuAddress)).size} модулі(ях)`
        : unreadCount > 0
          ? `Авто повідомляє про ${claimedTotal} помилку(и), але коди недоступні`
          : `Опитано модулів: ${scannedEcus.length} — помилок не виявлено`,
    };
  }
}
