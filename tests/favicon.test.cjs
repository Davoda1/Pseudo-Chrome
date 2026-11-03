'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {loadFavicon,faviconData,safeSvg}=require('../app/lib/favicon.cjs');
const svg='<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"><stop stop-color="red"/></linearGradient><path id="p" d="M0 0h8v8z"/></defs><use href="#p" fill="url( #g )"/></svg>';

test('safe SVG favicons support local gradients and charset data URLs without active or external content',async()=>{
  assert.equal(safeSvg(Buffer.from(svg)),true);
  assert.equal(safeSvg(Buffer.from(svg.replace('href="#p"','href=" #p"').replace('url( #g )',"url( '#g' )"))),true);
  const session={fetch:()=>{throw new Error('Data favicon must not use network');}};
  const icon=await loadFavicon(session,'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg),'http://127.0.0.1:43881/');
  assert.equal(icon,'data:image/svg+xml;base64,'+Buffer.from(svg).toString('base64'));
  for(const content of ['<script>alert(1)</script>','<path onload="alert(1)"/>','<image href="https://outside.example/image.png"/>','<use href="https://outside.example/icon.svg#p"/>','<path fill="url(https://outside.example/a.svg#g)"/>','<style>@import "https://outside.example/a.css"</style>']){
    assert.equal(faviconData(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">'+content+'</svg>'),'image/svg+xml'),'');
  }
});
test('favicon fetching resolves relative sources with the website session and validates redirects',async()=>{
  const calls=[];const session={fetch:async(url,options)=>{calls.push({url,options});return calls.length===1?new Response(null,{status:302,headers:{location:'/new.svg'}}):new Response(svg,{headers:{'content-type':'image/svg+xml; charset=utf-8'}});}};
  assert.match(await loadFavicon(session,'icons/current.svg','http://127.0.0.1:43881/folder/page'),/^data:image\/svg\+xml;base64,/);
  assert.deepEqual(calls.map(x=>x.url),['http://127.0.0.1:43881/folder/icons/current.svg','http://127.0.0.1:43881/new.svg']);
  assert.ok(calls.every(x=>x.options.credentials==='include'&&x.options.redirect==='manual'));
  for(const location of ['file:///private/icon.svg','data:image/png;base64,AAAA','http://user:password@example.test/icon.png']){
    let fetched=0;assert.equal(await loadFavicon({fetch:async()=>{fetched++;return new Response(null,{status:302,headers:{location}});}},'/icon','http://127.0.0.1:43881/'),'');assert.equal(fetched,1);
  }
});
test('favicon responses are bounded and unknown or failed content is ignored',async()=>{
  assert.equal(faviconData(Buffer.alloc(256*1024+1),'image/png'),'');
  assert.equal(await loadFavicon({},'data:image/png;base64,'+Buffer.alloc(256*1024+1).toString('base64'),'http://127.0.0.1:43881/'),'');
  assert.equal(faviconData(Buffer.from('<html>not an image</html>'),'text/html'),'');
  const get=response=>loadFavicon({fetch:async()=>response},'/favicon.ico','http://127.0.0.1:43881/');
  assert.equal(await get(new Response('missing',{status:404})), '');
  assert.equal(await get(new Response(svg,{headers:{'content-length':String(256*1024+1),'content-type':'image/svg+xml'}})), '');
  assert.equal(await get(new Response(Buffer.alloc(256*1024+1),{headers:{'content-type':'image/png'}})), '');
  let redirects=0;assert.equal(await loadFavicon({fetch:async()=>{redirects++;return new Response(null,{status:302,headers:{location:'/again'}});}},'/first','http://127.0.0.1:43881/'),'');assert.equal(redirects,5);
});
