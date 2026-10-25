// No assets or network are required for the default completion sound.
export function scheduleAchievement(ctx,t0){
  const master=ctx.createGain();master.gain.value=0.8;master.connect(ctx.destination);
  for(const [frequency,offset] of [[659.25,0],[987.77,0.085],[1318.51,0.17]]){
    for(const [harmonic,volume] of [[1,0.50],[2,0.14],[3,0.05]]){
      const at=t0+offset,o=ctx.createOscillator(),g=ctx.createGain();
      o.type='sine';o.frequency.value=frequency*harmonic;if(harmonic>1)o.detune.value=6;
      g.gain.setValueAtTime(0.0001,at);g.gain.exponentialRampToValueAtTime(volume,at+0.012);
      g.gain.exponentialRampToValueAtTime(0.0001,at+0.62);o.connect(g);g.connect(master);o.start(at);o.stop(at+0.7);
    }
  }
  return master;
}
export function createAchievementPlayer(){
  let context=null,custom=null;
  const synth=()=>{
    const Ctor=globalThis.AudioContext||globalThis.webkitAudioContext;if(!Ctor)return;
    try{context??=new Ctor();if(context.state==='suspended')context.resume().catch(()=>{});scheduleAchievement(context,context.currentTime+0.02);}catch{}
  };
  return {
    async probe(){
      if(typeof globalThis.fetch!=='function'||typeof globalThis.Audio==='undefined')return;
      for(const file of ['achievement.m4a','achievement.mp3','achievement.ogg']){
        try{const r=await fetch(file,{method:'HEAD'});if(r.ok){custom=new Audio(file);custom.preload='auto';return;}}catch{}
      }
    },
    play(enabled=true){if(!enabled)return;if(custom){try{custom.currentTime=0;Promise.resolve(custom.play()).catch(synth);return;}catch{}}synth();}
  };
}
