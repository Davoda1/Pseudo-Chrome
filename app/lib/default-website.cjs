'use strict';
const fs=require('node:fs/promises');
const {constants}=require('node:fs');
const path=require('node:path');

// Seed only an empty, unconfigured website. Never replace a user's website or
// site.json, including a configuration whose backend files are still being copied.
async function seedDefaultWebsite({www,source,siteConfig}) {
  await fs.mkdir(www,{recursive:true});
  if((await fs.readdir(www)).length)return false;
  try {await fs.access(siteConfig);return false;} catch(e) {if(e.code!=='ENOENT')throw e;}
  const files=[];
  async function walk(directory,relative='') {
    for(const entry of await fs.readdir(directory,{withFileTypes:true})) {
      const rel=path.join(relative,entry.name);
      if(entry.isDirectory())await walk(path.join(directory,entry.name),rel);
      else if(entry.isFile())files.push(rel);
      else throw new Error('The bundled manual contains an unsupported file.');
    }
  }
  await walk(source);
  // Exclusive copies also preserve a file copied in concurrently by the user.
  for(const relative of files) {
    const destination=path.join(www,relative);
    await fs.mkdir(path.dirname(destination),{recursive:true});
    try {await fs.copyFile(path.join(source,relative),destination,constants.COPYFILE_EXCL);}
    catch(e) {if(e.code!=='EEXIST')throw e;}
  }
  return true;
}
module.exports={seedDefaultWebsite};
