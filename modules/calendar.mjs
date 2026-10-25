// Pure calendar generation: stable identifiers, local times, and explicit reminders.
const pad=n=>String(n).padStart(2,'0');
export const icsEscape=s=>String(s??'').replace(/\\/g,'\\\\').replace(/\r?\n/g,'\\n').replace(/,/g,'\\,').replace(/;/g,'\\;');
const local=d=>d.getFullYear()+pad(d.getMonth()+1)+pad(d.getDate())+'T'+pad(d.getHours())+pad(d.getMinutes())+'00';
const utc=d=>d.toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');
export function scheduledTasks(tasks){return tasks.filter(t=>!t.paused&&/^([01]\d|2[0-3]):[0-5]\d$/.test(t.t||''));}
export function buildCalendar(tasks, now=new Date()){
  const lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//life-rpg//ZH-CN','CALSCALE:GREGORIAN','METHOD:PUBLISH'];
  for(const t of scheduledTasks(tasks)){
    if(!/^[A-Za-z0-9_-]+$/.test(t.id))continue;
    const start=new Date(now);const [h,m]=t.t.split(':').map(Number);start.setHours(h,m,0,0);
    const weekdays=Array.isArray(t.wd)?t.wd.filter(w=>Number.isInteger(w)&&w>=1&&w<=7):[];
    for(let i=0;i<8;i++){
      if(start>=now&&(!weekdays.length||weekdays.includes(start.getDay()||7)))break;
      start.setDate(start.getDate()+1);
    }
    const end=new Date(start.getTime()+Math.min(40,Math.max(5,Number(t.minutes)||30))*60000);
    lines.push('BEGIN:VEVENT','UID:liferpg-'+t.id+'@life-rpg','DTSTAMP:'+utc(now),'DTSTART:'+local(start),'DTEND:'+local(end));
    if(t.repeat!=='once')lines.push(weekdays.length?'RRULE:FREQ=WEEKLY;BYDAY='+weekdays.map(w=>['MO','TU','WE','TH','FR','SA','SU'][w-1]).join(','):'RRULE:FREQ=DAILY');
    lines.push('SUMMARY:'+icsEscape(t.n),'DESCRIPTION:'+icsEscape(t.d||''),'BEGIN:VALARM','TRIGGER:-PT0M','ACTION:DISPLAY','DESCRIPTION:'+icsEscape(t.n),'END:VALARM','END:VEVENT');
  }
  return lines.join('\r\n')+'\r\n';
}
