import "./shims";
import "@excalidraw/excalidraw/index.css";
import "./app.css";
import { CaptureUpdateAction, Excalidraw, getSceneVersion } from "@excalidraw/excalidraw";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { callCapability, notify, on, request } from "./bridge";
import { toScene, type Camera, type RawElement } from "./scene";

interface DiagramState {
  readonly checkpointId?: string;
  readonly title?: string;
  readonly elements?: readonly RawElement[];
}
interface HostContext {
  readonly theme?: string;
  readonly displayMode?: string;
  readonly formFactor?: string;
  readonly availableDisplayModes?: readonly string[];
}

const TOOLBAR_HEIGHT = 40;
const EDIT_SYNC_DELAY_MS = 1200;

type Api = any;

function stateFrom(params: Record<string, unknown>): DiagramState | undefined {
  const args = (params.arguments ?? params) as Record<string, unknown>;
  const state = (args.state ?? args) as DiagramState;
  return Array.isArray(state?.elements) ? state : undefined;
}

function fitCamera(api: Api, camera: Camera | null) {
  if (!camera) {
    api.scrollToContent(undefined, { fitToViewport: true, viewportZoomFactor: 0.9 });
    return;
  }
  const { width, height } = api.getAppState();
  if (!width || !height) return;
  // 4% inset: agents often set the camera flush with the outermost elements, whose strokes then get clipped.
  const zoom = Math.min(30, Math.max(0.1, 0.96 * Math.min(width / camera.width, height / camera.height)));
  api.updateScene({
    appState: {
      zoom: { value: zoom },
      scrollX: -camera.x + (width / zoom - camera.width) / 2,
      scrollY: -camera.y + (height / zoom - camera.height) / 2,
    },
    captureUpdate: CaptureUpdateAction.NEVER,
  });
}

function App() {
  const [diagram, setDiagram] = useState<DiagramState>();
  const [host, setHost] = useState<HostContext>({});
  const [api, setApi] = useState<Api>();
  const [status, setStatus] = useState<{ text: string; error?: boolean }>();
  const [sharing, setSharing] = useState(false);
  const baseline = useRef<number>(-1);
  const editTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const offs = [
      on("ui/notifications/tool-input", (params) => {
        const next = stateFrom(params);
        if (next) setDiagram(next);
      }),
      on("ui/notifications/host-context-changed", (params) => setHost((current) => ({ ...current, ...(params as HostContext) }))),
    ];
    request<{ hostContext?: HostContext }>("ui/initialize", {
      protocolVersion: "2026-01-26",
      appInfo: { name: "Excalidraw", version: "0.1.0" },
      hostChrome: "compact",
    })
      .then((result) => {
        if (result?.hostContext) setHost(result.hostContext);
        notify("ui/notifications/initialized");
      })
      .catch((error: Error) => setStatus({ text: error.message, error: true }));
    return () => offs.forEach((off) => off());
  }, []);

  const scene = useMemo(() => {
    try {
      return diagram?.elements ? toScene(diagram.elements) : undefined;
    } catch (error) {
      setStatus({ text: `Could not draw this diagram: ${(error as Error).message}`, error: true });
      return undefined;
    }
  }, [diagram]);

  const editing = host.displayMode === "fullscreen";
  const canFullscreen = (host.availableDisplayModes ?? ["fullscreen"]).includes("fullscreen");
  const theme = host.theme === "dark" ? "dark" : "light";
  const checkpointId = diagram?.checkpointId;

  useEffect(() => {
    if (editing) return;
    const report = () => {
      const height = Math.round(Math.min(560, Math.max(240, window.innerWidth * 0.75)) + TOOLBAR_HEIGHT);
      notify("ui/notifications/size-changed", { height });
    };
    report();
    addEventListener("resize", report);
    return () => removeEventListener("resize", report);
  }, [editing]);

  // Text is measured when the scene is converted, which happens before Excalifont has loaded, so convert
  // again once it has; then record the rendered scene once per checkpoint so export/save use this layout.
  useEffect(() => {
    if (!api || !scene || !checkpointId || !diagram?.elements) return;
    const raw = diagram.elements;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      const sample = raw.map((element) => [element.text, (element.label as { text?: unknown } | undefined)?.text].filter((text) => typeof text === "string").join("")).join("");
      await document.fonts.load("20px Excalifont", sample || "A").catch(() => undefined);
      await document.fonts.ready;
      if (cancelled) return;
      api.updateScene({ elements: toScene(raw).elements as never, captureUpdate: CaptureUpdateAction.NEVER });
      fitCamera(api, scene.camera);
      const elements = api.getSceneElements();
      baseline.current = getSceneVersion(elements);
      void callCapability("excalidraw.view.sync", { checkpointId, elements, edited: false }).catch(() => undefined);
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [api, scene, checkpointId, diagram]);

  useEffect(() => {
    if (!api || !scene || editing) return;
    const refit = () => fitCamera(api, scene.camera);
    const timer = window.setTimeout(refit, 60);
    addEventListener("resize", refit);
    return () => {
      window.clearTimeout(timer);
      removeEventListener("resize", refit);
    };
  }, [api, scene, editing]);

  const onChange = useCallback(
    (elements: readonly { isDeleted?: boolean }[]) => {
      if (!editing || !checkpointId || baseline.current < 0) return;
      const version = getSceneVersion(elements as never);
      if (version === baseline.current) return;
      window.clearTimeout(editTimer.current);
      editTimer.current = window.setTimeout(() => {
        baseline.current = version;
        const live = elements.filter((element) => !element.isDeleted);
        callCapability("excalidraw.view.sync", { checkpointId, elements: live, edited: true })
          .then(() => setStatus({ text: "Edits saved to the diagram." }))
          .catch((error: Error) => setStatus({ text: `Edits not saved: ${error.message}`, error: true }));
      }, EDIT_SYNC_DELAY_MS);
    },
    [editing, checkpointId],
  );

  const setMode = (mode: "inline" | "fullscreen") =>
    void request("ui/request-display-mode", { mode }).catch((error: Error) => setStatus({ text: error.message, error: true }));

  const share = async () => {
    if (!checkpointId || sharing) return;
    setSharing(true);
    setStatus({ text: "Uploading to excalidraw.com…" });
    try {
      const { url } = await callCapability<{ url: string }>("excalidraw.export", { checkpointId });
      await request("ui/open-link", { url });
      setStatus({ text: "Opened in excalidraw.com." });
    } catch (error) {
      setStatus({ text: `Could not open in Excalidraw: ${(error as Error).message}`, error: true });
    } finally {
      setSharing(false);
    }
  };

  return (
    <div className={`frame ${theme} ${editing ? "editing" : "inline"}`}>
      <header className="toolbar">
        <span className="title">{diagram?.title ?? "Excalidraw diagram"}</span>
        {status ? <span className={`status ${status.error ? "error" : ""}`}>{status.text}</span> : null}
        <span className="actions">
          {checkpointId ? (
            <button type="button" onClick={share} disabled={sharing} title="Upload to excalidraw.com and open it">
              Open in Excalidraw
            </button>
          ) : null}
          {canFullscreen ? (
            <button type="button" className="primary" onClick={() => setMode(editing ? "inline" : "fullscreen")}>
              {editing ? "Done" : "Edit"}
            </button>
          ) : null}
        </span>
      </header>
      <main className="canvas">
        {scene ? (
          <Excalidraw
            key={checkpointId ?? "diagram"}
            excalidrawAPI={setApi}
            initialData={{ elements: scene.elements as never, appState: { viewBackgroundColor: "#ffffff" } }}
            viewModeEnabled={!editing}
            zenModeEnabled={!editing}
            theme={theme}
            onChange={onChange as never}
            detectScroll={false}
            handleKeyboardGlobally={false}
            UIOptions={{
              canvasActions: {
                loadScene: false,
                saveToActiveFile: false,
                export: false,
                saveAsImage: false,
                toggleTheme: false,
              },
            }}
          />
        ) : (
          <div className="empty">{status?.error ? "" : "Waiting for the diagram…"}</div>
        )}
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
