/* Pure markup helpers. Study metrics are calculated by the study model. */
const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,char=>({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
}[char]));
const finite=(value,fallback=0)=>Number.isFinite(Number(value))?Number(value):fallback;
const clamp=(value,min,max)=>Math.min(max,Math.max(min,value));
const count=value=>Math.max(0,Math.round(finite(value)));
const color=value=>/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(value)?value:'#ffcf5c';

/** cats: {k,n,c}[]; attr: XP by key; levelOf: XP => {lv} (or a level number). */
export function radarMarkup(cats,attr,levelOf){
  const categories=Array.isArray(cats)?cats.slice(0,6):[];
  if(!categories.length)return '';
  const levels=categories.map(category=>{
    const result=typeof levelOf==='function'?levelOf(finite(attr?.[category.k])):1;
    return Math.max(1,count(typeof result==='object'?result?.lv:result));
  });
  const maxLevel=Math.max(4,...levels),cx=110,cy=96,radius=62;
  const point=(index,factor)=>{
    const angle=-Math.PI/2+index*2*Math.PI/categories.length;
    return [cx+Math.cos(angle)*radius*factor,cy+Math.sin(angle)*radius*factor];
  };
  const polygon=factor=>categories.map((_,index)=>point(index,factor(index)).map(value=>value.toFixed(1)).join(',')).join(' ');
  const description='六项属性雷达图：'+categories.map((category,index)=>category.n+' Lv '+levels[index]).join('，');
  return '<svg viewBox="0 0 220 192" role="img" aria-label="'+escapeHtml(description)+'">'
    +[1/3,2/3,1].map(factor=>'<polygon points="'+polygon(()=>factor)+'" fill="none" stroke="#26313f"/>').join('')
    +categories.map((_,index)=>{const p=point(index,1);return '<line x1="'+cx+'" y1="'+cy+'" x2="'+p[0].toFixed(1)+'" y2="'+p[1].toFixed(1)+'" stroke="#26313f"/>';}).join('')
    +'<polygon points="'+polygon(index=>Math.max(.08,levels[index]/maxLevel))+'" fill="rgba(255,207,92,.22)" stroke="#ffcf5c" stroke-width="1.6"/>'
    +categories.map((category,index)=>{
      const p=point(index,1.32);
      return '<text x="'+p[0].toFixed(1)+'" y="'+p[1].toFixed(1)+'" fill="'+color(category.c)+'" font-size="12.5" font-weight="700" text-anchor="middle" dominant-baseline="middle">'+escapeHtml(category.n)+' '+levels[index]+'</text>';
    }).join('')+'</svg><p class="radar-note">按属性等级显示；经验反映投入，不能代表考试掌握程度。</p>';
}

/** metrics: examProgress output; coverage is 0..1, hp is 0..100. */
export function bossMarkup(metrics={},name='四级考试'){
  const vocab=metrics.vocab||{},paper=metrics.paper||{};
  const vocabValue=count(vocab.value),vocabGoal=count(vocab.goal),paperValue=count(paper.value),paperGoal=count(paper.goal);
  const remaining=count(vocab.remaining??Math.max(0,vocabGoal-vocabValue));
  const coverage=clamp(finite(metrics.coverage),0,1),percent=Math.round(coverage*100);
  const hp=Math.round(clamp(finite(metrics.hp,100-percent),0,100));
  const daysLeft=metrics.daysLeft==null?null:Math.round(finite(metrics.daysLeft));
  const expired=Boolean(metrics.expired)||(daysLeft!=null&&daysLeft<0);
  const countdown=expired?(daysLeft<0?'已过 '+Math.abs(daysLeft)+' 天':'目标日期已过'):daysLeft===0?'就在今天':daysLeft==null?'日期待设置':'还有 '+daysLeft+' 天';
  let pace;
  if(remaining===0){
    pace=(expired?'目标日期已过，已记录进度保留。':'')+'词汇目标已记录完成。';
  }else if(expired){
    pace='目标日期已过，已记录进度保留。可在「重要日子」修改日期后查看每日词汇配速。';
  }else if(daysLeft===0){
    pace='今天还需记录 <b>'+remaining+' 词</b>，完成当前词汇目标。';
  }else if(daysLeft!=null&&daysLeft>0){
    const perDay=Math.max(1,count(vocab.perDay??Math.ceil(remaining/daysLeft)));
    pace='还差 '+remaining+' 词 · 按剩余 '+daysLeft+' 天，每天需记录约 <b>'+perDay+' 词</b>。';
  }else{
    pace='还差 '+remaining+' 词。设置目标日期后，可查看每日词汇配速。';
  }
  return '<div class="boss-top"><div><span class="boss-kicker">学习覆盖进度（手动记录）</span><h2 class="boss-name">'+escapeHtml(name||'四级考试')+' · Boss</h2></div><span class="boss-countdown">'+countdown+'</span></div>'
    +(metrics.date?'<p class="boss-date">目标日期：'+escapeHtml(metrics.date)+'</p>':'')
    +'<div class="boss-records"><div><span>词汇累计</span><b>'+vocabValue+' / '+vocabGoal+' <small>词</small></b></div><div><span>真题累计</span><b>'+paperValue+' / '+paperGoal+' <small>套</small></b></div></div>'
    +'<div class="boss-hp"><span>两项平均覆盖量 <b>'+percent+'%</b></span><span>剩余血量 <b>'+hp+'%</b></span></div>'
    +'<div class="hp" data-boss-hp="'+hp+'" role="progressbar" aria-label="Boss剩余血量" aria-valuemin="0" aria-valuemax="100" aria-valuenow="'+hp+'" aria-valuetext="'+hp+'%"><i style="width:'+hp+'%"></i></div>'
    +'<p class="pace">'+pace+'</p>'
    +'<p class="boss-explain">打卡只增加XP，不自动增加词汇或真题进度。<br>Boss血量仅根据已记录词汇/真题覆盖量计算。</p>';
}
