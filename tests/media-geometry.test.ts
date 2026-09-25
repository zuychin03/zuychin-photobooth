import assert from "node:assert/strict";
import test from "node:test";
import { printGeometry, recordingFormatMatches, runMediaProbe } from "../lib/feasibility/media-probe";

test("a two by six inch print resolves to 600 by 1800 pixels at 300 ppi", () => {
  const geometry = printGeometry(50.8, 152.4);
  assert.equal(geometry.widthPx, 600);
  assert.equal(geometry.heightPx, 1800);
  assert.equal(geometry.widthPt, 144);
  assert.ok(Math.abs(geometry.heightPt - 432) < 0.000001);
});

test("two classic strips fit a four by six sheet without changing aspect", () => {
  const strip = printGeometry(50.8, 152.4);
  const sheet = printGeometry(101.6, 152.4);
  assert.equal(sheet.widthPx, 1200);
  assert.equal(sheet.heightPx, 1800);
  assert.equal(sheet.widthPx, strip.widthPx * 2);
  assert.equal(sheet.heightPx, strip.heightPx);
  assert.equal(sheet.widthPt, 288);
  assert.ok(Math.abs(sheet.heightPt - 432) < 0.000001);
});

test("A4 rounds raster dimensions while preserving its physical page size", () => {
  const page = printGeometry(210, 297);
  assert.equal(page.widthPx, 2480);
  assert.equal(page.heightPx, 3508);
  assert.ok(Math.abs(page.widthPt - 595.275590551) < 0.000001);
  assert.ok(Math.abs(page.heightPt - 841.88976378) < 0.000001);
});

test("resolution affects pixels without changing the physical PDF page", () => {
  const geometry = printGeometry(50.8, 152.4, 150);
  assert.equal(geometry.widthPx, 300);
  assert.equal(geometry.heightPx, 900);
  assert.equal(geometry.widthPt, 144);
  assert.ok(Math.abs(geometry.heightPt - 432) < 0.000001);
});

test("invalid or unrepresentable print sizes are rejected", () => {
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => printGeometry(bad, 152.4), RangeError);
    assert.throws(() => printGeometry(50.8, bad), RangeError);
    assert.throws(() => printGeometry(50.8, 152.4, bad), RangeError);
  }
  assert.throws(() => printGeometry(Number.MIN_VALUE, 152.4), RangeError);
  assert.throws(() => printGeometry(Number.MAX_VALUE, 152.4), RangeError);
  assert.throws(() => printGeometry(Number.MAX_VALUE, Number.MAX_VALUE, 1e-300), RangeError);
});

const mp4Header = Uint8Array.from([0, 0, 0, 20, ...Buffer.from("ftypisom"), 0, 0, 0, 0, ...Buffer.from("mp42")]);
const webmHeader = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84, ...Buffer.from("webm")]);

test("recording format requires agreeing MIME types and a matching container header", async () => {
  assert.equal(await recordingFormatMatches("video/mp4;codecs=avc1.42E01E", "video/mp4", new Blob([mp4Header], { type: "video/mp4" })), true);
  assert.equal(await recordingFormatMatches("video/webm;codecs=vp8", "video/webm", new Blob([webmHeader], { type: "video/webm;codecs=vp8" })), true);
});

test("an MP4 request cannot pass when the recorder actually emits WebM", async () => {
  assert.equal(await recordingFormatMatches("video/mp4", "video/webm", new Blob([webmHeader], { type: "video/webm" })), false);
  assert.equal(await recordingFormatMatches("video/mp4", "video/mp4", new Blob([webmHeader], { type: "video/mp4" })), false);
});

test("a WebM request cannot pass when the recorder actually emits MP4", async () => {
  assert.equal(await recordingFormatMatches("video/webm", "video/mp4", new Blob([mp4Header], { type: "video/mp4" })), false);
  assert.equal(await recordingFormatMatches("video/webm", "video/webm", new Blob([mp4Header], { type: "video/webm" })), false);
});

test("missing MIME and truncated or arbitrary container bytes never pass", async () => {
  assert.equal(await recordingFormatMatches("video/mp4", "", new Blob([mp4Header], { type: "video/mp4" })), false);
  assert.equal(await recordingFormatMatches("video/mp4", "video/mp4", new Blob([mp4Header])), false);
  for (const mime of ["video/mp4", "video/webm"]) {
    for (const bytes of [new Uint8Array(), Uint8Array.from([0, 0, 0, 20]), Buffer.from("not a media container")]) {
      assert.equal(await recordingFormatMatches(mime, mime, new Blob([bytes], { type: mime })), false);
    }
  }
});

test("MP4 file-type boxes require an MP4 brand and a bounded complete size", async () => {
  for (const header of [
    Uint8Array.from([0, 0, 0, 20, ...Buffer.from("ftypisom"), 0, 0, 0, 0, ...Buffer.from("qt  ")]),
    Uint8Array.from([0, 0, 4, 0, ...mp4Header.slice(4)]),
    Uint8Array.from([0, 0, 0, 19, ...mp4Header.slice(4)]),
  ]) {
    assert.equal(await recordingFormatMatches("video/mp4", "video/mp4", new Blob([header], { type: "video/mp4" })), false);
  }
});

test("an EBML container must declare the WebM document type", async () => {
  const header = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x88, ...Buffer.from("matroska")]);
  assert.equal(await recordingFormatMatches("video/webm", "video/webm", new Blob([header], { type: "video/webm" })), false);
});

test("a non-browser run never claims that media was recorded", async () => {
  const results = await runMediaProbe();
  assert.equal(results.filter((result) => result.status === "pass").length, 2);
  assert.deepEqual(results.at(-1), { id: "media-browser", status: "unsupported", detail: "Canvas and codec probes require a browser document." });
});
