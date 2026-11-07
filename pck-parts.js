// Loads the game data (index.pck) from the chunks tools/web/chunk_pck.py splits it into,
// since GitHub refuses files over 100 MB. index.pck.json lists the chunks in order, each
// named after a hash of its bytes, so an update only changes the chunks whose files
// changed. With no index.pck.json at all (a plain local export) the whole index.pck is fetched.
//   Faster: PARALLEL chunks download at once (still handed to the game in order, with the
//   zero padding between them filled in).
//   Remembered: every chunk is kept in one Cache Storage cache under its hash name, so a
//   later visit, even after an update, only downloads chunks it has never seen. Once the
//   game has its data, chunks the current build no longer uses are deleted. Without Cache
//   Storage (or when it is full) it simply downloads.
(function () {
	const realFetch = window.fetch.bind(window);
	// 8 rather than 6 hides request latency behind the ~3 MB chunks (measured at 60 ms RTT).
	const PARALLEL = 8;
	const RETRIES = 2;
	const RETRY_DELAY = 1000;
	const CACHE = 'sim-world-pck-chunks';
	// Earlier builds cached whole 45 MB parts per version under 'sim-world-pck-<version>'.
	const OLD_CACHE_PREFIX = 'sim-world-pck-';
	const OLD_PART_SIZE = 45 * 1024 * 1024;
	const RELOADED = 'sim-world-pck-reloaded';
	// Where the game data is coming from, so the loading screen can tell a first visit from an update.
	window.simWorldStored = { checked: false, chunked: false, kept: 0, fetched: 0 };

	// [{o: offset, s: size, url, data}] in order, or null for an unknown manifest.
	function segmentsOf(manifest) {
		if (!manifest || !(manifest.size >= 0)) return null;
		if (Array.isArray(manifest.segments)) {
			return manifest.segments.map((segment) => ({
				o: segment.o,
				s: segment.s,
				url: segment.h ? 'index.pck.' + segment.h : null,
				hash: segment.h,
				data: segment.d,
			}));
		}
		if (manifest.parts > 0) {
			const segments = [];
			for (let index = 0; index < manifest.parts; index += 1) {
				const o = index * OLD_PART_SIZE;
				segments.push({ o, s: Math.min(OLD_PART_SIZE, manifest.size - o), url: 'index.pck.' + index + '?v=' + manifest.version });
			}
			return segments;
		}
		return null;
	}

	async function openCache() {
		try {
			if (typeof caches === 'undefined') return null;
			// Old per-version parts can never be used again; free their space before downloading.
			for (const name of await caches.keys()) {
				if (name.startsWith(OLD_CACHE_PREFIX) && name !== CACHE) caches.delete(name).catch(() => {});
			}
			return await caches.open(CACHE);
		} catch (error) {
			return null;
		}
	}

	async function fromCache(cache, segment) {
		if (!cache) return null;
		try {
			const hit = await cache.match(segment.url);
			if (!hit) return null;
			const bytes = new Uint8Array(await hit.arrayBuffer());
			if (bytes.length === segment.s) return bytes;
			cache.delete(segment.url).catch(() => {});
		} catch (error) {
			// Unreadable cache: download instead.
		}
		return null;
	}

	// A chunk's name is the start of its SHA-256, so a bad download never reaches the cache,
	// where it would otherwise outlive every update that keeps that chunk.
	async function matchesName(bytes, segment) {
		if (!segment.hash || typeof crypto === 'undefined' || !crypto.subtle) return true;
		const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
		return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('').startsWith(segment.hash);
	}

	async function download(segment, attempt) {
		// A retry skips the HTTP cache in case it holds a broken copy.
		const response = await realFetch(segment.url, attempt ? { cache: 'reload' } : undefined);
		if (!response.ok) throw new Error('HTTP ' + response.status);
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes.length !== segment.s) throw new Error('got ' + bytes.length + ' of ' + segment.s + ' bytes');
		if (!(await matchesName(bytes, segment))) throw new Error('damaged download');
		return bytes;
	}

	async function getSegment(cache, segment) {
		if (segment.data !== undefined) return Uint8Array.from(atob(segment.data), (c) => c.charCodeAt(0));
		const cached = await fromCache(cache, segment);
		if (cached) {
			window.simWorldStored.kept += cached.length;
			return cached;
		}
		let problem = null;
		for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
			if (attempt) await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY * attempt));
			try {
				const bytes = await download(segment, attempt);
				window.simWorldStored.fetched += bytes.length;
				if (cache) {
					try {
						cache.put(segment.url, new Response(bytes)).catch(() => {});
					} catch (error) {
						// Not cached this time: fine, it was downloaded.
					}
				}
				return bytes;
			} catch (error) {
				problem = error;
			}
		}
		throw new Error('Could not download game data ' + segment.url + ' (' + (problem && problem.message) + ')');
	}

	// Deletes cached chunks the current build doesn't use, once the game has all its data.
	async function tidy(cache, segments) {
		if (!cache) return;
		try {
			const keep = new Set(segments.map((segment) => segment.url).filter(Boolean));
			for (const request of await cache.keys()) {
				if (!keep.has(request.url.slice(request.url.lastIndexOf('/') + 1))) await cache.delete(request);
			}
		} catch (error) {
			// Left for the next visit.
		}
	}

	// Godot's progress wrapper never hears about a failed stream, so the bar would just stop.
	// One reload picks up a fresh chunk list (a new build may have replaced this one
	// mid-download); if that doesn't help, it says so.
	function giveUp(error) {
		console.error(error);
		try {
			if (!sessionStorage.getItem(RELOADED)) {
				sessionStorage.setItem(RELOADED, '1');
				location.reload();
				return;
			}
		} catch (problem) {
			// No session storage to remember the reload in: just show the message.
		}
		const notice = typeof document !== 'undefined' && document.getElementById('status-notice');
		if (!notice) return;
		notice.textContent = 'The game data could not be downloaded. Check your connection, then reload the page.';
		notice.style.display = 'block';
		const progress = document.getElementById('status-progress');
		if (progress) progress.style.display = 'none';
	}

	function loaded() {
		try {
			sessionStorage.removeItem(RELOADED);
		} catch (error) {
			// Nothing was remembered.
		}
	}

	window.fetch = async function (input, init) {
		const url = typeof input === 'string' ? input : (input && input.url) || String(input);
		if (!/(^|\/)index\.pck(\?|$)/.test(url)) return realFetch(input, init);
		let manifest = null;
		try {
			const response = await realFetch('index.pck.json', { cache: 'no-cache' });
			if (response.ok) manifest = await response.json();
			else if (response.status !== 404) throw new Error('Game data list: HTTP ' + response.status);
		} catch (error) {
			// Only a missing list means a plain export: a chunked site has no index.pck to fall
			// back on. The engine keeps waiting here, so the player's message stays up.
			giveUp(error);
			return new Promise(() => {});
		}
		const segments = segmentsOf(manifest);
		window.simWorldStored.checked = true;
		if (!segments) return realFetch(input, init);
		window.simWorldStored.chunked = true;
		const cache = await openCache();
		const pending = [];
		const request = (index) => {
			if (index < segments.length && !pending[index]) {
				pending[index] = getSegment(cache, segments[index]);
				// Failures are reported when the stream reaches that chunk.
				pending[index].catch(() => {});
			}
		};
		for (let index = 0; index < PARALLEL; index += 1) request(index);
		let next = 0;
		let position = 0;
		const stream = new ReadableStream({
			async pull(controller) {
				try {
					if (next >= segments.length) {
						if (position < manifest.size) controller.enqueue(new Uint8Array(manifest.size - position));
						position = manifest.size;
						controller.close();
						loaded();
						tidy(cache, segments);
						return;
					}
					const segment = segments[next];
					const bytes = await pending[next];
					if (segment.o < position) throw new Error('Game data list is out of order at ' + segment.o);
					if (segment.o > position) controller.enqueue(new Uint8Array(segment.o - position));
					controller.enqueue(bytes);
					position = segment.o + segment.s;
					pending[next] = null;
					next += 1;
					request(next + PARALLEL - 1);
				} catch (error) {
					controller.error(error);
					giveUp(error);
				}
			},
		});
		return new Response(stream, {
			status: 200,
			headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(manifest.size) },
		});
	};
})();
