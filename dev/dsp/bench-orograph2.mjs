import { OroDSP } from '../../src/dsp/dsp-core.js';
import { MOD_PARAM_IDS } from '../../src/core/params.js';
import { performance } from 'node:perf_hooks';
const block=128,sr=48000;
const l=new Float32Array(block),r=new Float32Array(block),d1=new Float32Array(block),d2=new Float32Array(block),v1=new Float32Array(block),v2=new Float32Array(block);
const complex={unison:8,sub:.4,subWave:2,sub2:.3,sub2Wave:4,inharmAmount:.35,inharmProfile:4.7,phaseMod:.35,phaseRatio:1.37,ringMod:.25,ringRatio:2.3,pluck:.25,pluckDecay:8,pluckDispersion:.5,air:.4,airType:3,pathWindow:.4,pathMangle:.3,pathMirror:3,filterType:11,cutoff:1600,resonance:.85,sustain:1};
function bench(name,tracks,notes,prm,quality='standard',mods=false,fx=false){
  global.gc?.();const dsp=new OroDSP(sr);dsp.handleMessage({t:'tracks',count:tracks});dsp.handleMessage({t:'quality',mode:quality});
  for(let part=0;part<tracks;part++){
    dsp.handleMessage({t:'params',part,p:prm});
    if(mods)dsp.handleMessage({t:'mods',part,m:Object.fromEntries(MOD_PARAM_IDS.map(id=>[id,{lfoRate:.7,lfoDepth:.1,envOwn:1,envDepth:.1,ctrl1Source:0,ctrl1Depth:.1,ctrl2Source:2,ctrl2Depth:.1,ctrl3Source:13,ctrl3Depth:.1,ctrl4Source:17,ctrl4Depth:.1}]))});
    if(fx)dsp.handleMessage({t:'trackFx',part,fx:{routing:0,slots:[{type:'shimmer',mix:.35},{type:'granular',mix:.25},{type:'ott',mix:.3},{type:'phaser',mix:.3}]}});
    for(let k=0;k<notes;k++)dsp.handleMessage({t:'noteOn',part,note:45+k*3,vel:.8});
  }
  let t=0;for(let i=0;i<300;i++){dsp.process(l,r,d1,d2,v1,v2,block,t);t+=block/sr;}
  const durations=[],start=process.cpuUsage();for(let i=0;i<900;i++){const b=performance.now();dsp.process(l,r,d1,d2,v1,v2,block,t);durations.push(performance.now()-b);t+=block/sr;}
  const cpu=process.cpuUsage(start);durations.sort((a,b)=>a-b);let mean=durations.reduce((a,b)=>a+b,0)/durations.length;
  console.log(JSON.stringify({name,tracks,voices:tracks*notes,unison:prm.unison||1,quality,controllers:mods,fx,meanMs:+mean.toFixed(4),p95Ms:+durations[855].toFixed(4),maxMs:+durations.at(-1).toFixed(4),cpuPercent:+((cpu.user+cpu.system)/1e6/(900*block/sr)*100).toFixed(2),finite:[...l,...r].every(Number.isFinite)}));
}
bench('legacy default',2,8,{unison:2,sustain:1});
for(const quality of ['eco','standard','high','pristine'])bench('all oscillators',1,1,complex,quality);
bench('complex chord',1,8,complex);
bench('complex chord + 40 target envelopes and controllers',1,8,complex,'standard',true);
bench('complex chord + four heavy effects',1,8,complex,'standard',false,true);
bench('two complex chords',2,8,complex);
