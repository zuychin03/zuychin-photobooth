import test from "node:test";
import assert from "node:assert/strict";
import { challengePath, challengeSignInPath, loadChallengeEntry } from "../lib/memories/challenge-entry";
import { challengeDesign } from "../lib/memories/challenge-ui";
import { prepareChallengeCreate, type ChallengeResult, type ChallengeView } from "../lib/memories/challenge-contract";
import type { CloudProjectView } from "../lib/projects/cloud-contract";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const owner = id(1), guest = id(2), challenge = id(3), project = id(4);
function fixture(status: ChallengeView["members"][number]["status"] = "accepted") {
  const prepared = prepareChallengeCreate({ id: challenge, ...challengeDesign("duo-alternate", [owner, guest]), policy: "all_submitted", expiresAt: "2030-01-01T00:00:00Z" });
  let view: ChallengeResult = { ...prepared, projectId: project, status: "draft", recipeHash: "a".repeat(64), revealedAt: null, revealHash: null, accessLost: false, members: prepared.members.map(m => ({ ...m, status: m.userId === guest ? status : "accepted", submitted: false })), visibleSources: [] };
  let account = true;
  const calls: string[] = [];
  const p: CloudProjectView = { project: { id: project, ownerId: owner, kind: "friend", title: "Together", maxBytes: 64 * 1024 * 1024, status: "active", createdAt: "2026-01-01T00:00:00Z" }, members: [{ userId: owner, status: "accepted" }, { userId: guest, status: "accepted" }], assets: [] };
  const active = (signal?: AbortSignal) => { if (!account) throw { code: "account_changed" }; if (signal?.aborted) throw { code: "cancelled" }; };
  const clients = { client: { ownerId: guest, assertActive: active, view: async () => { calls.push("project"); return p; } }, challenges: { ownerId: guest, assertActive: active, view: async () => { calls.push("challenge"); return view; } } };
  return { clients, calls, project: p, view: () => view, setView(value: ChallengeResult) { view = value; }, logout() { account = false; } };
}
const code = (name: string) => (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === name);
test("direct challenge path and sign-in return are UUID-only local routes", () => {
  assert.equal(challengePath(challenge), `/challenges/${challenge}`); assert.equal(challengeSignInPath(challenge), `/login?next=${encodeURIComponent(`/challenges/${challenge}`)}`);
  for (const value of ["../", "//foreign.test", "javascript:alert(1)", `${challenge}?actor=${guest}`, ""]) assert.throws(() => challengePath(value));
});
test("invited and declined challenge views never fetch project media or auto-accept", async () => {
  for (const status of ["invited", "declined"] as const) {
    const f = fixture(status), result = await loadChallengeEntry(challenge, f.clients); assert.equal(result.kind, "invitation"); assert.deepEqual(f.calls, ["challenge"]);
  }
});
test("accepted challenge entry checks current project membership then refreshes the challenge", async () => {
  const f = fixture(), result = await loadChallengeEntry(challenge, f.clients);
  assert.equal(result.kind, "ready"); assert.deepEqual(f.calls, ["challenge", "project", "challenge"]);
  if (result.kind === "ready") assert.equal(result.project.project.id, result.view.projectId);
});
test("unsupported legacy challenge has an explicit state without project access", async () => {
  const f = fixture(); f.setView({ id: challenge, projectId: project, unsupported: true, reason: "recipe_unavailable" });
  assert.equal((await loadChallengeEntry(challenge, f.clients)).kind, "unsupported"); assert.deepEqual(f.calls, ["challenge"]);
});
test("foreign project, revoked membership and account changes fail before exposing a ready entry", async () => {
  const a = fixture(); a.project.project.id = id(10); await assert.rejects(loadChallengeEntry(challenge, a.clients), code("access_denied"));
  const b = fixture(); b.project.members[1].status = "revoked"; await assert.rejects(loadChallengeEntry(challenge, b.clients), code("access_denied"));
  const c = fixture(); c.clients.client.view = async () => { c.logout(); return c.project; }; await assert.rejects(loadChallengeEntry(challenge, c.clients), code("account_changed"));
  const d = fixture(); d.clients.challenges.ownerId = owner; await assert.rejects(loadChallengeEntry(challenge, d.clients), code("account_changed")); assert.deepEqual(d.calls, []);
});
test("access loss between project read and final challenge read rejects the entry", async () => {
  const f = fixture(); let count = 0;
  f.clients.challenges.view = async () => { if (++count === 2) throw { code: "access_denied" }; return f.view(); };
  await assert.rejects(loadChallengeEntry(challenge, f.clients), code("access_denied"));
});
test("aborting while a project read settles cannot return private state", async () => {
  const f = fixture(), abort = new AbortController();
  f.clients.client.view = async () => { abort.abort(); return f.project; };
  await assert.rejects(loadChallengeEntry(challenge, f.clients, abort.signal), code("cancelled"));
});
