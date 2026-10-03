// A preallocated live-worklet timer. It measures this processor's work, not
// other Web Audio nodes or the total CPU. Coarse clocks yield an estimate.
export class DspLoadMeter {
  constructor(sampleRate, coarseClock = false, windowBlocks = 64) {
    this.sampleRate=sampleRate;
    this.windowBlocks=windowBlocks;
    this.elapsed=0; this.budget=0; this.blocks=0; this.peak=0; this.overruns=0;
    this.report={t:'load',percent:0,peakPercent:0,overruns:0,blocks:windowBlocks,coarseClock,quantumMs:0,windowMs:0};
  }
  /** Return the same report only at a window boundary; no audio-thread allocation. */
  record(elapsedMs, frames) {
    const elapsed=Number.isFinite(elapsedMs) ? Math.max(0,elapsedMs) : 0;
    const budget=1000*frames/this.sampleRate;
    this.elapsed+=elapsed; this.budget+=budget; this.blocks++;
    this.peak=Math.max(this.peak,elapsed/budget*100);
    // Integer Date.now readings cannot certify a borderline missed deadline.
    if (elapsed > budget+(this.report.coarseClock ? 1 : 0)) this.overruns++;
    if (this.blocks < this.windowBlocks) return null;
    const report=this.report;
    report.percent=this.elapsed/this.budget*100; report.peakPercent=this.peak;
    report.overruns=this.overruns; report.blocks=this.blocks; report.quantumMs=budget; report.windowMs=this.budget;
    this.elapsed=0; this.budget=0; this.blocks=0; this.peak=0; this.overruns=0;
    return report;
  }
}
