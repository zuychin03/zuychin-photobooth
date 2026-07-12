"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  CameraError,
  Facing,
  hasMultipleCameras,
  startCamera,
  stopStream,
} from "@/lib/camera";

export function useCamera(active = true) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<CameraError | null>(null);
  const [facing, setFacing] = useState<Facing>("user");
  const [canFlip, setCanFlip] = useState(false);

  const start = useCallback(async (nextFacing: Facing) => {
    stopStream(streamRef.current);
    const { stream, error } = await startCamera(nextFacing);
    if (!stream) {
      setReady(false);
      setError(error);
      return;
    }
    setError(null);
    streamRef.current = stream;
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      try {
        await videoRef.current.play();
      } catch {
        // autoplay rejection resolves once the user interacts
      }
    }
    setReady(true);
  }, []);

  // The <video> may mount after start() resolves (recovering from the
  // permission-error state unmounts the preview); attach on mount.
  const attachVideo = useCallback((el: HTMLVideoElement | null) => {
    videoRef.current = el;
    if (el && streamRef.current && el.srcObject !== streamRef.current) {
      el.srcObject = streamRef.current;
      void el.play().catch(() => {});
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    queueMicrotask(() => void start(facing));
    void hasMultipleCameras().then(setCanFlip);
    return () => {
      stopStream(streamRef.current);
      streamRef.current = null;
    };
    // facing changes restart via toggleFacing to avoid double-start loops
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, start]);

  const toggleFacing = useCallback(() => {
    setFacing((f) => {
      const next: Facing = f === "user" ? "environment" : "user";
      void start(next);
      return next;
    });
  }, [start]);

  return {
    videoRef,
    attachVideo,
    stream: streamRef,
    ready,
    error,
    facing,
    canFlip,
    toggleFacing,
    retry: () => void start(facing),
  };
}
