import { RELAXED_POSE, STORY_DECKS } from "./catalogue";

export interface StoryPlan { readonly version: 1; readonly deckId: string; readonly seed: number; readonly relaxedSteps: readonly number[] }
export function storyCaptureProgress(fireAt: number, intervalMs: number, now: number) {
  if (![fireAt, intervalMs, now].every(Number.isFinite) || intervalMs <= 0) throw new Error("invalid_story_timing");
  const step = Math.min(3, Math.max(0, Math.floor((now - fireAt) / intervalMs) + 1));
  return { step, countdown: Math.max(0, Math.ceil((fireAt + step * intervalMs - now) / 1000)) };
}
export function validateStoryPlan(value: unknown): StoryPlan {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error("invalid_story");
  const entries = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(value);
  if (keys.length !== 4 || keys.some(key => typeof key !== "string" || !["version", "deckId", "seed", "relaxedSteps"].includes(key) || !("value" in entries[key]))) throw new Error("invalid_story");
  const plan = value as StoryPlan;
  if (plan.version !== 1 || !STORY_DECKS.some(deck => deck.id === plan.deckId) || !Number.isSafeInteger(plan.seed) || plan.seed < 0 || plan.seed > 0xffffffff) throw new Error("invalid_story");
  const steps = plan.relaxedSteps;
  if (!Array.isArray(steps) || Object.getPrototypeOf(steps) !== Array.prototype || steps.length > 4 || Reflect.ownKeys(steps).length !== steps.length + 1) throw new Error("invalid_story");
  for (const key of Reflect.ownKeys(steps)) if (typeof key !== "string" || key !== "length" && (!/^[0-3]$/.test(key) || Number(key) >= steps.length || !("value" in Object.getOwnPropertyDescriptor(steps, key)!))) throw new Error("invalid_story");
  if (steps.some(step => !Number.isInteger(step) || step < 0 || step > 3) || new Set(steps).size !== steps.length) throw new Error("invalid_story");
  return Object.freeze({ version: 1, deckId: plan.deckId, seed: plan.seed, relaxedSteps: Object.freeze([...steps].sort((a, b) => a - b)) });
}
export function createStoryPlan(deckId: string, seed = crypto.getRandomValues(new Uint32Array(1))[0]): StoryPlan { return validateStoryPlan({ version: 1, deckId, seed, relaxedSteps: [] }); }
export function relaxStoryStep(plan: StoryPlan, step: number, relaxed: boolean): StoryPlan {
  const current = validateStoryPlan(plan);
  if (!Number.isInteger(step) || step < 0 || step > 3) throw new Error("invalid_story_step");
  return validateStoryPlan({ ...current, relaxedSteps: relaxed ? [...new Set([...current.relaxedSteps, step])] : current.relaxedSteps.filter(item => item !== step) });
}
export function storyStep(plan: StoryPlan, index: number, orderedMemberIds: readonly string[]) {
  const current = validateStoryPlan(plan);
  if (!Number.isInteger(index) || index < 0 || index > 3 || orderedMemberIds.length < 1 || orderedMemberIds.length > 4 || new Set(orderedMemberIds).size !== orderedMemberIds.length || orderedMemberIds.some(id => typeof id !== "string" || !id || id.length > 100)) throw new Error("invalid_story_step");
  const deck = STORY_DECKS.find(item => item.id === current.deckId)!;
  const relaxed = current.relaxedSteps.includes(index);
  return Object.freeze({ title: deck.title, prompt: (relaxed ? RELAXED_POSE : deck.steps[index]), directorId: orderedMemberIds[(current.seed % orderedMemberIds.length + index) % orderedMemberIds.length], relaxed });
}
