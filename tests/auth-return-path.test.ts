import test from 'node:test';
import assert from 'node:assert/strict';
import {safeAuthReturnPath} from '../lib/auth-return-path';

test('auth return targets reject script schemes, external origins and callback user-info redirects',()=>{
 const attacks=[null,undefined,42,'','https://evil.example','//evil.example/path','///evil.example','@evil.example/path','javascript:alert(1)','JaVaScRiPt:alert(1)','data:text/html,unsafe','\\evil.example','/\\evil.example','/\t/evil.example','/\n/evil.example','/safe\r\nLocation:https://evil.example','/%2fexample.test','/%5cexample.test','/%252fexample.test','/%255cexample.test','/%0a/evil.example','/%2509/evil.example','/%zz','/safe/..//evil.example','/safe/%2e%2e//evil.example','/'.repeat(4097)];
 for(const attack of attacks){const path=safeAuthReturnPath(attack);assert.equal(path,'/',String(attack));assert.equal(new URL(path,'https://booth.example').origin,'https://booth.example');}
});
test('auth return targets retain valid internal routes, query values, Unicode and fragments',()=>{
 const targets=['/','/projects/cloud','/challenges/7eb61762-8039-4344-a290-9cedb6d67f35?view=partial#review','/room/ABCD23?v=2&id=example','/events?after=example&title=Birthday%20photos','/projects?return=%2Ftemplates%3Fview%3Dall#saved','/receipt/example?event=example#token=synthetic'];
 for(const target of targets)assert.equal(safeAuthReturnPath(target),target);
 assert.equal(safeAuthReturnPath('/memories?caption=你好#saved'),'/memories?caption=%E4%BD%A0%E5%A5%BD#saved');
 assert.equal(safeAuthReturnPath('/projects/../templates?view=all#design'),'/templates?view=all#design');
});
test('auth return sanitisation is stable through password and callback URL construction',()=>{
 const origin='https://booth.example';
 for(const value of ['@evil.example/a','//evil.example','javascript:alert(1)','/projects/cloud?tab=saved#recent']){
  const fromLogin=safeAuthReturnPath(value),callback=new URL('/auth/callback',origin);callback.searchParams.set('next',fromLogin);
  const fromCallback=safeAuthReturnPath(callback.searchParams.get('next')),destination=new URL(fromCallback,origin);
  assert.equal(fromCallback,fromLogin);assert.equal(destination.origin,origin);assert.equal(destination.username,'');assert.equal(destination.password,'');
 }
});
