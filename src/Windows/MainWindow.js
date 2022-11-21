import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { BrowserWindow, shell } from "electron";
import styles from "bundle-text:../../assets/styles.css";

const js = fs.readFileSync(new URL("../../dist/cg-renderer/renderer.js", import.meta.url), "utf8");

function mainWindow() {
	let win = new BrowserWindow({
		show: false,
		webPreferences: {
			preload: fileURLToPath(new URL("../../dist/cg-preload/preload.js", import.meta.url)),
			contextIsolation: true,
			nodeIntegration: false,
			webSecurity: false,
			devTools: process.env.NODE_ENV === "development",
		},
	});

	if (process.env.NODE_ENV === "development") win.webContents.openDevTools();
	win.setMenuBarVisibility(false);

	win.loadURL("https://www.geoguessr.com/classic").then(() => {
		// to investigate: loading it a second time seems to resolve map dragging lag issue
		win.loadURL("https://www.geoguessr.com/classic");

		win.webContents.on("dom-ready", async () => {
			await win.webContents.insertCSS(styles);
			await win.webContents.executeJavaScript(js);
		});
	});

	win.webContents.setWindowOpenHandler(({ url }) => {
		shell.openExternal(url);
		return { action: "deny" };
	});

	return win;
}

export default mainWindow();
