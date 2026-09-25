import test from 'node:test';
import assert from 'node:assert/strict';
import {listPostcardRecovery,recoverBoundPostcard,postcardDisplayedConsent} from '../lib/events/postcard-recovery';
import {EventClientError} from '../lib/events/client';
import {validateTemplateDesign} from '../lib/templates/model';
import {parsePostcardDraft,type PostcardDraft} from '../lib/events/postcard-journal';
import type {PostcardView} from '../lib/events/postcard-contract';
const id=()=>crypto.randomUUID(),guestId=id();
const design=validateTemplateDesign({canvas:{width:536,height:1600},requiredSources:{A:1},slots:[{id:'photo',role:'A',sourceIndex:0,x:0,y:0,width:1,height:1,crop:{zoom:1,offsetX:0,offsetY:0,rotation:0,mirror:false}}],layers:[],decorations:[],look:{frameId:'film',filterId:'none',patternId:'none',themeId:null,sceneId:null,materialId:null},defaults:{caption:'',showDate:false}});
const view:PostcardView={version:1,eventId:id(),postcardId:id(),submissionId:id(),revision:5,state:'candidate',source:{kind:'challenge',id:id()},design,designHash:'a'.repeat(64),expiresAt:new Date(Date.now()+3600000).toISOString(),logicalExpiresAt:null,selfPrincipalId:id(),canSubmit:false,selfConsent:{submission:true,gallery:false,wall:false},participants:[],candidate:null};
const active=()=>{};
test('unavailable or corrupt recovery listing does not prevent an authorised direct postcard view',async()=>{
 for(const journal of [null,{list:async()=>{throw new EventClientError('journal_invalid');}},{list:async()=>{throw new DOMException('Storage failed','QuotaExceededError');}}]){
  assert.deepEqual(await listPostcardRecovery(journal,active),{available:false,drafts:[]});
  const recovered=await recoverBoundPostcard(view,guestId,null,active);assert.equal(recovered.persistent,false);assert.equal(parsePostcardDraft(recovered.draft).proposal.submissionId,view.submissionId);assert.equal(recovered.draft.consentIntent,null);
 }
});
test('full or damaged recovery creates an ephemeral bound view without mutating stored records',async()=>{
 for(const code of ['queue_capacity','journal_invalid','conflict']){let calls=0;const result=await recoverBoundPostcard(view,guestId,{create:async()=>{calls++;throw new EventClientError(code);}},active);assert.equal(calls,1);assert.equal(result.persistent,false);assert.deepEqual(result.draft.proposal.design,view.design);}
});
test('authority loss is never converted to local storage fallback, including after a delayed result',async()=>{
 for(const code of ['identity_changed','access_denied','cancelled']){await assert.rejects(listPostcardRecovery({list:async()=>{throw new EventClientError(code);}},active),new RegExp(code));await assert.rejects(recoverBoundPostcard(view,guestId,{create:async()=>{throw new EventClientError(code);}},active),new RegExp(code));}
 let current=true;await assert.rejects(listPostcardRecovery({list:async()=>{current=false;return [];}},()=>{if(!current)throw new EventClientError('identity_changed');}),/identity_changed/);
});
test('same-guest recovery keeps other source records available for explicit housekeeping',async()=>{
 const one=(await recoverBoundPostcard(view,guestId,null,active)).draft,two:PostcardDraft={...one,proposal:{...one.proposal,postcardId:id(),source:{kind:'challenge',id:id()}}};
 const result=await listPostcardRecovery({list:async()=>[one,two]},active);assert.equal(result.available,true);assert.equal(result.drafts.length,2);assert.equal(result.drafts[1].proposal.source.id,two.proposal.source.id);
});
test('a fresh server revision cannot replace frozen pending consent choices until explicit reconciliation',()=>{
 const pending={expectedRevision:2,consent:{submission:true,gallery:true,wall:false}};
 assert.deepEqual(postcardDisplayedConsent(view,pending),pending.consent);assert.equal(pending.expectedRevision,2);assert.deepEqual(postcardDisplayedConsent(view,null),view.selfConsent);
});
