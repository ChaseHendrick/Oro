// Profile uncapped rendering and a sustained three-note chord in Chrome.
// Usage: node dev/profile-browser.cjs [url] [output.json] [baseline-hud.js]
// PLAYWRIGHT_MODULE or the existing local runtime wrapper selects Playwright.
// Optional baseline-hud.js substitutes only that module, keeping the same
// current engine, terrain sources, viewport, audio and moving morph fixture.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'/opt/node22/lib/node_modules/playwright');
const fs=require('node:fs');
const path=require('node:path');
const target=process.argv[2]||'http://127.0.0.1:5190/';
const out=path.resolve(process.argv[3]||'browser-profile.json');
(async()=>{
  const browser=await chromium.launch({headless:true,args:['--autoplay-policy=no-user-gesture-required','--ignore-gpu-blocklist']});
  try {
    const context=await browser.newContext({viewport:{width:1280,height:900},deviceScaleFactor:2});
    await context.addInitScript(()=>{localStorage.clear();localStorage.setItem('orograph.settings',JSON.stringify({quality:'high',autoRotate:0,showTips:0}));});
    const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
    if(process.argv[4])await page.route('**/src/visual/hud.js',route=>route.fulfill({contentType:'application/javascript',body:fs.readFileSync(process.argv[4],'utf8')}));
    await page.goto(target);
    await page.waitForFunction(()=>window.orograph?.visuals?.debug,null,{timeout:90000});
    const start=page.getByRole('button',{name:/^Start/}).first();if(await start.isVisible())await start.click();
    await page.waitForSelector('.start-card',{state:'hidden',timeout:90000});
    await page.evaluate(async()=>{
      const o=window.orograph;o.visuals.debug.pause();o.music.transport.stop();
      o.store.batch(()=>{
        const params={terrainA:0,terrainB:3,morph:.4,warp:.15,detail:.4,size:.24,pathShape:2,pathOrder:3,sub:.15,unison:2};
        for(const [k,v]of Object.entries(params))o.store.set('parts.0.params.'+k,v);
        o.store.set('parts.0.mods.morph.lfoDepth',.35);o.store.set('parts.0.mods.morph.lfoRate',.5);
      });
      await o.engine.whenTerrainsReady();o.engine.noteOn(0,48,.8);o.engine.noteOn(0,55,.8);o.engine.noteOn(0,60,.8);
      o.visuals.debug.advance(1);o.visuals.debug.resume();
    });
    await page.waitForTimeout(1500);
    const cdp=await context.newCDPSession(page);await cdp.send('Profiler.enable');await cdp.send('Profiler.setSamplingInterval',{interval:100});
    await page.evaluate(()=>window.orograph.visuals.debug.resetStats());await cdp.send('Profiler.start');
    await page.waitForTimeout(6000);const profile=(await cdp.send('Profiler.stop')).profile;
    const state=await page.evaluate(()=>{
      const o=window.orograph,c=o.visuals.canvas,gl=c.getContext('webgl2'),ext=gl.getExtension('WEBGL_debug_renderer_info');
      const samples=new Float32Array(o.engine.analyser.fftSize);o.engine.analyser.getFloatTimeDomainData(samples);
      return{visual:o.visuals.debug.stats(),audio:o.engine.dspLoad(),audioMode:o.engine.mode,audioState:o.engine.context.state,level:o.engine.level(),audioFinite:samples.every(Number.isFinite),audioPeak:Math.max(...samples.map(Math.abs)),renderer:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),canvas:[c.width,c.height],tables:o.engine.getTerrain(0,'A')?.size};
    });
    const hits=profile.nodes.filter(n=>n.hitCount).sort((a,b)=>b.hitCount-a.hitCount).slice(0,18).map(n=>({fn:n.callFrame.functionName,url:n.callFrame.url,line:n.callFrame.lineNumber+1,hits:n.hitCount}));
    const result={url:target,seconds:6,baselineHud:process.argv[4]||null,state,hits,errors};
    fs.writeFileSync(out,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
