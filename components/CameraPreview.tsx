"use client";

import { Ref } from "react";

export function CameraPreview({
  videoRef,
  mirror,
  filterCss,
  className = "",
}: {
  videoRef: Ref<HTMLVideoElement>;
  mirror: boolean;
  filterCss: string;
  className?: string;
}) {
  return (
    <video
      ref={videoRef}
      autoPlay
      playsInline
      muted
      className={`h-full w-full object-cover ${className}`}
      style={{
        transform: mirror ? "scaleX(-1)" : undefined,
        filter: filterCss !== "none" ? filterCss : undefined,
      }}
    />
  );
}
