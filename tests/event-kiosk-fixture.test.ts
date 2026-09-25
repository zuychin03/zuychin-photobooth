import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {createEventKioskFixture} from '../lib/events/kiosk-ui-fixture';
import {createEventKioskClient,kioskPhotoApproval} from '../lib/events/kiosk-client';
const id=()=>crypto.randomUUID();
test('kiosk rehearsal uses real client shapes for lost reservation acknowledgement, old generation recovery and withdrawal',async()=>{
 const photo=new Blob([new Uint8Array(await sharp({create:{width:20,height:30,channels:3,background:'#cf7892'}}).jpeg().toBuffer())],{type:'image/jpeg'}),fixture=await createEventKioskFixture({appOrigin:'https://booth.example',photo}),client=createEventKioskClient(fixture.options);
 try{
  await client.capabilities();const base=await client.session(),ready=await client.reset(base,id()),guest=await client.begin(ready,id());assert.equal((await client.context(guest)).title,'Synthetic garden celebration');
  const request={submissionId:id(),requestId:id(),approval:await kioskPhotoApproval(photo,{submission:true,gallery:false,wall:true},null)};fixture.loseNextReservation();await assert.rejects(client.reserve(guest,request),/lost reservation/);assert.equal(fixture.snapshot().jobs.length,1);const reserved=await client.reserve(guest,request);assert.equal(reserved.receipt.submissionId,request.submissionId);assert.equal(fixture.snapshot().jobs.length,1);
  const next=await client.reset(guest,id());await assert.rejects(client.context(guest),/access_denied/);assert.equal(next.guestId,null);await assert.rejects(client.operator(),/access_denied/);
  fixture.setUploadFailure(true);await assert.rejects(client.upload(guest.generation,request.submissionId,photo,request.approval));fixture.setUploadFailure(false);await client.upload(guest.generation,request.submissionId,photo,request.approval);await client.finalise(guest.generation,request.submissionId);assert.equal((await client.status(guest.generation,request.submissionId)).state,'finalising');fixture.completePending();assert.equal((await client.status(guest.generation,request.submissionId)).state,'ready');
  fixture.withdrawPending();assert.equal((await client.status(guest.generation,request.submissionId)).state,'deleted');fixture.revoke();await assert.rejects(client.status(guest.generation,request.submissionId),/access_denied/);
  assert((await client.unlock('123456',Buffer.alloc(32,7).toString('base64url'))).allowed);assert.equal((await client.exit()).deviceId,guest.deviceId);
 }finally{client.close();await fixture.close();}
});
