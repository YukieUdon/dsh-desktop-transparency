/**
* Desktop-only appearance for the Windows product window.
* The window keeps its acrylic material (desktop blur) and is made transparent, so
* every surface the page paints opaque has to give way for the desktop to show
* through. The container class names below are CSS-module hashes, so the functional
* prefix is matched instead of the full name.
* The composer is not hidden behind paint: the transcript scrollport is shortened by
* the composer height and the seat is lifted out of it with position:absolute against
* the body's relative box. Nothing is ever painted behind the composer, so the window
* stays see-through there and no opaque band is needed to cover the transcript. DSH
* already reads the seat's top edge as the bottom of its reading viewport, so the
* shortened scrollport agrees with the app instead of fighting it; the two offsets
* DSH wrote for the old full-height scrollport are re-based at the end of the list.
* Corner rounding is not done in CSS: a material-filled window paints its whole
* rectangle, so clipping the page only reveals material in the corners. DWM rounds
* the window itself instead - see applyWindowsCorners.
*/
var __dshDesktopTransparencyCss = [
	'html,body{background-color:transparent !important}',
	'html[data-platform="win32"] .BynINW_frame{background:${__dshGlassFrameBg} !important;background-image:none !important}',
	'html[data-platform="win32"] [data-windows-titlebar] .BynINW_frame:before{background:${__dshGlassTitlebarBg} !important}',
	'html[data-platform="win32"] .BynINW_centerCol{background:${__dshGlassCenterBg} !important;border-left:0 !important}',
	'html[data-platform="win32"] [class*="Dc7zOa_root"]{background:${__dshGlassChatBg} !important}',
	'html[data-platform="win32"] [class*="Dc7zOa_body"][data-content-phase="active"]:not(:has([data-conversation-composer-overlay])):has([data-composer-seat]) [class*="Dc7zOa_scrollBody"]{flex:0 0 calc(100% - var(--dsh-composer-height,152px)) !important;height:calc(100% - var(--dsh-composer-height,152px)) !important;max-height:calc(100% - var(--dsh-composer-height,152px)) !important}',
	'html[data-platform="win32"] [class*="Dc7zOa_body"][data-content-phase="active"]:not(:has([data-conversation-composer-overlay])):has([data-composer-seat]) [data-composer-seat]{position:absolute !important;left:0 !important;right:var(--dsh-scrollbar-width,0px) !important;bottom:0 !important}',
	'html[data-platform="win32"] [class*="Dc7zOa_body"][data-content-phase="active"]:has([data-composer-seat]) [data-composer-seat]{background:${__dshGlassComposerBg} !important;background-image:none !important}',
	'html[data-platform="win32"] [class*="toBottomSlot"]{bottom:16px !important}',
	'html[data-platform="win32"] [class*="xpvNua_frame"]{--turn-rail-band:var(--dsh-conversation-viewport-height,100dvh) !important}',
	'html[data-platform="win32"] [class*="_emptyTabHost_"]{background:${__dshGlassDockBg} !important}',
	'html[data-platform="win32"] [class*="md-code-block"]{background:${__dshGlassCodeBg} !important}',
	'html[data-platform="win32"] [class*="md-code-block"] *{background:transparent !important}',
	'html[data-platform="win32"] [class*="_dockScrim_"]{display:none !important}',
	'html[data-platform="win32"] [class*="_9lTDKa_fade"]{display:none !important}',
	'html[data-platform="win32"] .BynINW_sidebarCol{background:${__dshGlassSidebarBg} !important}',
	'html[data-platform="win32"] [class*="_2H3hWW_root"]{background:transparent !important}',
	'html[data-platform="win32"] [data-ds-dark-theme] .BynINW_sidebarCol{background:${__dshGlassSidebarDarkBg} !important}'
].join('\n');
/**
* Bounded diagnostic log for the corner treatment, written where the log can be
* read without attaching to the process: <userData>/desktop-corners.log.
* @param message - Line to append.
*/
var __dshDesktopCornerLogCount = 0;
function logDesktopCorners(message) {
	if (__dshDesktopCornerLogCount >= 8) return;
	__dshDesktopCornerLogCount += 1;
	try {
		appendFileSync(join(app.getPath("userData"), "desktop-corners.log"), new Date().toISOString() + " " + message + "\n");
	} catch (error) {}
}
/**
* Resolve the FFI binding for DwmSetWindowAttribute once.
* The desktop host ships koffi inside the package, so no native build step is
* needed; several layouts are probed because the packaged paths differ from a
* source checkout.
* @returns A binding object, or null when FFI is unavailable.
*/
var __dshDesktopCornerApi;
function windowsCornerApi() {
	if (__dshDesktopCornerApi !== void 0) return __dshDesktopCornerApi;
	const hostModules = join("dsh", "node_modules", "@deepseek-ai", "dsh-desktop-host", "node_modules", "koffi");
	const candidates = [
		join(process.resourcesPath, "app.asar", hostModules),
		join(process.resourcesPath, "app.asar.unpacked", hostModules),
		join(app.getAppPath(), hostModules),
		"koffi"
	];
	for (const candidate of candidates) {
		try {
			const localRequire = createRequire(import.meta.url);
			const koffi = localRequire(candidate);
			__dshDesktopCornerApi = {
				setWindowAttribute: koffi.load("dwmapi.dll").func("int DwmSetWindowAttribute(void *hwnd, int attr, int *value, int size)"),
				source: candidate
			};
			logDesktopCorners("koffi loaded from " + candidate);
			return __dshDesktopCornerApi;
		} catch (error) {
			logDesktopCorners("koffi candidate failed: " + candidate + " :: " + String((error && error.message) || error));
		}
	}
	__dshDesktopCornerApi = null;
	logDesktopCorners("no usable FFI binding, leaving corners to Electron's default");
	return null;
}
/**
* Ask DWM for rounded window corners (DWMWA_WINDOW_CORNER_PREFERENCE = ROUND).
* Electron sets DONOTROUND for this window, and a material-filled window paints its
* full rectangle, so this is the only way to get blur and rounding together. It is
* re-applied after every title-bar overlay update and a few times after startup,
* because that overlay path resets the preference.
* @param window - Product window to round.
*/
function applyWindowsCorners(window) {
	if (process.platform !== "win32" || window === void 0 || window.isDestroyed()) return;
	try {
		const api = windowsCornerApi();
		if (api === null) return;
		const handle = window.getNativeWindowHandle();
		const hwnd = handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0));
		const round = Buffer.alloc(4);
		round.writeInt32LE(2, 0);
		const hr = api.setWindowAttribute(hwnd, 33, round, 4);
		logDesktopCorners("DwmSetWindowAttribute(ROUND) hr=" + String(hr));
	} catch (error) {
		logDesktopCorners("applyWindowsCorners failed: " + String((error && error.message) || error));
	}
}
/**
* Install the corner treatment on a product window.
* @param window - Product window to round.
*/
function roundWindowsCorners(window) {
	if (process.platform !== "win32") return;
	applyWindowsCorners(window);
	for (const delay of [500, 2000, 5000]) {
		const timer = setTimeout(() => applyWindowsCorners(window), delay);
		if (typeof timer.unref === "function") timer.unref();
	}
	window.on("show", () => applyWindowsCorners(window));
	window.on("restore", () => applyWindowsCorners(window));
}
/**
* Install the transparency stylesheet into a product window.
* Called on every load, so a reload re-applies it.
* @param window - Window whose page should render transparent.
*/
function installWindowsTransparency(window) {
	const inject = () => {
		if (window.isDestroyed()) return;
		window.webContents.insertCSS(__dshDesktopTransparencyCss).catch(() => {});
	};
	window.webContents.on("did-finish-load", inject);
	window.webContents.on("did-navigate-in-page", inject);
}
function createWindow(preload, show = false, primary = false) {