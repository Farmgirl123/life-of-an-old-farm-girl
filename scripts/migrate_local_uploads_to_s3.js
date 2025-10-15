#!/usr/bin/env node
/**
 * Migrate local uploads (old project) to S3 and rewrite data/*.json entries.
 *
 * Usage:
 *   node scripts/migrate_local_uploads_to_s3.js --old /path/to/old-project --new /path/to/new-s3-project
 *
 * Env:
 *   AWS_REGION, S3_BUCKET, S3_PUBLIC_URL_BASE (optional)
 *
 * What it does:
 *   - Uploads files from oldProject/uploads/{photos|videos|sponsors}/** to S3
 *   - Reads oldProject/data/{photos.json,videos.json,sponsors.json}
 *   - For each entry missing `key` or with /uploads/ URL, sets `key` and `url` to S3 URL
 *   - Writes updated JSON files into newProject/data/*.json (backups kept with .bak timestamp)
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const args = process.argv.slice(2);
function arg(name, def=null){
  const i = args.indexOf(name);
  if(i === -1) return def;
  return args[i+1];
}
const oldRoot = arg('--old');
const newRoot = arg('--new') || process.cwd();

if(!oldRoot){
  console.error('ERROR: --old /path/to/old-project is required');
  process.exit(1);
}

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const S3_BUCKET = process.env.S3_BUCKET;
const S3_PUBLIC_URL_BASE = (process.env.S3_PUBLIC_URL_BASE || '').replace(/\/+$/,'');

if(!S3_BUCKET){
  console.error('ERROR: S3_BUCKET env var is required');
  process.exit(1);
}

const s3 = new S3Client({ region: AWS_REGION });

function s3ObjectUrl(key){
  if(S3_PUBLIC_URL_BASE) return `${S3_PUBLIC_URL_BASE}/${key}`;
  const base = AWS_REGION === 'us-east-1'
    ? `https://${S3_BUCKET}.s3.amazonaws.com`
    : `https://${S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com`;
  return `${base}/${key}`;
}

async function ensureDir(p){ await fsp.mkdir(p, { recursive: true }); }

async function uploadFileToS3(localPath, key){
  const body = await fsp.readFile(localPath);
  const ContentType = guessContentType(localPath);
  await s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: key, Body: body, ContentType }));
}

function guessContentType(p){
  const ext = path.extname(p).toLowerCase();
  if(['.jpg','.jpeg'].includes(ext)) return 'image/jpeg';
  if(ext === '.png') return 'image/png';
  if(ext === '.gif') return 'image/gif';
  if(ext === '.webp') return 'image/webp';
  if(ext === '.mp4') return 'video/mp4';
  if(ext === '.mov') return 'video/quicktime';
  return 'application/octet-stream';
}

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

async function migrateType(type){
  const oldUploadsDir = path.join(oldRoot, 'uploads', type);
  const oldDataFile = path.join(oldRoot, 'data', `${type}.json`);
  const newDataFile = path.join(newRoot, 'data', `${type}.json`);

  const list = await readJSON(oldDataFile, []);
  if(list.length === 0){
    console.log(`No entries in ${oldDataFile} — skipping.`);
    return;
  }

  // Map of local filename -> key for quick lookups
  const files = fs.existsSync(oldUploadsDir) ? await fsp.readdir(oldUploadsDir) : [];
  const fileSet = new Set(files);

  for(const item of list){
    // Skip YouTube entries in videos
    if(type === 'videos' && item.youtubeId) continue;

    // Try to infer key from url like /uploads/{type}/{filename}
    let key = item.key;
    if(!key){
      if(item.url && item.url.includes(`/uploads/${type}/`)){
        const filename = item.url.split(`/uploads/${type}/`).pop();
        key = `${type}/${filename}`;
      }else if(item.name){
        // fallback: use original name
        const safe = item.name.replace(/\s+/g, '_');
        key = `${type}/${Date.now()}-${safe}`;
      }
    }
    item.key = key;

    // Ensure uploaded
    const filename = key.split('/').pop();
    const localFile = path.join(oldUploadsDir, filename);
    if(fileSet.has(filename)){
      console.log(`Uploading ${type}/${filename} -> s3://${S3_BUCKET}/${key}`);
      await uploadFileToS3(localFile, key);
      item.url = s3ObjectUrl(key);
    }else if(item.url && /^https?:\/\//.test(item.url)){
      // Already remote — just keep url and key if sensible
      console.log(`Skipping upload (remote url) for ${item.name || filename}`);
    }else{
      console.warn(`WARNING: Missing local file for entry:`, item);
    }
  }

  await ensureDir(path.join(newRoot, 'data'));
  await writeJSONBackup(newDataFile, list);
}

(async function main(){
  console.log('Migrating from:', oldRoot);
  console.log('Writing updated JSONs into:', path.join(newRoot, 'data'));
  for(const t of ['photos','videos','sponsors']){
    await migrateType(t);
  }
  console.log('✅ Migration complete.');
})().catch(e => { console.error(e); process.exit(1); });
