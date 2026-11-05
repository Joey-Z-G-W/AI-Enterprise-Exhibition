import { forwardRef, type ReactNode } from "react";
export const AvatarPlayer = forwardRef<HTMLVideoElement, { onPlaying: () => void; children: ReactNode }>(function AvatarPlayer({ onPlaying, children }, ref) {
  return <section className="avatar-player" aria-label="数字人"><div className="video-stage">
    <video ref={ref} playsInline autoPlay aria-label="数字人实时画面" onPlaying={onPlaying} />{children}
  </div></section>;
});
