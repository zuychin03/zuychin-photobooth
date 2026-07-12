// Epoch-clock offset between peers, estimated over the data channel.
// The sample with the lowest round-trip time gives the tightest bound.
export class ClockSync {
  /** remoteTime - localTime, in ms */
  offset = 0;
  private bestRtt = Infinity;
  samples = 0;

  /** a: local send time, b: remote clock at reply, c: local receive time */
  addSample(a: number, b: number, c: number): void {
    const rtt = c - a;
    if (rtt < this.bestRtt) {
      this.bestRtt = rtt;
      this.offset = b - (a + rtt / 2);
    }
    this.samples++;
  }

  /** convert a timestamp from the remote peer's clock to this machine's */
  toLocal(remoteTime: number): number {
    return remoteTime - this.offset;
  }
}
