'use strict';
const {safeFavicon}=require('./navigation.cjs');
const MAX_BYTES=256*1024;
const MIMES=new Set(['image/png','image/jpeg','image/gif','image/webp','image/avif','image/x-icon','image/vnd.microsoft.icon','image/svg+xml']);
function safeSvg(bytes){
  const text=bytes.toString('utf8');
  if(!/<svg(?:\s|>)/i.test(text)||!/\bxmlns\s*=\s*["']http:\/\/www\.w3\.org\/2000\/svg["']/i.test(text))return false;
  // SVG is only ever rendered as an image. Also reject active/external constructs
  // before moving its bytes into the trusted UI's image-only data URI.
  if(/<!DOCTYPE|<!ENTITY|<\s*(?:script|foreignObject|iframe|object|embed|image|audio|video)\b|\bon[a-z]+\s*=|@import/i.test(text))return false;
  for(const match of text.matchAll(/\b(?:href|src)\s*=\s*(["'])(.*?)\1/gi))if(!/^#[^\s]*$/.test(match[2].trim()))return false;
  for(const match of text.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi))if(!/^#[^\s]*$/.test(match[2].trim()))return false;
  return true;
}
function faviconData(bytes,mime){
  if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>MAX_BYTES)return '';
  mime=String(mime||'').split(';')[0].trim().toLowerCase();
  if(!MIMES.has(mime)){
    if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))mime='image/png';
    else if(bytes.length>=4&&bytes[0]===0&&bytes[1]===0&&bytes[2]===1&&bytes[3]===0)mime='image/x-icon';
    else return '';
  }
  if(mime==='image/svg+xml'&&!safeSvg(bytes))return '';
  return `data:${mime};base64,${bytes.toString('base64')}`;
}
async function loadFavicon(session,input,base){
  if(typeof input==='string'&&/^data:image\/svg\+xml(?:;charset=(?:utf-8|us-ascii))?(?:;base64)?,/i.test(input)){
    if(input.length>400000)return '';
    try{const comma=input.indexOf(',');const bytes=/;base64,/i.test(input.slice(0,comma+1))?Buffer.from(input.slice(comma+1),'base64'):Buffer.from(decodeURIComponent(input.slice(comma+1)));return faviconData(bytes,'image/svg+xml');}catch{return '';}
  }
  let url=safeFavicon(input,base);if(!url)return '';
  if(url.startsWith('data:')){const comma=url.indexOf(',');return faviconData(Buffer.from(url.slice(comma+1),'base64'),url.slice(5,url.indexOf(';')));}
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),5000);
  try{
    for(let redirect=0;redirect<5;redirect++){
      const response=await session.fetch(url,{credentials:'include',redirect:'manual',signal:controller.signal});
      if([301,302,303,307,308].includes(response.status)){
        const next=safeFavicon(response.headers.get('location'),url);await response.body?.cancel();
        if(!next||next.startsWith('data:'))return '';url=next;continue;
      }
      if(!response.ok||Number(response.headers.get('content-length'))>MAX_BYTES){await response.body?.cancel();return '';}
      const reader=response.body?.getReader();if(!reader)return '';
      const chunks=[];let size=0;
      while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>MAX_BYTES){await reader.cancel();return '';}chunks.push(Buffer.from(part.value));}
      return faviconData(Buffer.concat(chunks),response.headers.get('content-type'));
    }
  }catch{}finally{clearTimeout(timer);}
  return '';
}
module.exports={loadFavicon,faviconData,safeSvg};
