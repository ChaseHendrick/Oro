import { describe, it, expect, vi } from 'vitest';
import { subWave, ColourNoise, KarplusStrong, noiseTextures, fadeLoop, INHARMONIC_RATIOS, profileRatio } from '../../src/dsp/oscillator-extras.js';
import { AnalogFilter } from '../../src/dsp/analog-filters.js';
import { SixStageEnvelope, skewLfoPhase, steppedLfo } from '../../src/dsp/modulation-extras.js';
import { MOD_PARAM_IDS, PART_PARAM_INDEX as PI, LFO_STEP_COUNT } from '../../src/core/params.js';
import { makeDSP, render, rms, peak, allFinite, spectrum } from './helpers.js';
vi.setConfig({testTimeout:60000});
const on=(note=57)=>({t:'noteOn',part:0,note,vel:1});
const off=(note=57)=>({t:'noteOff',part:0,note});
const plain={filterType:0,size:0.28,attack:0.001,sustain:1,velSens:0,release:0.025};
const slot=id=>MOD_PARAM_IDS.indexOf(id);
const delta=(a,b)=>Math.sqrt(a.reduce((sum,x,i)=>sum+(x-b[i])**2,0)/a.length);
function band(mag,a,b,sr=48000,n=65536) { let sum=0; for(let i=Math.ceil(a*n/sr);i<b*n/sr;i++)sum+=mag[i]**2; return sum/(b-a); }
function frequency(data,sr,f) {
  const n=16384,mag=spectrum(data,Math.min(Math.round(sr*.1),data.length-n),n);
  let k=Math.round(f*n/sr); for(let i=Math.round(f*.8*n/sr);i<=Math.round(f*1.2*n/sr);i++)if(mag[i]>mag[k])k=i;
  const a=Math.log(mag[k-1]),b=Math.log(mag[k]),c=Math.log(mag[k+1]);
  return (k+.5*(a-c)/(a-2*b+c))*sr/n;
}

describe('Orograph2 oscillator blocks',()=>{
  it('seven sub waves are DC-free and suppress discontinuity aliases',()=>{
    const n=16384,cycles=373,inc=cycles/n;
    for(let type=0;type<7;type++) {
      const data=Float64Array.from({length:n},(_,i)=>subWave(type,(i*inc)%1,inc));
      expect(Math.abs(data.reduce((a,b)=>a+b,0)/n)).toBeLessThan(.001);
      expect(allFinite(data)).toBe(true); expect(rms(data)).toBeGreaterThan(.2); expect(peak(data)).toBeLessThan(1.6);
    }
    const corrected=Float64Array.from({length:n},(_,i)=>subWave(2,(i*inc)%1,inc));
    const naive=Float64Array.from({length:n},(_,i)=>2*((i*inc)%1)-1);
    const power=x=>{ const m=spectrum(x,0,n);let alias=0;const mask=new Uint8Array(n/2);
      for(let h=1;h*cycles<n/2;h++)for(let j=h*cycles-2;j<=h*cycles+2;j++)mask[j]=1;
      for(let i=3;i<n/2;i++)if(!mask[i])alias+=m[i]*m[i];return alias; };
    expect(power(corrected)/power(naive)).toBeLessThan(.25);
  });
  it('all eleven partial profiles differ and interpolate their ratios continuously',()=>{
    expect(INHARMONIC_RATIOS).toHaveLength(11);
    expect(new Set(INHARMONIC_RATIOS.map(x=>Array.from(x).join(','))).size).toBe(11);
    for(let p=0;p<10;p++)for(let i=0;i<12;i++)expect(profileRatio(p+.5,i)).toBeCloseTo((profileRatio(p,i)+profileRatio(p+1,i))/2,12);
  });
  it('white/pink/blue/brown have the intended measured spectral slopes',()=>{
    const expected=[0,-3,3,-6];
    for(let type=1;type<=4;type++) {
      const noise=new ColourNoise(48000,3),data=Float64Array.from({length:65536},()=>noise.sample(type));
      const mag=spectrum(data,0,65536),slope=10*Math.log10(band(mag,4000,8000)/band(mag,250,500))/4;
      expect(slope).toBeCloseTo(expected[type-1],0); expect(rms(data)).toBeGreaterThan(.9);expect(rms(data)).toBeLessThan(1.1);
    }
  });
  it('generated texture loops and imported loop seams are continuous',()=>{
    const textures=noiseTextures(48000); expect(textures).toHaveLength(3);
    for(const data of textures) { expect(data[0]).toBe(0);expect(data.at(-1)).toBe(0);expect(rms(data)).toBeGreaterThan(.05); }
    const data=Float32Array.from({length:4800},(_,i)=>Math.sin(i*.12));fadeLoop(data,48000);
    expect(data[0]).toBe(0);expect(data.at(-1)).toBe(0);
  });
  it('the extended string is tuned across sample rates, dispersions and six octaves',()=>{
    for(const sr of [44100,48000,96000])for(const f of [55,110,220,440,880,1760])for(const dispersion of [0,.6]) {
      const ks=new KarplusStrong(sr);ks.trigger(f,1,.7,dispersion,42);
      const data=Float64Array.from({length:sr},()=>ks.sample());
      expect(Math.abs(1200*Math.log2(frequency(data,sr,f)/f))).toBeLessThan(3);
      expect(rms(data,sr*.9,sr)/rms(data,0,sr*.05)).toBeLessThan(.03);
    }
  });
});

describe('five digital filter colours',()=>{
  it('cutoff/resonance extremes and stereo state remain finite',()=>{
    for(let type=7;type<=11;type++) {
      const filter=new AnalogFilter();
      for(const g of [.001,.01,.1,1,10])for(const resonance of [0,.5,1]) {
        filter.reset();filter.configure(type,g,resonance,.5);
        for(let n=0;n<5000;n++) {
          const input=n<2500?Math.sin(n*.153)*2:0;
          for(let channel=0;channel<2;channel++) { const out=filter.sample(input,channel);expect(Number.isFinite(out)).toBe(true);expect(Math.abs(out)).toBeLessThan(10); }
        }
      }
    }
  });
  it('clean four-pole ladder attenuates above cutoff and colours differ',()=>{
    const response=(type,f)=>{const filter=new AnalogFilter();filter.configure(type,Math.tan(Math.PI*1000/48000),0,0);let power=0;
      for(let n=0;n<48000;n++){const y=filter.sample(.5*Math.sin(2*Math.PI*f*n/48000));if(n>24000)power+=y*y;}return Math.sqrt(power/24000);};
    expect(response(8,8000)/response(8,100)).toBeLessThan(.01);
    const outputs=[7,8,9,10,11].map(t=>response(t,700));expect(new Set(outputs.map(x=>x.toFixed(5))).size).toBe(5);
  });
});

describe('six-stage envelope and richer modulation',()=>{
  it('delay/hold are timed, gate releases, and the six modes have distinct lifecycle behavior',()=>{
    for(let mode=0;mode<6;mode++) {
      const env=new SixStageEnvelope();env.configure(new Float64Array([.01,.01,.01,.03,.4,.02,mode]),.001);env.trigger();
      for(let n=0;n<9;n++)expect(env.sample(.001)).toBe(0);
      for(let n=0;n<16;n++)env.sample(.001);
      expect(env.value).toBeGreaterThan(mode === 5 ? .1 : .98);
      for(let n=0;n<60;n++)env.sample(.001);
      if(mode===1||mode===5)expect(env.stage).toBe(0);
      else {expect(env.stage).not.toBe(0);env.release();for(let n=0;n<35;n++)env.sample(.001);expect(env.stage===0).toBe(mode!==4);}
      env.release(true);for(let n=0;n<35;n++)env.sample(.001);expect(env.value).toBe(0);
    }
  });
  it('skew and a smoothed 32-step glide preserve endpoints',()=>{
    expect(skewLfoPhase(.2,0)).toBe(.2);expect(skewLfoPhase(.2,.8)).toBeLessThan(.2);
    const steps=new Float64Array(32);steps[1]=1;
    expect(steppedLfo(steps,0,1/32,1/32,1,1)).toBe(0);
    expect(steppedLfo(steps,0,1.5/32,1/32,1,1)).toBeCloseTo(.5);
    expect(steppedLfo(steps,0,2/32-1e-10,1/32,1,1)).toBeCloseTo(1,6);
  });
  it('delay/attack/finite cycles/phase/offset apply to per-parameter LFOs',()=>{
    const dsp=makeDSP({mods:{pan:{lfoShape:3,lfoRate:10,lfoDepth:.5,lfoDelay:.02,lfoAttack:.02,lfoCount:1,lfoPhase:.2,lfoOffset:.1}}});
    const P=dsp.parts[0],m=slot('pan');render(dsp,.015);expect(P.lfoVal[m]).toBeCloseTo(.1);
    render(dsp,.025);expect(Math.abs(P.lfoVal[m]-.1)).toBeGreaterThan(.8);
    render(dsp,.1);expect(P.lfoVal[m]).toBeCloseTo(.1);
  });
  it('independent target envelopes and all four controller slots affect audio and telemetry',()=>{
    const dsp=makeDSP({params:{...plain,pan:-1},mods:{pan:{envOwn:1,envDelay:.01,envAttack:.01,envHold:0,envDecay:.02,envSustain:1,envDepth:.2,ctrl1Source:0,ctrl1Depth:.1,ctrl2Source:1,ctrl2Depth:.1,ctrl3Source:17,ctrl3Depth:.1,ctrl4Source:19,ctrl4Depth:.1}}});
    dsp.handleMessage({t:'wheel',part:0,v:1});dsp.handleMessage({t:'expression',part:0,v:1});dsp.handleMessage({t:'breath',part:0,v:1});dsp.handleMessage(on());
    render(dsp,.06);const v=dsp.parts[0].voices.find(x=>x.active);
    expect(v.modNorm[slot('pan')]).toBeCloseTo(.6,2);expect(v.ownEnvs[slot('pan')].value).toBeCloseTo(1);
    dsp.handleMessage(off());render(dsp,.2);expect(dsp.parts[0].activeCount()).toBe(0);
  });
  it('target envelopes preserve the full ten-second release control range',()=>{
    const dsp=makeDSP({params:{...plain,release:10},mods:{pan:{envOwn:1,envAttack:.001,envDecay:.001,envSustain:1,envRelease:10,envDepth:.2}}});
    dsp.handleMessage(on());render(dsp,.02);dsp.handleMessage(off());render(dsp,.2);
    const env=dsp.parts[0].voices.find(v=>v.active).ownEnvs[slot('pan')];
    expect(env.config[5]).toBe(10);expect(env.value).toBeCloseTo(Math.pow(.001,.2/10),2);
  });
});

describe('Orograph2 core integration',()=>{
  it('runs eight unison voices and changes between one and eight continuously',()=>{
    const dsp=makeDSP({params:{...plain,unison:8,detune:35,spread:1}});dsp.handleMessage(on());
    let data=render(dsp,.1);expect(allFinite(data.L)).toBe(true);expect(rms(data.L)).toBeGreaterThan(.01);expect(delta(data.L,data.R)).toBeGreaterThan(.01);
    expect(dsp.parts[0].voices[0].uRun).toBe(8);
    dsp.handleMessage({t:'params',part:0,p:{unison:1}});render(dsp,.15);expect(dsp.parts[0].voices[0].uRun).toBe(1);
  });
  it('both sub banks place fundamentals one and two octaves below the played note',()=>{
    const dsp=makeDSP({params:{...plain,size:0,sub:1,sub2:1,subWave:0,sub2Wave:0}});dsp.handleMessage(on(69));
    const {L}=render(dsp,.4),mag=spectrum(L,4000,8192),at=f=>Math.max(...mag.slice(Math.round(f*8192/48000)-1,Math.round(f*8192/48000)+2));
    expect(at(110)).toBeGreaterThan(100);expect(at(220)).toBeGreaterThan(100);
  });
  it('B2 sine subs retain the same gain/RMS at both octaves and unison7/8',()=>{
    const note=47,f=440*Math.pow(2,(note-69)/12),expected=.8*.75*.75*.5;
    const amplitude=(data,frequency)=>{let re=0,im=0,weight=0;const start=12000,n=16384;
      for(let i=0;i<n;i++){const w=.5-.5*Math.cos(2*Math.PI*i/n),phase=2*Math.PI*frequency*i/48000;re+=data[start+i]*w*Math.cos(phase);im+=data[start+i]*w*Math.sin(phase);weight+=w;}
      return 2*Math.hypot(re,im)/weight;};
    for(const unison of [1,7,8])for(const second of [false,true]) {
      const dsp=makeDSP({params:{...plain,size:0,sub:second?0:1,sub2:second?1:0,unison}});dsp.handleMessage(on(note));
      const data=render(dsp,.65);const actual=amplitude(data.L,f/(second?4:2));
      expect(actual).toBeCloseTo(expected,3);expect(amplitude(data.R,f/(second?4:2))).toBeCloseTo(actual,6);
      expect(rms(data.L,12000)/(.225/Math.SQRT2)).toBeCloseTo(1,1);
    }
  });
  it('sixteen bass voices with both sub banks stay finite and copies retain all7/8 oscillators',()=>{
    for(const unison of [7,8]) {
      const dsp=makeDSP({params:{...plain,unison,sub:.4,sub2:.4,pluck:.2,ampHold:.01,ampMode:0,filterType:8}});
      dsp.handleMessage({t:'params',part:1,p:{...plain,unison,sub:.4,sub2:.4}});
      for(let part=0;part<2;part++)for(let i=0;i<8;i++)dsp.handleMessage({t:'noteOn',part,note:47+i,vel:.5});
      const data=render(dsp,.06);expect(dsp.parts[0].activeCount()+dsp.parts[1].activeCount()).toBe(16);expect(allFinite(data.L)).toBe(true);
      dsp.handleMessage({t:'quality',mode:'high'});
      for(const part of dsp.parts.slice(0,2)) {
        expect(part.ghost.voices.filter(v=>v.active)).toHaveLength(8);
        for(const voice of part.ghost.voices){expect(voice.uRun).toBe(unison);expect(voice.phase[unison-1]).toBeGreaterThan(0);}
      }
      expect(allFinite(render(dsp,.04).L)).toBe(true);
    }
  });
  it('mono and separated legato notes retrigger custom amp and target envelopes and the string',()=>{
    for(const mode of [1,2]) {
      const dsp=makeDSP({params:{...plain,polyMode:mode,ampDelay:.005,ampHold:.005,pluck:.7},mods:{pan:{envOwn:1,envDelay:.01,envDepth:.3}}});
      dsp.handleMessage(on(47));render(dsp,.05);dsp.handleMessage(off(47));render(dsp,.005);
      dsp.handleMessage(on(52));const voice=dsp.parts[0].voices[0];
      expect(voice.ampExtra.gate).toBe(true);expect(voice.ownEnvs[slot('pan')].gate).toBe(true);expect(voice.ampExtra.stage).toBe(1);
      const data=render(dsp,.06);expect(dsp.parts[0].activeCount()).toBe(1);expect(rms(data.L,1500)).toBeGreaterThan(.005);
    }
  });
  it('new oscillators and shaping alter sound, with bounded output in every quality',()=>{
    const complex={...plain,unison:8,sub:.4,subWave:2,sub2:.3,sub2Wave:4,inharmAmount:.35,inharmProfile:4.7,phaseMod:.35,phaseRatio:1.37,ringMod:.25,ringRatio:2.3,pluck:.25,pluckDecay:.4,pluckDispersion:.5,air:.4,airType:3,pathWindow:.4,pathMangle:.3,pathMirror:3};
    for(const quality of ['eco','standard','high','pristine']) {
      const dsp=makeDSP({params:complex});dsp.handleMessage({t:'quality',mode:quality});dsp.handleMessage(on());
      for(const type of [7,8,9,10,11]) {dsp.handleMessage({t:'params',part:0,p:{filterType:type,cutoff:1600,resonance:.85}});const data=render(dsp,.055);expect(allFinite(data.L)).toBe(true);expect(peak(data.L)).toBeLessThan(4);}
      dsp.handleMessage(off());render(dsp,.2);expect(dsp.parts[0].activeCount()).toBe(0);
    }
  });
  it('phase/ring/profile/string/window/mangle have individually audible effects',()=>{
    const base=makeDSP({params:plain});base.handleMessage(on());const reference=render(base,.15).L;
    for(const settings of [{phaseMod:.6,phaseRatio:1.7},{ringMod:.7,ringRatio:1.37},{inharmAmount:1,inharmProfile:5},{pluck:1},{pathWindow:.8},{pathMangle:.8},{pathMirror:1}]) {
      const dsp=makeDSP({params:{...plain,...settings}});dsp.handleMessage(on());const data=render(dsp,.15).L;expect(delta(data,reference)).toBeGreaterThan(.02);
    }
  });
  it('custom recordings are sanitized, copied, looped and rate-independent',()=>{
    const dsp=makeDSP({params:{...plain,size:0,air:1,airType:8}});const recording=Float32Array.from({length:4800},(_,i)=>Math.sin(i*.1));recording[3]=NaN;
    dsp.handleMessage({t:'noiseRecording',part:0,data:recording});expect(dsp.parts[0].recording).not.toBe(recording);
    dsp.handleMessage(on());const first=render(dsp,.12).L;expect(allFinite(first)).toBe(true);expect(rms(first)).toBeGreaterThan(.04);
    dsp.handleMessage({t:'quality',mode:'high'});const second=render(dsp,.12).L;expect(allFinite(second)).toBe(true);expect(rms(second)).toBeGreaterThan(.04);
    dsp.handleMessage({t:'noiseRecording',part:0,data:null});render(dsp,.1);expect(dsp.parts[0].recording).toBeNull();
  });
  it('six-stage amp mode releases and latched hold is forcibly silenced by allOff',()=>{
    const dsp=makeDSP({params:{...plain,ampDelay:.01,ampHold:.02,ampMode:4}});dsp.handleMessage(on());
    const a=render(dsp,.08).L;expect(peak(a,0,400)).toBe(0);expect(rms(a,2000)).toBeGreaterThan(.01);
    dsp.handleMessage(off());render(dsp,.06);expect(dsp.parts[0].activeCount()).toBe(1);
    dsp.handleMessage({t:'allOff',part:0});render(dsp,.15);expect(dsp.parts[0].activeCount()).toBe(0);
  });
  it('vector bank corners and centre use equal-power weights with default bypass',()=>{
    const run=(global)=>{const dsp=makeDSP({params:plain});dsp.handleMessage({t:'global',p:global});dsp.handleMessage(on());return render(dsp,.12).L;};
    const base=run({});expect(delta(run({vectorMix:0,vectorX:1}),base)).toBe(0);
    const corner=run({vectorMix:1,vectorX:0,vectorY:0});expect(delta(corner,base)).toBe(0);
    const centre=run({vectorMix:1,vectorX:.5,vectorY:.5});expect(rms(centre)/rms(base)).toBeCloseTo(.5,6);
    expect(peak(run({vectorMix:1,vectorX:1,vectorY:1}))).toBe(0);
  });
  it('track effects execute before dry/send mix and sidechain uses raw track levels',()=>{
    const dsp=makeDSP({params:{...plain,delaySend:1,reverbSend:1}});
    dsp.handleMessage({t:'trackFx',part:0,fx:{routing:0,slots:[{type:'overdrive',mix:1,p1:.8,p2:.5,p3:.5,p4:.5}]},sidechainIndex:0});dsp.handleMessage(on());
    const data=render(dsp,.1);expect(allFinite(data.L)).toBe(true);expect(dsp.parts[0].effects.meter().sidechain).toBeGreaterThan(0);expect(dsp.parts[0].rawPeak).toBeGreaterThan(0);
    expect(rms(data.DL)).toBeGreaterThan(0);
    dsp.handleMessage({t:'panic'});expect(dsp.parts[0].effects.meter().rms).toBe(0);
  });
});
