import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { validateChallengeCreate, prepareChallengeCreate, type ChallengeCreate, type ChallengeView } from "../lib/memories/challenge-contract";
import { validateChallengeDraft } from "../lib/memories/challenge-drafts";
import { challengeDesign } from "../lib/memories/challenge-ui";
import { STORY_DECKS } from "../lib/stories/catalogue";
import { createStoryPlan, storyStep } from "../lib/stories/model";
import { createChallengeStore } from "../lib/server/challenge-store";
import { createChallengeHandler } from "../lib/server/challenge-requests";
import { createChallengeClient, parseChallengeResponse } from "../lib/memories/challenge-client";
import { createChallengeUIFixture } from "../lib/memories/challenge-ui-fixture";

const owner = "10000000-0000-4000-8000-000000000001", guest = "10000000-0000-4000-8000-000000000002", project = "10000000-0000-4000-8000-000000000003", id = "10000000-0000-4000-8000-000000000004";
const story = createStoryPlan("little-hello", 42);
const input = (): ChallengeCreate => ({ id, ...challengeDesign("duo-alternate", [owner, guest]), policy: "all_submitted", expiresAt: "2030-01-01T00:00:00.000Z" });
const projection = (body: ChallengeCreate): ChallengeView => ({ ...body, projectId: project, status: "open", recipeHash: "a".repeat(64), revealedAt: null, revealHash: null, accessLost: false, members: body.members.map(m => ({ ...m, status: "accepted", submitted: false })), assignments: prepareChallengeCreate(body).assignments, visibleSources: [] });
const env = { PB_CLOUD_PROJECTS_ENABLED: "true", PB_CHALLENGES_ENABLED: "true", PB_PUBLIC_ORIGIN: "https://app.test", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321", SUPABASE_SERVICE_ROLE_KEY: "synthetic-service" };

test("free-pose requests preserve their pre-story public shape and null normalises to omission", () => {
  assert.deepEqual(validateChallengeCreate(input()), input());
  assert.deepEqual(validateChallengeCreate({ ...input(), story: null }), input());
  assert.equal(Object.hasOwn(prepareChallengeCreate(input()), "story"), false);
});

test("guided sparse role assignments cover collective story steps without filling source gaps", () => {
  const prepared = prepareChallengeCreate({ ...input(), story });
  assert.deepEqual(prepared.assignments.map(a => [a.userId, a.sourceIndex]), [[owner, 0], [owner, 2], [guest, 1], [guest, 3]]);
  assert.deepEqual(prepared.story, story);
  assert.equal(storyStep(story, prepared.assignments[1].sourceIndex, [owner, guest]).prompt, STORY_DECKS[0].steps[2]);
  const incomplete = { ...input(), ...challengeDesign("quad", [owner, guest, project, id]), story };
  assert.throws(() => validateChallengeCreate(incomplete));
  assert.doesNotThrow(() => validateChallengeCreate({ ...incomplete, ...challengeDesign("quad-story", [owner, guest, project, id]) }));
});

test("story metadata is strict and bounded with no arbitrary prompt or capability fields", () => {
  for (const bad of [{ ...story, version: 2 }, { ...story, seed: -1 }, { ...story, seed: 2 ** 32 }, { ...story, deckId: "private-prompt" }, { ...story, relaxedSteps: [0, 0] }, { ...story, prompt: "private" }]) assert.throws(() => validateChallengeCreate({ ...input(), story: bad }));
  let invoked = false; const evil = { ...input(), get story() { invoked = true; return story; } };
  assert.throws(() => validateChallengeCreate(evil)); assert.equal(invoked, false);
});

test("SQL story catalogue exactly matches the authored version-one catalogue", async () => {
  const sql = await readFile(new URL("../database/migrations/015_v2_challenge_stories.sql", import.meta.url), "utf8");
  const values = sql.match(/p_story->>'deckId' NOT IN \(([^)]+)\)/)![1].split(",").map(value => value.replaceAll("'", ""));
  assert.deepEqual(values.sort(), STORY_DECKS.map(deck => deck.id).sort());
});

test("version-one recovery remains byte-compatible while version-two freezes story and rejects altered retry", () => {
  const form = { selected: [owner, guest], layoutId: "duo-alternate", policy: "all_submitted", expiresAt: input().expiresAt };
  const base = { version: 1, id, ownerId: owner, projectId: project, challengeId: null, kind: "create", revision: 0, createdAt: "2026-09-23T00:00:00.000Z", updatedAt: "2026-09-23T00:00:00.000Z", state: "pending", form, request: input() };
  assert.deepEqual(validateChallengeDraft(base), base);
  const guided = { ...base, version: 2, form: { ...form, story }, request: { ...input(), story } };
  assert.deepEqual(validateChallengeDraft(guided), guided);
  assert.throws(() => validateChallengeDraft({ ...guided, request: { ...guided.request, story: { ...story, seed: 43 } } }));
  assert.throws(() => validateChallengeDraft({ ...guided, version: 1 }));
  assert.throws(() => validateChallengeDraft({ ...base, version: 3 }), /readonly/);
  assert.doesNotThrow(() => validateChallengeDraft({ ...guided, form: { ...form, story: null }, request: input() }));
});

test("real client-handler-store round trip retains story and capability, and freezes returned context", async () => {
  let current = projection({ ...input(), story });
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const store = await createChallengeStore("synthetic-access", env, {
    authenticate: async () => owner,
    rpc: async (name, args) => {
      calls.push({ name, args });
      return { error: null, data: name === "pb_challenge_capabilities" ? { version: 2, recipeVersion: 1, storyVersion: 1, ready: true, members: 4, slots: 16, sourcesPerMember: 4, proposals: 20, challengesPerProject: 32 } : current };
    },
  });
  const handler = createChallengeHandler({ challenge: async () => store, project: async () => ({ rate: async () => {} }) }, () => env);
  const client = createChallengeClient({ appOrigin: "https://app.test", identity: () => ({ ownerId: owner, epoch: 1 }), accessToken: async () => "synthetic-access", fetch: async (url, init) => handler(new Request(url, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), origin: "https://app.test" } })) });
  assert.equal((await client.capabilities()).storyVersion, 1);
  assert.deepEqual((await client.create(project, { ...input(), story })).story, story);
  assert.deepEqual((calls.at(-1)?.args.p_body as { story: unknown }).story, story);
  current = { ...current, story: { ...story, seed: 43 } };
  await assert.rejects(client.view(id), /invalid_response/); client.close();
});

test("older database permits free pose but rejects guided creation before any mutation", async () => {
  let writes = 0;
  const store = await createChallengeStore("synthetic-access", env, { authenticate: async () => owner, rpc: async name => {
    if (name === "pb_challenge_capabilities") return { data: { version: 2, recipeVersion: 1, ready: true, members: 4, slots: 16, sourcesPerMember: 4, proposals: 20, challengesPerProject: 32 }, error: null };
    writes++; return { data: projection(input()), error: null };
  } });
  assert.equal(store.storyVersion, 0);
  await assert.rejects(store.create(project, { ...input(), story }), /update_required/); assert.equal(writes, 0);
  await store.create(project, input()); assert.equal(writes, 1);
});

test("malformed returned story is rejected while valid metadata cannot smuggle private text", () => {
  const v = projection({ ...input(), story });
  assert.deepEqual(parseChallengeResponse(v, id), v);
  assert.throws(() => parseChallengeResponse({ ...v, story: { ...story, caption: "concealed" } }, id), /invalid_response/);
});

test("development transport retains guided story and conflicts on a changed pending request", async () => {
  const fixture = createChallengeUIFixture({ project: () => ({ ownerId: owner, members: [owner, guest].map(userId => ({ userId, status: "accepted" })) }), accept: () => {}, asset: () => undefined, assets: () => [] });
  const c = createChallengeClient({ appOrigin: "https://app.test", identity: () => ({ ownerId: owner, epoch: 1 }), accessToken: async () => "synthetic-access", fetch: async (_url, init) => fixture.request(JSON.parse(init!.body as string), owner) });
  assert.equal((await c.capabilities()).storyVersion, 1);
  const first = await c.create(project, { ...input(), story });
  assert.deepEqual(first.story, story);
  assert.deepEqual(await c.create(project, { ...input(), story }), first);
  await assert.rejects(c.create(project, { ...input(), story: { ...story, seed: 43 } }), /conflict/);
  const different = await c.create(project, { ...input(), id: "10000000-0000-4000-8000-000000000005", story: { ...story, seed: 43 } });
  assert.notEqual(first.recipeHash, different.recipeHash); c.close();
});
