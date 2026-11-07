// The loading screen. The browser can't repaint a page while the game builds its town on the
// main thread, but animations of transform and opacity run on the compositor thread and
// keep moving anyway, so the spinner and the "still working" line below stay alive through
// the longest wait. The game reports real progress and says when its first frame is on
// screen (scripts/app/load_screen.gd drives window.simWorldLoad); nothing here estimates.
// A start that fails says so here and asks for a reload: an error the page can see, or the
// game going quiet while the page is free to run, both end in that message, because the
// engine's own notice is gone by the time the town is being built.
(function () {
	// Seconds of free main thread with no word from the game before the screen gives up.
	// Blocked time doesn't count: the interval below can't tick while the thread is busy.
	const QUIET_LIMIT = 20;
	const FAILED_TITLE = "Sim World couldn\u2019t start";
	const FAILED_NOTE = 'Something went wrong while it was loading. Please reload the page to try again.';
	const MEGABYTE = 1024 * 1024;
	const UNUSED_VERTEX = '#version 300 es\nvoid main() { gl_Position = vec4(0.0); }\n';
	const UNUSED_FRAGMENT = '#version 300 es\nprecision lowp float;\nout vec4 color;\nvoid main() { color = vec4(0.0); }\n';

	const style = document.createElement('style');
	style.textContent = `
html, body { background: #efe3cf; }
#status { background: transparent !important; z-index: 3; pointer-events: none; }
#status-splash, #status-progress { display: none !important; }
#sw-load {
	position: fixed; inset: 0; z-index: 2; display: flex; flex-direction: column; align-items: center; justify-content: center;
	box-sizing: border-box; padding: 24px 16px; text-align: center; color: #3b3226; cursor: progress; user-select: none;
	font-family: ui-rounded, 'SF Pro Rounded', 'Avenir Next', 'Segoe UI', system-ui, sans-serif;
	background: linear-gradient(180deg, #f8ecd8 0%, #f4dcc0 52%, #bfd8cd 100%);
	transition: opacity 0.35s ease;
}
#sw-load.sw-leaving { opacity: 0; pointer-events: none; }
.sw-badge { position: relative; width: 132px; height: 132px; margin-bottom: 20px; flex: none; }
.sw-badge img { position: absolute; inset: 14px; width: 104px; height: 104px; border-radius: 24px; box-shadow: 0 6px 18px rgba(87, 62, 32, 0.22); }
.sw-spinner {
	position: absolute; inset: 0; box-sizing: border-box; border-radius: 50%;
	border: 5px solid rgba(87, 110, 86, 0.18); border-top-color: #4f8a6b; border-right-color: #e0a34e;
	will-change: transform; animation: sw-turn 1.15s linear infinite;
}
@keyframes sw-turn { to { transform: rotate(360deg); } }
#sw-title { margin: 0; font-size: clamp(22px, 4.5vw, 30px); font-weight: 700; letter-spacing: 0.01em; }
#sw-detail { margin: 8px 0 0; min-height: 1.4em; font-size: clamp(15px, 3.4vw, 17px); color: #5f5444; font-variant-numeric: tabular-nums; }
.sw-track { width: min(340px, 78vw); height: 8px; margin-top: 16px; border-radius: 4px; overflow: hidden; background: rgba(87, 62, 32, 0.14); flex: none; }
#sw-fill { width: 100%; height: 100%; border-radius: 4px; background: #4f8a6b; transform-origin: left center; transform: scaleX(0); transition: transform 0.25s ease-out; }
#sw-note { margin: 16px 0 0; max-width: 30em; min-height: 2.8em; font-size: 14px; line-height: 1.4; color: #6c6050; }
#sw-note.sw-late { opacity: 0; animation: sw-show 0.8s ease 20s forwards; }
@keyframes sw-show { to { opacity: 1; } }
#sw-load.sw-failed { cursor: default; }
#sw-load.sw-failed .sw-spinner { animation: none; visibility: hidden; }
@media (prefers-reduced-motion: reduce) { .sw-spinner { animation-duration: 3s; } }
`;
	document.head.appendChild(style);

	let root = null;
	let title = null;
	let detail = null;
	let fill = null;
	let note = null;
	let gone = false;
	let building = false;
	let quiet = 0;
	let timer = 0;
	let reachedGame = false;
	let stopped = false;
	let stoppedEarly = false;
	let titleBefore = '';

	function setBar(fraction) {
		if (fill) fill.style.transform = 'scaleX(' + Math.max(0, Math.min(1, fraction)) + ')';
	}

	function setNote(text, late) {
		if (!note) return;
		note.classList.remove('sw-late');
		note.textContent = text;
		if (late) note.classList.add('sw-late');
	}

	function leave() {
		if (gone) return;
		gone = true;
		clearInterval(timer);
		holding = false;
		window.requestAnimationFrame = realFrame;
		if (frameWaiters.length) realFrame(runFrameWaiters);
		if (!root) return;
		// The game goes by whether its canvas has the keyboard, and freezes while it hasn't.
		const canvas = document.getElementById('canvas');
		if (canvas && document.hasFocus()) canvas.focus();
		root.classList.add('sw-leaving');
		setTimeout(() => {
			if (gone) root.remove();
		}, 450);
	}

	// From here on the game has the main thread: the next repaint may be a long way off.
	function startBuilding() {
		if (building || gone || !root) return;
		building = true;
		title.textContent = 'Building Willow Bay…';
		detail.textContent = 'Putting the streets, shops and neighbours together.';
		setBar(0);
		setNote('Still building. The first visit takes longest, while your graphics card learns how to draw the town.', true);
	}

	function showDownload() {
		const bar = document.getElementById('status-progress');
		if (building || !bar || !(bar.max > 1)) return;
		setBar(bar.value / bar.max);
		// Bytes coming out of the browser's own storage are no download to speak of.
		const stored = window.simWorldStored;
		if (stored && (!stored.checked || (stored.chunked && !stored.fetched))) return;
		title.textContent = 'Getting Sim World\u2026';
		detail.textContent = Math.round(bar.value / MEGABYTE) + ' of ' + Math.round(bar.max / MEGABYTE) + ' MB';
		setNote(stored && stored.kept ? 'Fetching what has changed since your last visit.' : 'This big download only happens once. After that, Sim World starts much faster.');
	}

	function failed() {
		const notice = document.getElementById('status-notice');
		return notice && notice.style.display === 'block';
	}

	// The start has stopped: no game code will run again to say so, and the engine's own
	// notice can't show once main() has returned, so this screen stays up with the message.
	function stop() {
		if (!root) {
			stoppedEarly = true;
			return;
		}
		if (gone || stopped || failed()) return;
		stopped = true;
		clearInterval(timer);
		titleBefore = title.textContent;
		root.classList.add('sw-failed');
		title.textContent = FAILED_TITLE;
		detail.textContent = '';
		setNote(FAILED_NOTE);
	}

	// Word from the game after all: whatever went wrong didn't stop it (an error from a
	// browser extension, say), so a good start must not stay marked as a failed one.
	function carryOn() {
		if (!stopped) return;
		stopped = false;
		root.classList.remove('sw-failed');
		title.textContent = titleBefore;
		setNote('');
		timer = setInterval(tick, 250);
	}

	// Errors with no error object are browser notices and other sites' scripts.
	window.addEventListener('error', (event) => {
		if (event.error) stop();
	});
	window.addEventListener('unhandledrejection', stop);

	function tick() {
		showDownload();
		if (failed()) {
			// The engine's notice would sit over this screen's title: its words move here.
			const notice = document.getElementById('status-notice');
			stopped = true;
			clearInterval(timer);
			titleBefore = title.textContent;
			root.classList.add('sw-failed');
			title.textContent = FAILED_TITLE;
			detail.textContent = '';
			setNote(notice.textContent);
			notice.style.display = 'none';
			return;
		}
		// The engine's shell removes #status when main() returns. Before that the page is
		// either downloading or blocked, and neither is the game going quiet.
		if (!building && document.getElementById('status')) return;
		quiet += 0.25;
		if (quiet < QUIET_LIMIT) return;
		// Once the game has been playable, a screen left up must not stand in its way.
		if (reachedGame) leave();
		else stop();
	}

	function build() {
		root = document.createElement('div');
		root.id = 'sw-load';
		root.setAttribute('role', 'status');
		root.setAttribute('aria-live', 'polite');
		root.innerHTML = '<div class="sw-badge"><img src="index.apple-touch-icon.png" alt=""><div class="sw-spinner"></div></div>'
			+ '<h1 id="sw-title">Starting Sim World…</h1><p id="sw-detail"></p>'
			+ '<div class="sw-track"><div id="sw-fill"></div></div><p id="sw-note"></p>';
		// A click here must not take the keyboard from the canvas behind the screen.
		root.addEventListener('mousedown', (event) => event.preventDefault());
		document.body.appendChild(root);
		title = document.getElementById('sw-title');
		detail = document.getElementById('sw-detail');
		fill = document.getElementById('sw-fill');
		note = document.getElementById('sw-note');
		timer = setInterval(tick, 250);
		if (stoppedEarly) stop();
	}

	// Runs `run` once the page has really painted (and handed the spinner to the compositor).
	function afterPaint(run) {
		let done = false;
		const go = () => {
			if (done) return;
			done = true;
			run();
		};
		if (document.hidden) nextTick(go);
		else {
			// A frame's rendering follows its callback, so this task comes after the paint.
			realFrame(() => nextTick(go));
			// In case the tab is hidden before that frame comes.
			setTimeout(go, 250);
		}
	}

	// The engine's main() can hold the main thread for seconds before the game's first step, so
	// it must not start before the screen is up. index.js declares the engine as the global
	// Godot; catching that assignment holds the module back until a first paint. Nothing
	// later may come between the engine's copyToFS and callMain: a task boundary there
	// makes every file open in Emscripten's FS several times slower (measured: +1.8 s).
	let godot;
	Object.defineProperty(window, 'Godot', {
		configurable: true,
		get: () => godot,
		set(factory) {
			godot = (config) => factory(config).then((module) => new Promise((resolve) => afterPaint(() => resolve(module))));
		},
	});

	// While the game builds the town it pauses at its steps and this page resumes it after each
	// repaint, with the engine's frames held back so nothing else of the game runs in between.
	// Hidden tabs get no frames at all, so from then until the game is up, everything here
	// falls back to a message loop in one; otherwise switching tabs would stop the start.
	const realFrame = window.requestAnimationFrame.bind(window);
	const wakeup = new MessageChannel();
	let holding = false;
	let frameWaiters = [];
	let resumeGame = null;
	function runFrameWaiters(time) {
		const waiters = frameWaiters;
		frameWaiters = [];
		waiters.forEach((waiter) => waiter(time));
	}
	function nextTick(run) {
		const channel = new MessageChannel();
		channel.port1.onmessage = run;
		channel.port2.postMessage(0);
	}
	wakeup.port1.onmessage = () => runFrameWaiters(performance.now());
	function askForFrame() {
		if (document.hidden) wakeup.port2.postMessage(0);
		else realFrame(runFrameWaiters);
	}
	window.requestAnimationFrame = function (callback) {
		if (gone || !resumeGame) return realFrame(callback);
		frameWaiters.push(callback);
		if (!holding && frameWaiters.length === 1) askForFrame();
		return 0;
	};
	document.addEventListener('visibilitychange', () => {
		if (document.hidden && !holding && frameWaiters.length) wakeup.port2.postMessage(0);
	});

	// Two ways to spend less time compiling shaders, the longest part of a first visit.
	if (window.WebGL2RenderingContext) {
		const prototype = WebGL2RenderingContext.prototype;
		// The engine waits for each shader's compile status before starting the next step, so
		// the browser compiles a program's two stages one after the other. The link that
		// follows reports any failure anyway, so answering here lets them run side by side.
		const shaderParameter = prototype.getShaderParameter;
		prototype.getShaderParameter = function (shader, name) {
			return name === this.COMPILE_STATUS ? true : shaderParameter.call(this, shader, name);
		};
		// The first time a material is used, Godot 4.7's compatibility renderer also compiles
		// four programs with its default settings, then compiles the ones it really draws
		// with. Those defaults assume a lightmap, and only an object with a lightmap ever draws
		// without DISABLE_LIGHTMAP, so in this game (no LightmapGI) the four are never used:
		// two thirds of all programs. They become empty ones that compile at once. A material
		// that does get a lightmap would stop drawing, so this has to go if lightmaps ever do.
		const shaderSource = prototype.shaderSource;
		prototype.shaderSource = function (shader, source) {
			if (source.includes('scene_data_block') && !source.includes('#define DISABLE_LIGHTMAP')) {
				source = this.getShaderParameter(shader, this.SHADER_TYPE) === this.VERTEX_SHADER ? UNUSED_VERTEX : UNUSED_FRAGMENT;
			}
			return shaderSource.call(this, shader, source);
		};
	}

	window.simWorldLoad = {
		// True from the first playable frame on (for the browser tests).
		playable: false,
		// The game will run in steps; `resume` continues it after pause().
		takeOver(resume) {
			resumeGame = resume;
			holding = true;
			quiet = 0;
			carryOn();
			startBuilding();
		},
		// What is happening now and how much of the work behind it is done (0 to 1).
		step(text, fraction) {
			quiet = 0;
			if (gone || !root) return;
			carryOn();
			if (!building) startBuilding();
			if (text) detail.textContent = text;
			setBar(fraction);
		},
		// The game has stopped at a step: let the page repaint, then carry on.
		pause() {
			afterPaint(() => {
				if (resumeGame) resumeGame();
			});
		},
		// The build is over: the engine's frames can run.
		run() {
			quiet = 0;
			holding = false;
			if (frameWaiters.length) askForFrame();
		},
		// The first playable frame has been drawn.
		ready() {
			reachedGame = true;
			window.simWorldLoad.playable = true;
			leave();
		},
		// Up again for a shorter wait, with the game's frames running as normal.
		again(text) {
			if (!root) return;
			gone = false;
			quiet = 0;
			building = true;
			stopped = false;
			root.classList.remove('sw-leaving', 'sw-failed');
			if (!root.isConnected) document.body.appendChild(root);
			title.textContent = text;
			detail.textContent = '';
			setBar(0);
			setNote('');
			clearInterval(timer);
			timer = setInterval(tick, 250);
		},
	};

	document.addEventListener('DOMContentLoaded', build);
})();
