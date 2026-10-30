// Loads the game data (index.pck) from the parts tools/publish-web.sh splits it into, since
// GitHub refuses files over 100 MB. Without index.pck.json (a plain local export) the
// whole index.pck is fetched as usual.
//   Faster: PARALLEL parts download at once (still handed to the game in order).
//   Remembered: each part is kept in the browser's Cache Storage under the build's version,
//   so the next visit reads it from disk instead of downloading it again; older versions
//   are cleared when a new one arrives. Without Cache Storage it simply downloads.
(function () {
	const realFetch = window.fetch.bind(window);
	const PARALLEL = 4;
	const CACHE_PREFIX = 'sim-world-pck-';

	async function openCache(version) {
		try {
			const name = CACHE_PREFIX + version;
			for (const key of await caches.keys()) {
				if (key.startsWith(CACHE_PREFIX) && key !== name) caches.delete(key);
			}
			return await caches.open(name);
		} catch (error) {
			return null;
		}
	}

	async function getPart(cache, index, version) {
		const url = 'index.pck.' + index + '?v=' + version;
		if (cache) {
			try {
				const hit = await cache.match(url);
				if (hit) return hit;
			} catch (error) {
				// Unreadable cache: download instead.
			}
		}
		const response = await realFetch(url);
		if (cache && response.ok) cache.put(url, response.clone()).catch(() => {});
		return response;
	}

	window.fetch = async function (input, init) {
		const url = typeof input === 'string' ? input : (input && input.url) || String(input);
		if (!/(^|\/)index\.pck(\?|$)/.test(url)) return realFetch(input, init);
		let manifest = null;
		try {
			const response = await realFetch('index.pck.json', { cache: 'no-cache' });
			if (response.ok) manifest = await response.json();
		} catch (error) {
			manifest = null;
		}
		if (!manifest) return realFetch(input, init);
		const cache = await openCache(manifest.version);
		const pending = [];
		const request = (index) => {
			if (index < manifest.parts && !pending[index]) pending[index] = getPart(cache, index, manifest.version);
		};
		for (let index = 0; index < PARALLEL; index += 1) request(index);
		let part = 0;
		const stream = new ReadableStream({
			async pull(controller) {
				if (part >= manifest.parts) {
					controller.close();
					return;
				}
				const response = await pending[part];
				if (!response.ok) {
					controller.error(new Error('Missing game data part ' + part));
					return;
				}
				const reader = response.body.getReader();
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					controller.enqueue(value);
				}
				pending[part] = null;
				part += 1;
				request(part + PARALLEL - 1);
			},
		});
		return new Response(stream, {
			status: 200,
			headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(manifest.size) },
		});
	};
})();
