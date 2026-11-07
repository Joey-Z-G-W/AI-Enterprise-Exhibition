import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { MaterialAsset, MaterialCommands } from "../lib/presentationCoordinator";

type Entry = { controller: AbortController; objectUrl?: string; element: HTMLImageElement; ready: boolean; settled: Promise<boolean>; settle: (ready: boolean) => void };
// Resource decoding, readiness and DOM lifetime belong to this independent player.
export const MaterialPlayer = forwardRef<MaterialCommands>(function MaterialPlayer(_, ref) {
  const host = useRef<HTMLDivElement>(null);
  const assets = useRef(new Map<string, Entry>());
  const epoch = useRef(0), current = useRef<string | null>(null);
  function clear() {
    ++epoch.current; current.current = null;
    for (const { element, settle, controller, objectUrl } of assets.current.values()) {
      controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl);
      settle(false); element.onload = element.onerror = null; element.removeAttribute("src");
    }
    assets.current.clear(); host.current?.replaceChildren();
  }
  useImperativeHandle(ref, () => ({ clear, prepare(list: MaterialAsset[]) {
    clear(); const generation = epoch.current;
    for (const asset of list) {
      const element = document.createElement("img");
      let settle!: (ready: boolean) => void;
      const entry: Entry = { controller: new AbortController(), element, ready: false, settled: new Promise(resolve => { settle = resolve; }), settle: ready => settle(ready) };
      assets.current.set(asset.id, entry); element.dataset.assetId = asset.id; element.alt = asset.alt;
      const failed = () => {
        if (generation !== epoch.current) return;
        entry.ready = false; settle(false);
        if (current.current === asset.id) { current.current = null; host.current?.replaceChildren(); }
      };
      element.onerror = failed;
      void (async () => {
        try {
          const response = await fetch(asset.url, { signal: entry.controller.signal, cache: "no-store" });
          if (!response.ok) throw Error("Image unavailable");
          const blob = await response.blob();
          if (generation !== epoch.current) return;
          entry.objectUrl = URL.createObjectURL(blob); element.src = entry.objectUrl;
          await element.decode();
          if (generation === epoch.current) { entry.ready = true; settle(true); }
        } catch { failed(); }
      })();
    }
  }, async waitReady(id, signal) {
    const entry = assets.current.get(id), generation = epoch.current;
    if (!entry || signal.aborted) return false;
    return new Promise<boolean>(resolve => {
      let finished = false;
      const done = (ready: boolean) => {
        if (finished) return;
        finished = true; window.clearTimeout(timer); signal.removeEventListener("abort", abort);
        resolve(ready && generation === epoch.current && !signal.aborted);
      };
      const abort = () => done(false);
      const timer = window.setTimeout(() => done(false), 2500);
      signal.addEventListener("abort", abort, { once: true });
      void entry.settled.then(done);
    });
  }, show(id) {
    if (id === current.current) return;
    current.current = null; host.current?.replaceChildren();
    const entry = id && assets.current.get(id);
    // A late decode never paints itself. Only an authorized sentence cue can.
    if (!entry || !entry.ready) return;
    current.current = id; host.current?.replaceChildren(entry.element);
  } }), []);
  useEffect(() => clear, []);
  return <section className="material-player" aria-label="讲解素材"><div ref={host} className="material-surface" /></section>;
});
