import ReactDOM from "react-dom/client";

const root = ReactDOM.createRoot(document.getElementById("root")!);
if (import.meta.env.VITE_GUIDE_MODE === "demo") {
  void import("./DemoApp").then(({ default: DemoApp }) => root.render(<DemoApp />));
} else {
  void Promise.all([import("./App"), import("./style.css")]).then(([{ default: App }]) => root.render(<App />));
}
