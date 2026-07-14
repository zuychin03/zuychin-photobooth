"use client";

import { Ref } from "react";

export function CameraPreview({
  videoRef,
  mirror,
  filterCss,
  className = "",
  variant = "cover",
}: {
  videoRef: Ref<HTMLVideoElement>;
  mirror: boolean;
  filterCss: string;
  className?: string;
  /** "half-cell": cover-fit to a virtual full cell twice the pane's width and
      show the middle half, matching compose's split-cell crop exactly. */
  variant?: "cover" | "half-cell";
}) {
  const half = variant === "half-cell";
  return (
    <video
      ref={videoRef}
      autoPlay
      playsInline
      muted
      className={`object-cover ${
        half ? "absolute inset-y-0 left-1/2 h-full w-[200%] max-w-none" : "h-full w-full"
      } ${className}`}
      style={{
        transform:
          [half ? "translateX(-50%)" : "", mirror ? "scaleX(-1)" : ""]
            .filter(Boolean)
            .join(" ") || undefined,
        filter: filterCss !== "none" ? filterCss : undefined,
      }}
    />
  );
}
