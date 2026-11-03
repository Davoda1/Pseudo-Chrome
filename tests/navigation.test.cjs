'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {siteURL,allowedNavigation,safeFavicon,displayURL}=require('../app/lib/navigation.cjs');
const base='http://127.0.0.1:43881/';
test('local navigation keeps routes, queries and fragments within the configured origin',()=>{
  assert.equal(siteURL('/products?item=2#details',base),base+'products?item=2#details');
  assert.equal(siteURL('next.html',base),base+'next.html');
  assert.equal(siteURL('pseudo://settings/website',base),'pseudo://settings/website');
  assert.equal(siteURL('pseudo://about',null),'pseudo://about');
});
test('external and privileged addresses cannot become website tabs',()=>{
  for(const s of ['https://example.com/','//example.com/','file:///etc/passwd','javascript:alert(1)','data:text/html,x','http://127.0.0.1:43882/','http://user:pass@127.0.0.1:43881/','pseudo://settings/unknown'])assert.throws(()=>siteURL(s,base));
  assert.equal(allowedNavigation('http://127.0.0.1:43881/page',base),true);
  for(const s of ['http://127.0.0.1:43881.evil.test/','https://127.0.0.1:43881/','about:blank','file:///tmp/demo','http://127.0.0.1:43882/'])assert.equal(allowedNavigation(s,base),false);
});
test('favicons cannot expose local files or inject active markup into privileged UI',()=>{
  assert.equal(safeFavicon('file:///private.png'),'');assert.equal(safeFavicon('javascript:alert(1)'),'');assert.equal(safeFavicon('data:image/svg+xml,<svg/>'),'');
  assert.equal(safeFavicon('https://example.com/icon.png'),'https://example.com/icon.png');
  assert.equal(safeFavicon('data:image/png;base64,AA=='),'data:image/png;base64,AA==');
});

test('simulated domains are display aliases with local path/query/hash navigation only',()=>{
  assert.equal(displayURL(base+'route?q=1#part',base,'demo.example'),'http://demo.example/route?q=1#part');
  assert.equal(siteURL('http://demo.example/route?q=1#part',base,'demo.example'),base+'route?q=1#part');
  assert.equal(siteURL('demo.example/route?q=1#part',base,'demo.example'),base+'route?q=1#part');
  assert.equal(siteURL('demo.example#part',base,'demo.example'),base+'#part');
  assert.equal(siteURL('http://demo.example//outside.test/path?q=1#part',base,'demo.example'),base+'/outside.test/path?q=1#part');
  for(const value of ['http://demo.example.evil/path','http://name@demo.example/path','http://demo.example:999/path','file://demo.example/path'])assert.throws(()=>siteURL(value,base,'demo.example'));
  assert.equal(displayURL('pseudo://settings',base,'demo.example'),'pseudo://settings');
  assert.equal(displayURL('https://other.test/',base,'demo.example'),'https://other.test/');
});
