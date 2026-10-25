// Local, offline regression tests. Does not read real browser data or credentials.
const {spawnSync}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path');
const tests=fs.readdirSync(path.join(__dirname,'tests')).filter(f=>f.endsWith('.test.mjs')).sort().map(f=>path.join(__dirname,'tests',f));
const result=spawnSync(process.execPath,['--test',...tests],{stdio:'inherit'});
if(result.error){console.error(result.error.message);process.exit(1);}
process.exit(result.status??1);
