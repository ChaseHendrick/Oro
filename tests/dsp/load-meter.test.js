import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { DspLoadMeter } from '../../src/dsp/load-meter.js';

describe('live DSP load estimate',()=>{
  it('reports actual audio budget, mean, peak and over-budget windows without allocations',()=>{
    const meter=new DspLoadMeter(48000,false,4);
    expect(meter.record(1,128)).toBeNull();expect(meter.record(2,128)).toBeNull();expect(meter.record(3,128)).toBeNull();
    const report=meter.record(2,128);
    expect(report.percent).toBeCloseTo(75);expect(report.peakPercent).toBeCloseTo(112.5);
    expect(report.overruns).toBe(1);expect(report.quantumMs).toBeCloseTo(8/3);expect(report.windowMs).toBeCloseTo(32/3);
    for(let n=0;n<3;n++)expect(meter.record(0,256)).toBeNull();
    expect(meter.record(0,256)).toBe(report);expect(report.percent).toBe(0);expect(report.overruns).toBe(0);expect(report.quantumMs).toBeCloseTo(16/3);
  });
  it('coarse clocks estimate mean but only flag overruns beyond clock uncertainty',()=>{
    const meter=new DspLoadMeter(48000,true,4);
    for(const elapsed of [0,1,3])meter.record(elapsed,128);
    const report=meter.record(4,128);
    expect(report.percent).toBeCloseTo(75);expect(report.coarseClock).toBe(true);expect(report.overruns).toBe(1);
  });
});

let Processor;
const saved={AudioWorkletProcessor:globalThis.AudioWorkletProcessor,registerProcessor:globalThis.registerProcessor,sampleRate:globalThis.sampleRate,currentTime:globalThis.currentTime};
beforeAll(async()=>{
  globalThis.AudioWorkletProcessor=class {constructor(){this.port={postMessage:vi.fn()};}};
  globalThis.registerProcessor=(_name,constructor)=>{Processor=constructor;};
  globalThis.sampleRate=48000;globalThis.currentTime=0;
  await import('../../src/dsp/worklet.js');
});
afterAll(()=>{for(const [key,value]of Object.entries(saved)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}});
const outputs=()=>Array.from({length:3},()=>[new Float32Array(128),new Float32Array(128)]);
describe('worklet timer opt-in',()=>{
  it('offline/default construction reads no clock and sends no load messages',()=>{
    const processor=new Processor({processorOptions:{init:[{t:'watch',part:-1}]}});
    expect(processor.loadMeter).toBeNull();
    processor.dsp.process=vi.fn();
    for(let n=0;n<65;n++)processor.process([],outputs());
    expect(processor.port.postMessage).not.toHaveBeenCalled();
  });
  it('measures only enabled processors and posts one reused report per64 blocks',()=>{
    const processor=new Processor({processorOptions:{measureLoad:true,init:[{t:'watch',part:-1}]}});
    processor.dsp.process=vi.fn();let tick=0;processor.loadClock=()=>tick++;
    const out=outputs();
    for(let n=0;n<63;n++)processor.process([],out);
    expect(processor.port.postMessage).not.toHaveBeenCalled();
    processor.process([],out);
    expect(processor.port.postMessage).toHaveBeenCalledTimes(1);
    expect(processor.port.postMessage.mock.calls[0][0]).toMatchObject({t:'load',blocks:64,overruns:0});
    expect(processor.port.postMessage.mock.calls[0][0].percent).toBeCloseTo(37.5,9);
  });
});
