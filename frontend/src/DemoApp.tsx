import { FormEvent, useEffect, useRef, useState } from "react";
import "./demo.css";

type Citation = { fact_id: string; exhibit_name: string; excerpt: string; source_id: string; sha256: string; license: string };
type Answer = { status: "supported" | "unknown" | "ambiguous" | "conflicting"; text: string; citations: Citation[] };
type Entry = { id: string; request_id: string; question: string; exhibit_id: string | null; answer: Answer; feedback: number | null; created_at: string };
type Session = { visitor_id: string; history: Entry[] };
type Catalog = {
  title: string; disclaimer: string; sha256: string;
  license: { id: string; url: string; statement: string };
  provenance: { author: string; created: string; origin: string; source_id: string };
  exhibits: { id: string; name: string; summary: string; facts: { id: string; text: string }[] }[];
  examples: { id: string; label: string; question: string; exhibit_id?: string; expected_status: string }[];
};
type Submission = { request_id: string; question: string; exhibit_id: string | null };

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  let response: Response;
  try { response = await fetch(path, { credentials: "same-origin", ...options }); }
  catch { throw new Error("The guide could not be reached. Your draft is kept; retry the same submission when it is available."); }
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof payload?.detail === "string" ? payload.detail : "The request could not be completed. Please try again.");
  return payload as T;
}
const json = (value: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
const statusLabels = { supported: "Supported by sample facts", unknown: "Not in the sample catalog", ambiguous: "Choose an exhibit", conflicting: "Conflicting source notes" };

export default function DemoApp() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [release, setRelease] = useState("");
  const [question, setQuestion] = useState("");
  const [exhibit, setExhibit] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmation, setConfirmation] = useState<"clear" | "new" | null>(null);
  const pending = useRef<Submission | null>(null);
  const ratingRequests = useRef(new Map<string, { request_id: string; rating: number }>());
  const questionField = useRef<HTMLTextAreaElement>(null);

  async function load() {
    setBusy(true); setError("");
    try {
      const [nextCatalog, nextSession, health] = await Promise.all([
        api<Catalog>("/api/exhibits"), api<Session>("/api/session"), api<{ release: string }>("/health"),
      ]);
      setCatalog(nextCatalog); setSession(nextSession); setRelease(health.release);
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  }
  useEffect(() => { void load(); }, []);

  function draft(text: string, selected: string) { setQuestion(text); setExhibit(selected); pending.current = null; setError(""); setNotice(""); }
  async function ask(event: FormEvent) {
    event.preventDefault();
    if (busy || !question.trim() || !session) return;
    const body = pending.current ?? { request_id: crypto.randomUUID(), question, exhibit_id: exhibit || null };
    pending.current = body;
    setBusy(true); setError(""); setNotice("");
    try {
      const entry = await api<Entry>("/api/questions", json(body));
      setSession(current => current ? { ...current, history: current.history.some(item => item.id === entry.id) ? current.history : [...current.history, entry] } : current);
      pending.current = null; setQuestion(""); setNotice("Answer saved to this visitor's history.");
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  }
  async function rate(entry: Entry, rating: number) {
    if (busy) return;
    let body = ratingRequests.current.get(entry.id);
    if (!body || body.rating !== rating) { body = { request_id: crypto.randomUUID(), rating }; ratingRequests.current.set(entry.id, body); }
    setBusy(true); setError(""); setNotice("");
    try {
      await api(`/api/questions/${entry.id}/feedback`, json(body));
      setSession(current => current ? { ...current, history: current.history.map(item => item.id === entry.id ? { ...item, feedback: rating } : item) } : current);
      ratingRequests.current.delete(entry.id); setNotice("Feedback saved.");
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  }
  async function confirm() {
    if (busy || !confirmation) return;
    setBusy(true); setError("");
    try {
      if (confirmation === "clear") {
        await api("/api/history", { method: "DELETE" });
        setSession(current => current ? { ...current, history: [] } : current);
        setNotice("Your saved questions and feedback have been cleared.");
      } else {
        setSession(await api<Session>("/api/visitors/new", { method: "POST" }));
        setNotice("A new visitor session is ready.");
      }
      pending.current = null; ratingRequests.current.clear(); setQuestion(""); setExhibit(""); setConfirmation(null);
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  }

  return <div className="demo-app">
    <header className="demo-header"><a className="demo-brand" href="/" aria-label="Future Commons home"><span className="demo-mark">FC</span><span>EXHIBITION GUIDE<small>Fictional public collection</small></span></a><span className="demo-mode">CPU sample mode</span></header>
    <main className="demo-main">
      <section className="demo-intro"><p className="demo-eyebrow">A SMALL EXHIBITION. A CLEARER ANSWER.</p><h1>Future Commons</h1><p>Explore three imagined spaces, ask a question, and see the facts behind the answer.</p><div className="demo-disclosure"><span aria-hidden="true">◎</span> Local sample retrieval, not a live LLM. No GPU or service credentials required.</div></section>
      {error && <div className="demo-alert" role="alert">{error}{!session && <button onClick={() => void load()} disabled={busy}>Retry connection</button>}</div>}
      <p className="demo-notice" role="status" aria-live="polite">{notice || (busy ? "Working…" : "")}</p>
      {!catalog || !session ? <div className="demo-loading">{error ? "The exhibition is temporarily unavailable." : "Opening the exhibition…"}</div> : <>
        <section className="demo-collection" aria-labelledby="collection-title"><div className="demo-section-heading"><h2 id="collection-title">Explore the collection</h2><span>03 fictional exhibits</span></div><div className="demo-exhibits">{catalog.exhibits.map((item, index) => <article key={item.id} className={`demo-exhibit demo-exhibit-${index} ${exhibit === item.id ? "selected" : ""}`}><div className="demo-exhibit-art" aria-hidden="true"><span className="demo-structure"/><span className="demo-exhibit-number">0{index + 1}</span></div><div className="demo-exhibit-copy"><h3>{item.name}</h3><p>{item.summary}</p><button aria-label={`Explore ${item.name}`} disabled={busy} onClick={() => { draft(question, item.id); questionField.current?.focus(); }}>Explore {item.name}</button><details><summary>Read sample facts</summary><ul>{item.facts.map(fact => <li key={fact.id}>{fact.text}<small>{fact.id}</small></li>)}</ul></details></div></article>)}</div></section>
        <div className="demo-workspace">
          <section className="demo-question-panel" aria-labelledby="question-title"><p className="demo-eyebrow">YOUR VISIT</p><h2 id="question-title">Ask the guide</h2><p className="demo-muted">Answers quote the public sample collection. Missing or conflicting information is made explicit.</p><form onSubmit={event => void ask(event)}><label htmlFor="demo-exhibit">Exhibit</label><select id="demo-exhibit" value={exhibit} disabled={busy} onChange={event => draft(question, event.target.value)}><option value="">Find an exhibit from my question</option>{catalog.exhibits.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select><label htmlFor="demo-question">Your question</label><textarea ref={questionField} id="demo-question" required maxLength={2000} rows={4} placeholder="How does Aster Pavilion generate power?" value={question} disabled={busy} onChange={event => draft(event.target.value, exhibit)}/><div className="demo-form-bottom"><small>{question.length}/2000</small><button className="demo-primary" type="submit" disabled={busy || !question.trim()}>Ask the guide</button></div></form><h3 className="demo-example-title">Try a sample question</h3><div className="demo-examples">{catalog.examples.map(example => <button key={example.id} disabled={busy} onClick={() => { draft(example.question, example.exhibit_id ?? ""); questionField.current?.focus(); }}>{example.label}</button>)}</div></section>
          <section className="demo-history-panel" aria-labelledby="history-title"><div className="demo-section-heading"><div><p className="demo-eyebrow">SAVED TO THIS BROWSER VISITOR</p><h2 id="history-title">Your conversation <span className="demo-count">{session.history.length}</span></h2></div><div className="demo-history-actions"><button onClick={() => setConfirmation("clear")} disabled={busy || !session.history.length}>Clear history</button><button onClick={() => setConfirmation("new")} disabled={busy}>New visitor</button></div></div><p className="demo-muted">Questions and ratings survive reloads and service restarts. A new visitor starts with an empty history.</p>
            {confirmation && <div className="demo-confirm" role="group" aria-label="Confirm visitor action"><p>{confirmation === "clear" ? "Delete this visitor's saved questions and ratings?" : "End access to this visitor's history and start a new visitor?"}</p><button className="demo-primary" disabled={busy} onClick={() => void confirm()}>{confirmation === "clear" ? "Confirm clear history" : "Confirm new visitor"}</button><button disabled={busy} onClick={() => setConfirmation(null)}>Cancel</button></div>}
            {!session.history.length ? <div className="demo-empty"><span aria-hidden="true">↗</span><h3>No questions yet.</h3><p>Choose an exhibit or try a sample question to begin.</p></div> : <div className="demo-answers">{[...session.history].reverse().map(entry => <article className="demo-answer" key={entry.id} data-answer-status={entry.answer.status}><p className="demo-question-text">{entry.question}</p><div className={`demo-answer-label ${entry.answer.status}`}>{statusLabels[entry.answer.status]}</div><p className="demo-answer-text">{entry.answer.text}</p>{entry.answer.citations.length > 0 && <div className="demo-citations"><h4>Sample sources</h4>{entry.answer.citations.map(citation => <blockquote key={citation.fact_id}><p>{citation.excerpt}</p><cite>{citation.exhibit_name} · {citation.fact_id} · {citation.license}</cite><details><summary>Source checksum</summary><code>{citation.sha256}</code><p>{citation.source_id}</p></details></blockquote>)}</div>}<div className="demo-feedback"><span>Was this useful?</span><div role="group" aria-label={`Rate answer: ${entry.question}`}>{[1, 2, 3, 4, 5].map(rating => <button key={rating} aria-label={`Rate ${rating} out of 5`} aria-pressed={entry.feedback === rating} disabled={busy} onClick={() => void rate(entry, rating)}>{rating}</button>)}</div><small>{entry.feedback ? `Saved rating: ${entry.feedback}/5` : "1 = not useful · 5 = very useful"}</small></div></article>)}</div>}
          </section>
        </div>
        <footer className="demo-footer"><details><summary>Public sample provenance and license</summary><p>{catalog.disclaimer}</p><p>{catalog.provenance.origin}</p><p>{catalog.provenance.author} · {catalog.provenance.created} · {catalog.provenance.source_id}</p><p>{catalog.license.statement} <a href={catalog.license.url}>{catalog.license.id}</a></p><p>Catalog SHA-256: <code>{catalog.sha256}</code></p></details><small>Release <code>{release}</code> · Visitor <code>{session.visitor_id.slice(0, 8)}</code></small></footer>
      </>}
    </main>
  </div>;
}
