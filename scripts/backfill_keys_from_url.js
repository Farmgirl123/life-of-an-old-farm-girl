#!/usr/bin/env node
/**
 * Backfill `key` in data/*.json from existing S3 (or /uploads) URLs.
 * Does not upload files; only updates JSON to include `key` and normalizes URLs.
 *
 * Usage:
 *   node scripts/backfill_keys_from_url.js --root /path/to/project
 *
 * Env (optional): S3_PUBLIC_URL_BASE (to rewrite URLs to your CDN domain)
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const args = process.argv.slice(2);
function arg(name, def=null){
  const i = args.indexOf(name);
  if(i === -1) return def;
  return args[i+1];
}
const root = arg('--root') || process.cwd();
const S3_PUBLIC_URL_BASE = (process.env.S3_PUBLIC_URL_BASE || '').replace(/\/+$/,'');

async function readJSON(file, fallback){
  try{ return JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch{ return fallback; }
}
async function writeJSONBackup(dstFile, data){
  const backupFile = `${dstFile}.${Date.now()}.bak`;
  try{
    if(fs.existsSync(dstFile)){
      await fsp.copyFile(dstFile, backupFile);
      console.log('Backup:', backupFile);
    }
  }catch{}
  await fsp.writeFile(dstFile, JSON.stringify(data, null, 2));
  console.log('Wrote:', dstFile);
}
function extractKey(url){
  try{
    const u = new URL(url, 'http://dummy');
    const path = u.pathname.replace(/^\/+/, '');
    // If path starts with uploads/{type}/filename, convert to {type}/filename
    if(path.startsWith('uploads/')) return path.replace(/^uploads\//,'');
    return path.replace(/^\/+/, '');
  }catch{
    // relative like /uploads/type/file
    return url.replace(/^\/+/, '').replace(/^uploads\//,'');
  }
}

async function backfill(type){
  const file = path.join(root, 'data', `${type}.json`);
  const list = await readJSON(file, []);
  if(list.length === 0){ console.log(`No entries for ${type}`); return; }
  for(const item of list){
    if(type === 'videos' && item.youtubeId) continue;
    if(!item.key && item.url){
      item.key = extractKey(item.url);
    }
    if(S3_PUBLIC_URL_BASE && item.key){
      item.url = `${S3_PUBLIC_URL_BASE}/${item.key}`;
    }
  }
  await writeJSONBackup(file, list);
}

(async function main(){
  for(const t of ['photos','videos','sponsors']){
    await backfill(t);
  }
  console.log('✅ Backfill complete.');
})().catch(e => { console.error(e); process.exit(1); });
