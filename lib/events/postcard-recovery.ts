import type {PostcardView} from './postcard-contract';
import type {PostcardDraft,PostcardJournal} from './postcard-journal';

function rethrowAuthority(error:unknown) {
  const code=error&&typeof error==='object'&&'code' in error?String(error.code):'';
  if(['access_denied','identity_changed','access_lost','cancelled'].includes(code))throw error;
}

export async function listPostcardRecovery(journal: Pick<PostcardJournal,'list'> | null, assertActive:()=>void):Promise<{available:boolean;drafts:PostcardDraft[]}> {
  assertActive();
  if(!journal)return {available:false,drafts:[]};
  try {const drafts=await journal.list();assertActive();return {available:true,drafts};}
  catch(error) {assertActive();rethrowAuthority(error);return {available:false,drafts:[]};}
}

export async function recoverBoundPostcard(view:PostcardView,guestId:string,journal:Pick<PostcardJournal,'create'>|null,assertActive:()=>void):Promise<{draft:PostcardDraft;persistent:boolean}> {
  assertActive();
  const proposal={postcardId:view.postcardId,submissionId:view.submissionId,source:view.source,design:view.design};
  if(journal)try {const draft=await journal.create(proposal,view.expiresAt);assertActive();return {draft,persistent:true};}catch(error) {assertActive();rethrowAuthority(error);}
  return {draft:{version:1,eventId:view.eventId,guestId,proposal,revision:0,ticketRequestId:crypto.randomUUID(),reserveRequestId:crypto.randomUUID(),expiresAt:view.expiresAt,image:null,receipt:null,consentIntent:null},persistent:false};
}

export function postcardDisplayedConsent(view:PostcardView,pending:PostcardDraft['consentIntent']) {
  return pending?.consent??view.selfConsent;
}
