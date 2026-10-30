// Makes sure the game always hears a key being let go. Godot listens on its canvas (and its
// text-input helper), so a key released after focus moved elsewhere in the page, while the
// tab was hidden, or (on Macs) while Cmd was held never reached it, and the player kept
// walking or running with nothing pressed.
(function () {
	const held = new Map();
	const isGame = (target) => target && (target.id === 'canvas' || (target.classList && target.classList.contains('ime')));
	const release = (code) => {
		const down = held.get(code);
		held.delete(code);
		const canvas = document.getElementById('canvas');
		if (!down || !canvas) return;
		canvas.dispatchEvent(new KeyboardEvent('keyup', { key: down.key, code, bubbles: true, cancelable: true }));
	};
	const releaseAll = () => Array.from(held.keys()).forEach(release);
	window.addEventListener('keydown', (event) => {
		if (isGame(event.target)) held.set(event.code, { key: event.key });
	}, true);
	window.addEventListener('keyup', (event) => {
		if (event.key === 'Meta') {
			// macOS sends no keyup for keys released while Cmd was down.
			Array.from(held.keys()).filter((code) => code !== event.code).forEach(release);
		}
		if (isGame(event.target)) held.delete(event.code);
		else release(event.code);
	}, true);
	window.addEventListener('blur', releaseAll);
	document.addEventListener('visibilitychange', () => {
		if (document.hidden) releaseAll();
	});
	document.addEventListener('focusout', (event) => {
		if (isGame(event.target) && !isGame(event.relatedTarget)) releaseAll();
	}, true);
})();
