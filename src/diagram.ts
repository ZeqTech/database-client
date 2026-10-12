import * as vscode from "vscode";
import { diagramHtml } from "./diagramHtml";
import { Diagram } from "./types";

const panels = new Map<string, DiagramPanel>();

class DiagramPanel {
  private ready = false;
  private pending?: unknown;

  constructor(private readonly key: string, private readonly panel: vscode.WebviewPanel) {
    panel.onDidDispose(() => panels.delete(key));
    panel.webview.onDidReceiveMessage(async (m) => {
      if (m.type === "ready") {
        this.ready = true;
        if (this.pending) panel.webview.postMessage(this.pending);
        this.pending = undefined;
      } else if (m.type === "export") {
        const uri = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file("diagram.svg"),
          filters: { SVG: ["svg"] },
        });
        if (uri) {
          await vscode.workspace.fs.writeFile(uri, Buffer.from(m.svg, "utf8"));
          vscode.window.showInformationMessage(`Exported to ${uri.fsPath}`);
        }
      }
    });
    panel.webview.html = diagramHtml();
  }

  static open(key: string, title: string): DiagramPanel {
    const existing = panels.get(key);
    if (existing) {
      existing.panel.title = title;
      existing.panel.reveal();
      return existing;
    }
    const panel = vscode.window.createWebviewPanel(
      "dbclient.diagram",
      title,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    const p = new DiagramPanel(key, panel);
    panels.set(key, p);
    return p;
  }

  post(msg: unknown): void {
    if (this.ready) this.panel.webview.postMessage(msg);
    else this.pending = msg;
  }
}

/** Opens (or refreshes) the ER diagram panel for one schema. */
export async function showDiagram(
  key: string,
  label: string,
  load: () => Promise<Diagram>,
  focus?: string
): Promise<void> {
  const p = DiagramPanel.open(key, `ER Diagram — ${label}`);
  try {
    const d = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: "Loading diagram…" },
      load
    );
    p.post({ type: "diagram", title: label, tables: d.tables, relations: d.relations, focus });
  } catch (e) {
    p.post({ type: "error", error: e instanceof Error ? e.message : String(e) });
  }
}
