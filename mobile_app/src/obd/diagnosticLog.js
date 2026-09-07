/**
 * obd/diagnosticLog.js — structured, replayable diagnostic session log.
 *
 * The old log stored (type, command, response) and nothing else, which made it
 * hard to reason about after the fact: a bare "03" means completely different
 * things depending on which ECU header was active when it was sent, and there
 * was no record of that. It also summarised some entries instead of keeping the
 * bytes, so the exact adapter output was lost.
 *
 * This records every exchange verbatim ALONG WITH the adapter state at the time
 * (header, protocol, session), how long it took, and what we made of the reply.
 *
 * The important property: a captured session can be turned back into a mock
 * adapter (`toReplayFixture()` + `makeReplayCar()`), so any real scan from a
 * real car becomes a permanent regression test. That's the difference between
 * "here are some logs, squint at them" and "here is the car, in CI".
 */

// Adapter state we can infer purely by watching the command stream.
const AT_HEADER_RE   = /^ATSH\s*([0-9A-F]+)/i;
const AT_PROTOCOL_RE = /^AT(?:SP|TP)\s*([0-9A-C])/i;
const AT_RECV_RE     = /^ATCRA\s*([0-9A-F]*)/i;
const UDS_SESSION_RE = /^10\s*0?([0-9A-F])/i;

export class DiagnosticLog {
  constructor({ maxEntries = 5000 } = {}) {
    this.entries = [];
    this.startedAt = Date.now();
    this.maxEntries = maxEntries;
    this.state = { header: null, protocol: null, recvFilter: null, session: {} };
    this.notes = [];
  }

  /** Free-form annotation, timestamped alongside the command stream. */
  note(text, data = null) {
    this.notes.push({ t: Date.now() - this.startedAt, text, data });
  }

  _trackState(cmd, raw = '') {
    const c = cmd.trim().toUpperCase();
    let m;
    if ((m = AT_HEADER_RE.exec(c)))   this.state.header = m[1];
    if ((m = AT_RECV_RE.exec(c)))     this.state.recvFilter = m[1] || null;

    // Protocol: ATSP0 only means "auto-detect", not an actual protocol, so
    // taking the number off the command would record a meaningless 0. ATDPN's
    // RESPONSE is the authoritative answer — prefer it, and fall back to an
    // explicitly-forced ATSP/ATTP number.
    if (/^ATDPN/.test(c)) {
      const n = raw.replace(/[\s\r\n>]/g, '').replace(/^A/, ''); // "A6" = auto, protocol 6
      if (/^[0-9A-C]$/.test(n)) this.state.protocol = n;
    } else if ((m = AT_PROTOCOL_RE.exec(c)) && m[1] !== '0') {
      this.state.protocol = m[1];
    }
    if ((m = UDS_SESSION_RE.exec(c)) && this.state.header) {
      this.state.session[this.state.header] = m[1];
    }
    if (c === 'ATZ') { this.state.session = {}; this.state.recvFilter = null; }
  }

  /**
   * Record one command/response exchange.
   * @param {object} e
   * @param {string} e.cmd        command as sent
   * @param {string} e.raw        response EXACTLY as received (never trimmed)
   * @param {number} e.ms         round-trip duration
   * @param {string} [e.sanitized] post-sanitize payload, if any
   * @param {string} [e.outcome]  decoded | rejected | negative | empty | error
   * @param {string} [e.detail]   short human explanation
   */
  record(e) {
    this._trackState(e.cmd, e.raw ?? '');
    if (this.entries.length >= this.maxEntries) this.entries.shift();
    this.entries.push({
      seq: this.entries.length + 1,
      t: Date.now() - this.startedAt,
      ms: e.ms ?? null,
      cmd: e.cmd,
      raw: e.raw ?? '',
      header: this.state.header,
      protocol: this.state.protocol,
      session: this.state.header ? this.state.session[this.state.header] ?? null : null,
      sanitized: e.sanitized ?? null,
      outcome: e.outcome ?? null,
      detail: e.detail ?? null,
    });
  }

  /** Quick counts for the summary line / bug reports. */
  stats() {
    const byOutcome = {};
    let slowest = null;
    for (const e of this.entries) {
      byOutcome[e.outcome || 'unknown'] = (byOutcome[e.outcome || 'unknown'] || 0) + 1;
      if (e.ms != null && (!slowest || e.ms > slowest.ms)) slowest = e;
    }
    return {
      commands: this.entries.length,
      durationMs: Date.now() - this.startedAt,
      byOutcome,
      slowest: slowest ? { cmd: slowest.cmd, ms: slowest.ms } : null,
      headersSeen: [...new Set(this.entries.map((e) => e.header).filter(Boolean))],
      protocol: this.state.protocol,
    };
  }

  /**
   * Collapse the session into a replay fixture: for each (header, command)
   * pair, the responses that were actually observed, in order. Feeding this to
   * makeReplayCar() reproduces the car's behaviour exactly.
   */
  toReplayFixture(meta = {}) {
    const responses = {};
    for (const e of this.entries) {
      const key = `${e.header || '-'}|${e.cmd.toUpperCase()}`;
      (responses[key] ||= []).push(e.raw);
    }
    return {
      version: 1,
      capturedAt: new Date(this.startedAt).toISOString(),
      meta,                       // car make/model/VIN etc., supplied by caller
      protocol: this.state.protocol,
      stats: this.stats(),
      responses,
    };
  }

  /** Human-readable transcript — what you'd paste into a bug report. */
  toText() {
    const s = this.stats();
    const head = [
      `=== OBD diagnostic session ===`,
      `captured : ${new Date(this.startedAt).toISOString()}`,
      `protocol : ${s.protocol ?? 'unknown'}`,
      `commands : ${s.commands} in ${s.durationMs}ms`,
      `outcomes : ${JSON.stringify(s.byOutcome)}`,
      `headers  : ${s.headersSeen.join(', ') || 'none'}`,
      ''.padEnd(70, '-'),
    ];
    const rows = this.entries.map((e) => {
      const hdr = (e.header || '-').padEnd(8);
      const cmd = e.cmd.padEnd(10);
      const ms = String(e.ms ?? '').padStart(5);
      const out = (e.outcome || '').padEnd(9);
      // Raw response is kept verbatim on its own segment so byte-level detail
      // survives copy/paste into an issue or a test fixture.
      return `[${String(e.t).padStart(6)}ms] ${hdr} ${cmd} ${ms}ms ${out} ${e.detail || ''}\n    → ${e.raw.replace(/\r/g, '\\r')}`;
    });
    const notes = this.notes.map((n) => `[${String(n.t).padStart(6)}ms] NOTE ${n.text}`);
    return [...head, ...rows, '', ...notes].join('\n');
  }
}

/**
 * Build a mock `sendCommand` from a captured fixture. Responses are served in
 * the order they were originally observed; once exhausted the last one repeats,
 * which matches how a car behaves when you poll the same PID repeatedly.
 *
 * Unknown (header, command) pairs fall back to a header-agnostic match before
 * giving up, so a fixture stays useful even if the scan order changes slightly.
 */
export function makeReplayCar(fixture, { onMiss } = {}) {
  const cursors = {};
  const state = { header: null };

  return function replaySend(cmdRaw) {
    const cmd = String(cmdRaw).trim().toUpperCase();
    const m = AT_HEADER_RE.exec(cmd);
    if (m) state.header = m[1];

    const tryKeys = [
      `${state.header || '-'}|${cmd}`,
      `-|${cmd}`,
      ...Object.keys(fixture.responses).filter((k) => k.endsWith(`|${cmd}`)),
    ];

    for (const key of tryKeys) {
      const list = fixture.responses[key];
      if (!list || list.length === 0) continue;
      const i = cursors[key] ?? 0;
      cursors[key] = Math.min(i + 1, list.length - 1);
      return Promise.resolve(list[i]);
    }

    onMiss?.(cmd, state.header);
    // Unrecorded commands behave like a silent ECU rather than throwing, which
    // is what the real adapter does.
    return Promise.resolve('NO DATA');
  };
}
