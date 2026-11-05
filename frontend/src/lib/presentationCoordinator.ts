export type MaterialAsset = { id: string; kind: "image" | "video"; url: string; mime: string; alt: string };
export type Presentation = { sentences: { id: string; text: string; asset_id: string | null }[]; assets: MaterialAsset[] };
export type PresentationIdentity = { visitorId: string; turnId: string; sessionId: string; generation: number };
export type MaterialCommands = { prepare: (assets: MaterialAsset[]) => void; show: (id: string | null) => void; clear: () => void };
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
// Optional presentation metadata must never invalidate the underlying answer.
export function readPresentation(value: unknown, text: string): Presentation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const p = value as Presentation;
  if (!Array.isArray(p.sentences) || !p.sentences.length || p.sentences.length > 64 || !Array.isArray(p.assets) || p.assets.length > 64) return;
  const assets = new Set<string>(), sentences = new Set<string>();
  for (const a of p.assets) {
    if (!a || typeof a !== "object" || typeof a.id !== "string" || !idPattern.test(a.id) || assets.has(a.id)
      || !["image", "video"].includes(a.kind) || typeof a.url !== "string" || a.url !== `/guide/media/${a.id}`
      || typeof a.alt !== "string" || a.alt.length > 500 || typeof a.mime !== "string"
      || !(a.kind === "image" ? ["image/png", "image/jpeg", "image/webp", "image/gif"] : ["video/mp4", "video/webm"]).includes(a.mime)) return;
    assets.add(a.id);
  }
  for (const s of p.sentences) {
    if (!s || typeof s !== "object" || typeof s.id !== "string" || !idPattern.test(s.id) || sentences.has(s.id)
      || typeof s.text !== "string" || !s.text.trim() || s.text.length > 2000
      || !(s.asset_id === null || typeof s.asset_id === "string" && assets.has(s.asset_id))) return;
    sentences.add(s.id);
  }
  return p.sentences.map(s => s.text).join("") === text ? p : undefined;
}
export function createPresentationCoordinator(player: () => MaterialCommands | null) {
  let epoch = 0;
  let owner: { token: number; identity: PresentationIdentity; plan: Presentation } | undefined;
  return {
    begin(identity: PresentationIdentity, plan: Presentation) {
      player()?.clear(); const token = ++epoch; owner = { token, identity, plan }; player()?.prepare(plan.assets); return token;
    },
    cue(token: number, index: number) { if (owner?.token === token) player()?.show(owner.plan.sentences[index]?.asset_id ?? null); },
    end(token: number) { if (owner?.token === token) { owner = undefined; ++epoch; player()?.clear(); } },
    clear() { owner = undefined; ++epoch; player()?.clear(); },
  };
}
