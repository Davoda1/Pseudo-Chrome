'use strict';
const {contextBridge,ipcRenderer}=require('electron');
const commands = new Set(['getState','newTab','selectTab','closeTab','reorderTabs','navigate','back','forward','reload','stop','menu','setOverlay','startMediaPreview','stopMediaPreview','respondPermission','setSitePermission','resetSitePermissions','print','window','saveSettings','saveSiteConfig','restartSite','openWww','openConfig','copyLog','openDevTools','zoom','find','stopFind','clearSiteData','chooseDocumentRoot']);
contextBridge.exposeInMainWorld('pseudoChrome',Object.freeze({
  invoke(command,payload={}) { if(!commands.has(command)) return Promise.reject(new Error('Unknown command')); return ipcRenderer.invoke('pseudo:command',command,payload); },
  onState(callback) { if(typeof callback!=='function')return()=>{};const listener=(_event,state)=>callback(state);ipcRenderer.on('pseudo:state',listener);return()=>ipcRenderer.removeListener('pseudo:state',listener); }
}));
