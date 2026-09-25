import assert from "node:assert/strict";
import test from "node:test";
import { roomCaptureProfile, roomPhotoSize } from "../lib/rtc/workspace-capture";
import { ROOM_LIMITS } from "../lib/server/room-contract";

test("room profiles reserve aggregate media headroom for every intended original", () => {
  for (const members of [2, 3, 4]) for (const shots of [1, 2, 3, 4]) {
    const profile = roomCaptureProfile(members, shots);
    assert.ok(profile.maxPhotoBytes * members * shots <= ROOM_LIMITS.totalPhotoBytes);
    assert.ok(profile.maxPhotoPixels * members * shots <= ROOM_LIMITS.totalPhotoPixels);
    for (const [width, height] of [[8192, 6144], [4032, 3024], [640, 480], [1080, 1920]]) {
      const size = roomPhotoSize(width, height, profile.maxPhotoPixels);
      assert.ok(size.width <= width && size.height <= height && Math.max(size.width, size.height) <= 4096);
      assert.ok(size.width * size.height <= profile.maxPhotoPixels);
    }
  }
  assert.throws(() => roomCaptureProfile(1, 4));
  assert.throws(() => roomCaptureProfile(4, 5));
  assert.throws(() => roomPhotoSize(0, 1080, 100));
});
