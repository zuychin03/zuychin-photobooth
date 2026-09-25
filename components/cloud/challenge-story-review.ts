import { storyStep, type StoryPlan } from "@/lib/stories/model";
import type { ChallengeAssignment } from "@/lib/memories/challenge-contract";

export interface StoryMember { userId: string; role: string }
export function challengeStoryForReview(form: StoryPlan | null | undefined, frozen: { story?: StoryPlan | null } | null): StoryPlan | null {
  return frozen ? frozen.story ?? null : form ?? null;
}
export function challengeHasFourPoses(assignments: readonly ChallengeAssignment[]): boolean {
  const indices = [...new Set(assignments.map(assignment => assignment.sourceIndex))].sort((a, b) => a - b);
  return indices.length === 4 && indices.every((value, index) => value === index);
}
export function challengeStoryPose(plan: StoryPlan, sourceIndex: number, members: readonly StoryMember[]) {
  const ordered = [...members].sort((a, b) => a.role.localeCompare(b.role));
  return { ...storyStep(plan, sourceIndex, ordered.map(member => member.userId)), number: sourceIndex + 1 };
}
