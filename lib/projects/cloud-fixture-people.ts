const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export type CloudFixturePersonIndex = 0 | 1 | 2 | 3;
export type CloudFixturePeopleCount = 2 | 3 | 4;
export function cloudFixturePeople(count: CloudFixturePeopleCount = 2) {
  if (![2, 3, 4].includes(count)) throw new Error("Invalid synthetic group size");
  return ["Alex", "Bao", "Casey", "Dev"].slice(0, count).map((name, index) => ({
    index: index as CloudFixturePersonIndex, ownerId: id(index + 1), name, projectId: id(index < 2 ? (index + 1) * 10 : (index + 2) * 10),
  }));
}
