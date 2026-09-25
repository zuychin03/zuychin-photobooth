"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CameraController, listCameras, type CameraDevice, type CameraError, type Facing } from "@/lib/camera";

export function useCamera(active = true, deviceId: string | null = null) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<CameraError | null>(null);
  const [controller] = useState(() => new CameraController());
  const [facing, setFacing] = useState<Facing>("user");
  const [cameras, setCameras] = useState<CameraDevice[]>([]);
  const [attempt, setAttempt] = useState(0);

  const attachVideo = useCallback((element: HTMLVideoElement | null) => {
    videoRef.current = element;
    if (element && streamRef.current && element.srcObject !== streamRef.current) {
      element.srcObject = streamRef.current;
      void element.play().catch(() => {});
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const camera = controller;
    camera.setOnEnded(() => {
      if (cancelled) return;
      streamRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
      setReady(false);
      setError("no-camera");
    });
    queueMicrotask(async () => {
      if (cancelled) return;
      setReady(false);
      setError(null);
      if (!active) return;
      const result = await camera.start(facing, deviceId);
      if (cancelled || !result) return;
      if (result.stream && camera.stream !== result.stream) return;
      streamRef.current = result.stream;
      setError(result.error);
      if (result.stream && videoRef.current) {
        videoRef.current.srcObject = result.stream;
        try { await videoRef.current.play(); } catch { /* The next user interaction can resume playback. */ }
      }
      if (cancelled) return;
      setReady(Boolean(result.stream && camera.stream === result.stream));
      const devices = await listCameras();
      if (!cancelled) setCameras(devices);
    });
    return () => {
      cancelled = true;
      camera.stop();
      streamRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
    };
  }, [active, attempt, controller, deviceId, facing]);

  return { videoRef, attachVideo, stream: streamRef, ready, error, facing, cameras, canFlip: cameras.length > 1,
    toggleFacing: useCallback(() => setFacing(value => value === "user" ? "environment" : "user"), []),
    retry: useCallback(() => setAttempt(value => value + 1), []) };
}
