// Local preview: runtime files only, no directory listings, backups or credentials.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),port=Number(process.argv[2]||8848);
const allowed=new Set(['index.html','update.html','app.css','app.mjs','sw.js','manifest.webmanifest','icon-180.png','icon-192.png','icon-512.png','modules/state.mjs','modules/sync.mjs','modules/audio.mjs','modules/calendar.mjs','modules/study.mjs','modules/study-view.mjs']);
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.js':'text/javascript; charset=utf-8','.webmanifest':'application/manifest+json','.png':'image/png'};
http.createServer((req,res)=>{
  const name=new URL(req.url,'http://localhost').pathname.replace(/^\/life-rpg\//,'').replace(/^\//,'')||'index.html';
  if(!allowed.has(name)){res.writeHead(404);res.end('Not found');return;}
  res.writeHead(200,{'Content-Type':types[path.extname(name)],'Cache-Control':'no-cache'});res.end(fs.readFileSync(path.join(root,name)));
}).listen(port,'127.0.0.1',()=>console.log('Preview: http://127.0.0.1:'+port+'/life-rpg/?demo=1'));
