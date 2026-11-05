import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { MaterialAsset, MaterialCommands } from "../lib/presentationCoordinator";

// Resource readiness and DOM lifetime belong solely to this independent player.
export const MaterialPlayer = forwardRef<MaterialCommands>(function MaterialPlayer(_, ref) {
  const host = useRef<HTMLDivElement>(null);
  const assets = useRef(new Map<string, { element: HTMLImageElement | HTMLVideoElement; ready: boolean }>());
  const epoch = useRef(0), current = useRef<string | null>(null);
  function clear() {
    ++epoch.current; current.current = null;
    for (const { element } of assets.current.values()) {
      element.onload = element.onerror = element.oncanplay = null;
      if (element instanceof HTMLVideoElement) { element.pause(); element.removeAttribute("src"); element.load(); }
      else element.removeAttribute("src");
    }
    assets.current.clear(); host.current?.replaceChildren();
  }
  useImperativeHandle(ref, () => ({ clear, prepare(list: MaterialAsset[]) {
    clear(); const generation = epoch.current;
    for (const asset of list) {
      const element = document.createElement(asset.kind === "image" ? "img" : "video");
      const entry = { element, ready: false }; assets.current.set(asset.id, entry);
      element.dataset.assetId = asset.id;
      const ready = () => { if (generation === epoch.current) entry.ready = true; };
      element.onerror = () => {
        if (generation !== epoch.current) return;
        entry.ready = false; if (current.current === asset.id) { current.current = null; host.current?.replaceChildren(); }
      };
      if (element instanceof HTMLImageElement) { element.alt = asset.alt; element.onload = ready; }
      else { element.muted = true; element.defaultMuted = true; element.playsInline = true; element.preload = "auto"; element.setAttribute("aria-label", asset.alt); element.oncanplay = ready; }
      element.src = asset.url;
    }
  }, show(id) {
    if (id === current.current) return;
    const previous = current.current && assets.current.get(current.current)?.element;
    if (previous instanceof HTMLVideoElement) previous.pause();
    current.current = null; host.current?.replaceChildren();
    const entry = id && assets.current.get(id);
    // A late load never paints itself. Only the next valid cue can select it.
    if (!entry || !entry.ready) return;
    current.current = id; host.current?.replaceChildren(entry.element);
    const generation = epoch.current;
    if (entry.element instanceof HTMLVideoElement) void entry.element.play().catch(() => {
      if (generation === epoch.current && current.current === id) { current.current = null; host.current?.replaceChildren(); }
    });
  } }), []);
  useEffect(() => clear, []);
  return <section className="material-player" aria-label="讲解素材"><div ref={host} className="material-surface" /></section>;
});
