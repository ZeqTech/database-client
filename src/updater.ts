import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { compareVersions, newestVsix, vsixVersion } from "./util";

interface Found {
  file: string;
  version: string;
}

const cfg = () => vscode.workspace.getConfiguration("dbclient");

/** Resolves the configured update source (a .vsix file or a folder) to the newest package. */
async function locate(prompt: boolean): Promise<Found | undefined> {
  let source = cfg().get<string>("update.source", "").trim();
  if (!source) {
    if (!prompt) return undefined;
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: "Use as update source",
      title: "Pick a folder containing database-client-*.vsix (or a .vsix file)",
      filters: { VSIX: ["vsix"] },
    });
    if (!picked?.[0]) return undefined;
    source = picked[0].fsPath;
    await cfg().update("update.source", source, vscode.ConfigurationTarget.Global);
  }
  if (!fs.existsSync(source)) {
    if (prompt) vscode.window.showErrorMessage(`Update source not found: ${source}`);
    return undefined;
  }
  if (fs.statSync(source).isFile()) {
    const version = vsixVersion(path.basename(source));
    if (!version) {
      if (prompt) vscode.window.showErrorMessage("File name must look like database-client-<version>.vsix");
      return undefined;
    }
    return { file: source, version };
  }
  const best = newestVsix(fs.readdirSync(source));
  if (!best) {
    if (prompt) vscode.window.showWarningMessage(`No database-client-*.vsix found in ${source}`);
    return undefined;
  }
  return { file: path.join(source, best.name), version: best.version };
}

async function install(file: string, version: string, verb: string): Promise<void> {
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `${verb} Zeq's Database Client ${version}…` },
    () => vscode.commands.executeCommand("workbench.extensions.command.installFromVSIX", vscode.Uri.file(file))
  );
  const pick = await vscode.window.showInformationMessage(
    `Zeq's Database Client ${version} installed. Reload the window to use it.`,
    "Reload Window"
  );
  if (pick) await vscode.commands.executeCommand("workbench.action.reloadWindow");
}

function devGuard(ctx: vscode.ExtensionContext): boolean {
  if (ctx.extensionMode === vscode.ExtensionMode.Production) return false;
  vscode.window.showWarningMessage(
    "Running from source (Extension Development Host). Install the packaged .vsix to use update/reinstall."
  );
  return true;
}

export async function checkForUpdates(ctx: vscode.ExtensionContext, silent = false): Promise<void> {
  if (!silent && devGuard(ctx)) return;
  const current = ctx.extension.packageJSON.version as string;
  const found = await locate(!silent);
  if (!found) return;
  if (compareVersions(found.version, current) > 0) {
    const pick = await vscode.window.showInformationMessage(
      `Zeq's Database Client ${found.version} is available (installed: ${current}).`,
      "Update",
      "Later"
    );
    if (pick === "Update") await install(found.file, found.version, "Updating to");
  } else if (!silent) {
    const pick = await vscode.window.showInformationMessage(
      `Zeq's Database Client is up to date (${current}).`,
      "Reinstall Anyway"
    );
    if (pick) await install(found.file, found.version, "Reinstalling");
  }
}

export async function reinstall(ctx: vscode.ExtensionContext): Promise<void> {
  if (devGuard(ctx)) return;
  const found = await locate(true);
  if (!found) return;
  const ok = await vscode.window.showWarningMessage(
    `Reinstall Zeq's Database Client ${found.version} from ${found.file}? Saved connections are kept.`,
    { modal: true },
    "Reinstall"
  );
  if (ok) await install(found.file, found.version, "Reinstalling");
}
