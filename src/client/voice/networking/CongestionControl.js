'use strict';

/** Loss-based AIMD rate control and bounded video packet pacing. @private */
class CongestionControl {
  constructor({ bitrate = 2000, minBitrate = 128, onChange = () => {} } = {}) {
    if (!Number.isFinite(bitrate) || !Number.isFinite(minBitrate) || minBitrate <= 0 || bitrate < minBitrate) {
      throw new RangeError('Congestion bitrates must be finite, positive and ordered');
    }
    this.maximum = bitrate * 1000;
    this.minimum = minBitrate * 1000;
    this.targetBitrate = this.maximum;
    this.onChange = onChange;
    this.loss = 0;
    this.reason = 'initial';
    this.nextSendAt = 0;
    this.windowStart = performance.now();
    this.lastUpdate = -Infinity;
    this.lastReport = -Infinity;
    this.sent = 0;
    this.totalSent = 0;
    this.missing = new Set();
    this.reports = new Map();
  }

  get state() {
    return { targetBitrate: this.targetBitrate, loss: this.loss, packetsSent: this.totalSent, reason: this.reason };
  }

  report(loss, highest, reporter, now = performance.now()) {
    if (!Number.isFinite(loss) || loss < 0 || loss > 1) return;
    const previous = this.reports.get(reporter);
    const distance = previous ? (highest - previous.highest) >>> 0 : 1;
    if (distance >= 0x80000000 || !distance) return;
    for (const [id, report] of this.reports) if (now - report.time > 3000) this.reports.delete(id);
    if (!this.reports.has(reporter) && this.reports.size >= 32) return;
    this.reports.set(reporter, { highest, loss, time: now });
    this.lastReport = now;
    this._update(Math.max(...[...this.reports.values()].map(report => report.loss)), now, true);
  }

  nack(sequence) {
    if (this.missing.size < 512) this.missing.add(sequence);
  }

  packetSent(now = performance.now()) {
    if (now - this.windowStart >= 1000) {
      if (now - this.lastReport > 2000 && this.sent >= 20 && this.missing.size) {
        this._update(Math.min(1, this.missing.size / this.sent), now, false);
      }
      this.windowStart = now;
      this.sent = 0;
      this.missing.clear();
    }
    this.sent++;
    this.totalSent++;
  }

  _update(loss, now, canIncrease) {
    if (now - this.lastUpdate < 1000) return;
    this.lastUpdate = now;
    this.loss = loss;
    const before = this.targetBitrate;
    if (loss >= 0.1) {
      this.targetBitrate *= 0.75;
      this.reason = 'high-loss';
    } else if (loss >= 0.02) {
      this.targetBitrate *= 0.9;
      this.reason = 'loss';
    } else if (canIncrease && loss < 0.02) {
      this.targetBitrate += Math.max(8000, this.targetBitrate * 0.05);
      this.reason = 'recovery';
    }
    this.targetBitrate = Math.round(Math.max(this.minimum, Math.min(this.maximum, this.targetBitrate)));
    if (before !== this.targetBitrate) this.onChange(this.state);
  }

  delay(bytes, now = performance.now()) {
    const due = Math.max(now, this.nextSendAt);
    this.nextSendAt = due + (bytes * 8000) / this.targetBitrate;
    return due - now;
  }
}

module.exports = CongestionControl;
