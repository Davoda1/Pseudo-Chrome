'use strict';
const INTERNAL = new Set(['welcome','settings','about']);
async function loadSiteURL(webContents, url) {
  try { await webContents.loadURL(url); }
  catch (error) {
    // Replacing a pending load (or pressing Stop) is normal browser behavior.
    // Electron can reject the new promise with the old load's -3 error and an
    // empty code string. Other failures still reject; did-fail-load also keeps
    // the current page's genuine errors visible independently of this promise.
    if (error.code !== 'ERR_ABORTED' && error.errno !== -3) throw error;
  }
}
function siteURL(input, base, simulatedDomainName='') {
  if (typeof input !== 'string' || input.length > 16384) throw new Error('Enter a local website address.');
  input = input.trim();
  if (/^pseudo:\/\//i.test(input)) {
    const route = input.replace(/^pseudo:\/\//i,'').replace(/\/$/,'');
    const [kind,section,...rest]=route.split('/');
    if (!INTERNAL.has(kind)||rest.length||(section&&(kind!=='settings'||!['appearance','website','startup','about'].includes(section)))) throw new Error('Unknown application page.');
    return 'pseudo://' + route;
  }
  if (!base) throw new Error('Start the website before navigating.');
  const origin = new URL(base).origin;
  if (!input) return new URL('/',base).href;
  if(simulatedDomainName){
    let candidate=input;
    if(candidate.toLowerCase()===simulatedDomainName.toLowerCase()||candidate.toLowerCase().startsWith(simulatedDomainName.toLowerCase()+'/')||candidate.toLowerCase().startsWith(simulatedDomainName.toLowerCase()+'?')||candidate.toLowerCase().startsWith(simulatedDomainName.toLowerCase()+'#'))candidate='http://'+candidate;
    try{const alias=new URL(candidate);if(['http:','https:'].includes(alias.protocol)&&alias.hostname.toLowerCase()===simulatedDomainName.toLowerCase()&&!alias.port&&!alias.username&&!alias.password){const local=new URL(origin);local.pathname=alias.pathname;local.search=alias.search;local.hash=alias.hash;return local.href;}}catch{}
  }
  if (/^(localhost|127\.0\.0\.1|\[::1\])(?=[:/]|$)/i.test(input)) input = 'http://' + input;
  const value = new URL(input, base);
  if (!['http:','https:'].includes(value.protocol) || value.origin !== origin || value.username || value.password) {
    throw new Error('Only this demonstration website can be opened. External images, fonts and API requests remain available.');
  }
  return value.href;
}
function allowedNavigation(url, base) {
  if (!base || typeof url !== 'string') return false;
  try { const u=new URL(url), b=new URL(base); return ['http:','https:'].includes(u.protocol) && u.origin===b.origin && !u.username && !u.password; } catch { return false; }
}
function safeFavicon(url,base) {
  if (typeof url !== 'string' || url.length>400000) return '';
  try { const u=new URL(url,base); if ((u.protocol==='http:'||u.protocol==='https:')&&!u.username&&!u.password) return u.href; if (/^data:image\/(png|gif|jpeg|webp|avif|x-icon|vnd\.microsoft\.icon);base64,[a-z0-9+/=\r\n]+$/i.test(url)) return url; } catch {}
  return '';
}
function displayURL(url,base,simulatedDomainName=''){
  if(!simulatedDomainName||!allowedNavigation(url,base))return url;
  const value=new URL(url);return 'http://'+simulatedDomainName+value.pathname+value.search+value.hash;
}
module.exports={siteURL,allowedNavigation,safeFavicon,displayURL,loadSiteURL};
