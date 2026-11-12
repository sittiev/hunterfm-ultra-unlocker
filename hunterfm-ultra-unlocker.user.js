// ==UserScript==
// @name         Hunter.FM Ultra Unlocker
// @namespace    https://github.com/sittiev/hunterfm-ultra-unlocker
// @version      2026.11.12.1108
// @description  Libera 32/64/192/320 kbps na Hunter.FM, inicia em 320 e mantém a qualidade escolhida.
// @author       sittiev
// @icon         https://hunter.fm/images/icon-logo-default.png
// @homepageURL  https://github.com/sittiev/hunterfm-ultra-unlocker
// @supportURL   https://github.com/sittiev/hunterfm-ultra-unlocker/issues
// @updateURL    https://raw.githubusercontent.com/sittiev/hunterfm-ultra-unlocker/main/hunterfm-ultra-unlocker.user.js
// @downloadURL  https://raw.githubusercontent.com/sittiev/hunterfm-ultra-unlocker/main/hunterfm-ultra-unlocker.user.js
// @match        https://hunter.fm/*
// @match        https://www.hunter.fm/*
// @run-at       document-start
// @grant        none
// @inject-into  page
// @noframes
// ==/UserScript==

/*
 * The quality gate is client-side. The premium sentinel unlocks Alta/Ultra,
 * and playerStore.quality maps 0-3 to 32/64/192/320 kbps. The 320 kbps HLS
 * variant is public, so the script never touches the stream server.
 */

(() => {
	const PREMIUM_SENTINEL = "tUdpciY6";
	const SITE_QUALITY_KEY = "hunter:plus-quality";
	const PREF_KEY = "hf-ultra:pref";
	const OPEN_KEY = "hf-ultra:open";
	const REVERB_KEY = "hf-ultra:reverb";
	const SITE_STYLE_ID = "hf-ultra-site-style";

	const QUALITIES = [
		{ value: 0, name: "Baixa", kbps: 32 },
		{ value: 1, name: "Média", kbps: 64 },
		{ value: 2, name: "Alta", kbps: 192 },
		{ value: 3, name: "Ultra", kbps: 320 },
	];

	const clampQuality = (value) => {
		const number = Number(value);
		if (!Number.isInteger(number)) return 3;
		return Math.max(0, Math.min(3, number));
	};
	const qualityInfo = (value) => QUALITIES[clampQuality(value)];

	const readLS = (key) => {
		try {
			return window.localStorage.getItem(key);
		} catch {
			return null;
		}
	};
	const writeLS = (key, value) => {
		try {
			window.localStorage.setItem(key, value);
		} catch {
			/* storage can be blocked */
		}
	};

	const reverbState = {
		enabled: false,
		mix: 30,
		size: 50,
		preset: "Desligado",
	};

	try {
		const savedReverb = JSON.parse(readLS(REVERB_KEY) || "null");
		if (savedReverb && typeof savedReverb === "object") {
			reverbState.enabled = Boolean(savedReverb.enabled);
			const mix = Number(savedReverb.mix);
			const size = Number(savedReverb.size);
			if (Number.isFinite(mix))
				reverbState.mix = Math.max(0, Math.min(100, mix));
			if (Number.isFinite(size))
				reverbState.size = Math.max(0, Math.min(100, size));
			reverbState.preset =
				typeof savedReverb.preset === "string" ? savedReverb.preset : "Ajuste";
		}
	} catch {
		/* malformed or unavailable storage */
	}

	let pref = clampQuality(readLS(PREF_KEY) ?? readLS(SITE_QUALITY_KEY) ?? 3);
	let collapsed = readLS(OPEN_KEY) !== "1";

	let store = null;
	let hls = null;
	let booted = false;
	let syncing = false;
	let lastVariant = null;
	let lastVariantAt = 0;
	let lastLockAt = 0;
	let ui = null;

	function forcePremium(state) {
		if (!state || typeof state !== "object") return state;
		if (state.userStore && typeof state.userStore === "object") {
			state.userStore.uwu = PREMIUM_SENTINEL;
		} else {
			state.uwu = PREMIUM_SENTINEL;
		}
		return state;
	}

	function forceQuality(state, quality) {
		if (!state || typeof state !== "object") return state;
		if (state.playerStore && typeof state.playerStore === "object") {
			state.playerStore.quality = quality;
		} else {
			state.quality = quality;
		}
		return state;
	}

	function seedPersistedState(key, mutate) {
		try {
			const raw = readLS(key);
			let state = raw ? JSON.parse(raw) : {};
			if (!state || typeof state !== "object") state = {};
			mutate(state);
			window.localStorage.setItem(key, JSON.stringify(state));
		} catch {
			/* malformed or unavailable storage */
		}
	}

	seedPersistedState("userInfoStore", (state) => forcePremium(state));
	seedPersistedState("playerStore", (state) => forceQuality(state, pref));
	writeLS(PREF_KEY, String(pref));
	writeLS(SITE_QUALITY_KEY, String(pref));

	try {
		document.cookie =
			"noLoggedClosed=yes; path=/; max-age=31536000; SameSite=Lax";
	} catch {
		/* cookies can be blocked */
	}

	const rawSetItem = Storage.prototype.setItem;
	Storage.prototype.setItem = function setItem(key, value) {
		if (this === window.localStorage) {
			try {
				if (key === "userInfoStore") {
					value = JSON.stringify(forcePremium(JSON.parse(value)));
				}
			} catch {
				/* leave non-JSON values untouched */
			}
		}
		return rawSetItem.call(this, key, value);
	};

	function injectSiteStyle() {
		if (document.getElementById(SITE_STYLE_ID)) return;
		const head = document.head;
		if (!head) return;
		const style = document.createElement("style");
		style.id = SITE_STYLE_ID;
		style.textContent = `
      button:has(svg use[href*="#i-crown"]) svg[class*="plusIcon_"],
      button[class*="option_"] svg:has(use[href*="#i-crown"]) {
        display: none !important;
      }
      section:has(button[class*="option_"]) p[class*="sectionText_"] {
        display: none !important;
      }
    `;
		head.appendChild(style);
	}

	injectSiteStyle();
	document.addEventListener("readystatechange", injectSiteStyle);
	document.addEventListener("DOMContentLoaded", injectSiteStyle, {
		once: true,
	});

	const NativeAudioContext = window.AudioContext || window.webkitAudioContext;
	const originalConnect =
		typeof AudioNode !== "undefined" && AudioNode.prototype.connect
			? AudioNode.prototype.connect
			: null;
	const sourceByMedia = new WeakMap();

	const reverbPresets = [
		{ name: "Desligado", enabled: false, mix: 30, size: 50 },
		{ name: "Sala", enabled: true, mix: 25, size: 45 },
		{ name: "Igreja", enabled: true, mix: 45, size: 80 },
		{ name: "Amplo", enabled: true, mix: 60, size: 100 },
	];

	let sharedContext = null;
	let reverbReady = false;
	let reverbInput = null;
	let reverbDry = null;
	let reverbWet = null;
	let reverbConvolver = null;
	let reverbOutput = null;
	let reverbSource = null;
	let reverbDirect = false;
	let reverbImpulseSize = -1;
	let mediaElement = null;
	let reverbUi = null;

	function reverbSupported() {
		if (!NativeAudioContext || !originalConnect) return false;
		return !(
			/iPhone|iPad|iPod/.test(navigator.userAgent) ||
			(navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
		);
	}

	function persistReverb() {
		writeLS(REVERB_KEY, JSON.stringify(reverbState));
	}

	function resumeAudio() {
		if (sharedContext && sharedContext.state === "suspended") {
			sharedContext.resume().catch(() => {});
		}
	}

	function setupReverbGraph() {
		if (reverbReady || !sharedContext) return;
		try {
			reverbInput = sharedContext.createGain();
			reverbDry = sharedContext.createGain();
			reverbWet = sharedContext.createGain();
			reverbConvolver = sharedContext.createConvolver();
			reverbOutput = sharedContext.createGain();

			originalConnect.call(reverbInput, reverbDry);
			originalConnect.call(reverbDry, reverbOutput);
			originalConnect.call(reverbInput, reverbConvolver);
			originalConnect.call(reverbConvolver, reverbWet);
			originalConnect.call(reverbWet, reverbOutput);
			originalConnect.call(reverbOutput, sharedContext.destination);

			reverbReady = true;
			if (reverbState.enabled) updateReverbImpulse();
			updateReverbGraph();
		} catch {
			reverbReady = false;
		}
	}

	function updateReverbGraph() {
		if (!reverbReady) return;
		const mix = reverbState.enabled
			? Math.max(0, Math.min(100, reverbState.mix)) / 100
			: 0;
		reverbWet.gain.value = mix;
		reverbDry.gain.value = 1 - mix;
	}

	function updateReverbImpulse() {
		if (!reverbReady) return;
		const size = Math.max(0, Math.min(100, reverbState.size));
		if (reverbImpulseSize === size && reverbConvolver.buffer) return;
		reverbImpulseSize = size;

		const duration = 0.25 + (size / 100) * 2.75;
		const decay = 3 - (size / 100) * 2;
		const rate = sharedContext.sampleRate;
		const length = Math.max(1, Math.floor(rate * duration));
		const impulse = sharedContext.createBuffer(2, length, rate);

		for (let channel = 0; channel < 2; channel++) {
			const data = impulse.getChannelData(channel);
			for (let index = 0; index < length; index++) {
				data[index] = (Math.random() * 2 - 1) * (1 - index / length) ** decay;
			}
		}
		reverbConvolver.buffer = impulse;
	}

	function ensureReverbContext() {
		if (sharedContext || !NativeAudioContext) return;
		try {
			sharedContext = new NativeAudioContext();
			setupReverbGraph();
		} catch {
			sharedContext = null;
		}
	}

	function patchReverbSource(source) {
		if (!source || source.__hfReverbPatched) return;
		source.__hfReverbPatched = true;
		const connect = source.connect;
		source.connect = function connectSource(destination, output, input) {
			if (
				reverbDirect &&
				destination !== reverbInput &&
				destination !== sharedContext.destination
			) {
				try {
					source.disconnect(reverbInput);
				} catch {
					/* already disconnected */
				}
				reverbDirect = false;
			}
			return connect.call(source, destination, output, input);
		};
	}

	function ensureReverbSource() {
		if (!reverbReady || !mediaElement) return;
		if (reverbSource) return;
		try {
			const existed = sourceByMedia.has(mediaElement);
			reverbSource = sharedContext.createMediaElementSource(mediaElement);
			if (!existed) {
				originalConnect.call(reverbSource, reverbInput);
				reverbDirect = true;
				patchReverbSource(reverbSource);
			}
		} catch {
			reverbSource = null;
		}
	}

	function enableReverb() {
		if (!reverbSupported()) return;
		ensureReverbContext();
		if (!sharedContext) return;
		if (!mediaElement) mediaElement = document.querySelector("audio");
		ensureReverbSource();
		updateReverbImpulse();
		updateReverbGraph();
		resumeAudio();
	}

	if (NativeAudioContext && originalConnect) {
		try {
			window.AudioContext = new Proxy(NativeAudioContext, {
				construct(target, args) {
					if (!sharedContext) {
						sharedContext = Reflect.construct(target, args);
						setupReverbGraph();
					}
					return sharedContext;
				},
			});
			window.webkitAudioContext = window.AudioContext;
		} catch {
			/* the page keeps its native AudioContext */
		}

		const originalCreateMediaElementSource =
			NativeAudioContext.prototype.createMediaElementSource;
		NativeAudioContext.prototype.createMediaElementSource =
			function createMediaElementSource(media) {
				if (sourceByMedia.has(media)) return sourceByMedia.get(media);
				const source = originalCreateMediaElementSource.call(this, media);
				sourceByMedia.set(media, source);
				return source;
			};

		AudioNode.prototype.connect = function connect(destination, output, input) {
			if (
				sharedContext &&
				reverbReady &&
				destination === sharedContext.destination
			) {
				return originalConnect.call(this, reverbInput, output, input);
			}
			return originalConnect.call(this, destination, output, input);
		};
	}

	const originalCreateElement = Document.prototype.createElement;
	Document.prototype.createElement = function createElement(tag, ...args) {
		const element = originalCreateElement.call(this, tag, ...args);
		if (String(tag).toLowerCase() === "audio") mediaElement = element;
		return element;
	};

	document.addEventListener(
		"play",
		(event) => {
			if (event.target instanceof HTMLMediaElement) {
				mediaElement = event.target;
				if (reverbState.enabled) enableReverb();
			}
		},
		true,
	);
	document.addEventListener("pointerdown", resumeAudio, { passive: true });
	document.addEventListener("keydown", resumeAudio, { passive: true });

	function variantFromUrl(url) {
		const match = /hls\.hunter\.fm\/[^/]+\/(320|192|64|32)(?:\/|\.m3u8)/.exec(
			String(url || ""),
		);
		if (!match) return null;
		if (match[1] === "320") return 3;
		if (match[1] === "192") return 2;
		if (match[1] === "64") return 1;
		return 0;
	}

	function noteVariant(url) {
		const variant = variantFromUrl(url);
		if (variant === null) return;
		lastVariant = variant;
		lastVariantAt = Date.now();
		updateUI();
	}

	const originalFetch = window.fetch;
	if (typeof originalFetch === "function") {
		window.fetch = function fetch(...args) {
			try {
				const input = args[0];
				noteVariant(typeof input === "string" ? input : input?.url);
			} catch {
				/* probe must never break the request */
			}
			return originalFetch.apply(this, args);
		};
	}

	const originalOpen = XMLHttpRequest.prototype.open;
	XMLHttpRequest.prototype.open = function open(...args) {
		try {
			noteVariant(args[1]);
		} catch {
			/* probe must never break the request */
		}
		return originalOpen.apply(this, args);
	};

	function ensurePremium() {
		if (!store) return;
		if (store.state.userStore.uwu === PREMIUM_SENTINEL) return;
		syncing = true;
		try {
			store.commit("userStore/setUwu", PREMIUM_SENTINEL);
		} finally {
			syncing = false;
		}
	}

	function persistQuality(quality) {
		pref = clampQuality(quality);
		writeLS(PREF_KEY, String(pref));
		writeLS(SITE_QUALITY_KEY, String(pref));
	}

	function applyQuality(quality) {
		persistQuality(quality);
		lastLockAt = 0;
		if (!store) return;
		syncing = true;
		try {
			store.commit("playerStore/setQuality", pref);
		} finally {
			syncing = false;
		}
		const station = store.state.playerStore.atualStation;
		if (hls && station?.hash) {
			try {
				hls.setQuality(station, pref);
			} catch {
				/* HLS can be between instances */
			}
		}
		updateUI();
	}

	function holdQuality() {
		if (!store || !hls) return;
		const player = store.state.playerStore;
		if (
			player.playerStatus !== "PLAYING" &&
			player.playerStatus !== "BUFFERING"
		)
			return;
		if (player.playingQuality === null || player.playingQuality >= pref) return;
		const station = player.atualStation;
		if (!station?.hash) return;
		if (Date.now() - lastLockAt < 2000) return;

		lastLockAt = Date.now();
		try {
			hls.setQuality(station, pref);
		} catch {
			/* HLS can be between instances */
		}
	}

	function patchPlayer() {
		const originalSetQuality = hls.setQuality;
		const originalPlayChannel = hls.playChannel;

		hls.setQuality = function setQuality(station, quality) {
			const requested = clampQuality(quality);
			if (requested !== pref) persistQuality(requested);
			return originalSetQuality.call(hls, station, requested);
		};

		hls.playChannel = function playChannel(station, fromHistory) {
			ensurePremium();
			lastLockAt = 0;
			try {
				if (station?.hash) {
					originalSetQuality.call(hls, station, pref);
				}
			} catch {
				/* the site will retry on its own */
			}
			return originalPlayChannel.call(hls, station, fromHistory);
		};
	}

	function boot(app) {
		if (booted) return;
		const appStore = app.$store;
		const appPlayer = app.$hlsPlayer;
		if (!appStore || !appPlayer) return;

		booted = true;
		store = appStore;
		hls = appPlayer;

		ensurePremium();
		if (store.state.playerStore.quality !== pref) {
			syncing = true;
			try {
				store.commit("playerStore/setQuality", pref);
			} finally {
				syncing = false;
			}
		}

		patchPlayer();

		store.subscribe((mutation, state) => {
			if (
				!syncing &&
				state.userStore &&
				state.userStore.uwu !== PREMIUM_SENTINEL
			) {
				ensurePremium();
			}
			if (state.siteManager?.showPlusModal) {
				syncing = true;
				try {
					store.commit("siteManager/setShowPlusModal", false);
				} finally {
					syncing = false;
				}
			}
			if (!syncing && mutation.type === "playerStore/setQuality") {
				const quality = state.playerStore.quality;
				if (quality !== pref) persistQuality(quality);
			}
			if (!syncing && mutation.type === "playerStore/setPlayingQuality") {
				holdQuality();
			}
			updateUI();
		});

		mountUI();
		updateUI();
	}

	function waitForApp() {
		if (window.$nuxt?.$store && window.$nuxt.$hlsPlayer) {
			boot(window.$nuxt);
			return;
		}
		const timer = setInterval(() => {
			if (window.$nuxt?.$store && window.$nuxt.$hlsPlayer) {
				clearInterval(timer);
				boot(window.$nuxt);
			}
		}, 100);
		setTimeout(() => clearInterval(timer), 60000);
	}

	function setStatus(text) {
		if (ui?.status) ui.status.textContent = text;
	}

	function updateUI() {
		if (!ui) return;
		const selected = qualityInfo(pref);
		ui.rate.textContent = `${selected.kbps} kbps`;
		ui.compactRate.textContent = ui.rate.textContent;

		for (const button of ui.buttons) {
			button.setAttribute(
				"aria-pressed",
				String(Number(button.dataset.q) === pref),
			);
		}

		if (!store) {
			setStatus("Aguardando o player…");
			return;
		}

		const player = store.state.playerStore;
		const playing =
			player.playerStatus === "PLAYING" || player.playerStatus === "BUFFERING";
		const fresh = lastVariant !== null && Date.now() - lastVariantAt < 15000;
		const actual = fresh ? lastVariant : null;

		if (!playing) {
			setStatus("Player parado.");
			return;
		}

		if (actual === null) {
			setStatus(`Tocando em ${selected.kbps} kbps.`);
			return;
		}

		setStatus(`Tocando em ${qualityInfo(actual).kbps} kbps.`);
	}

	function applyReverbState() {
		persistReverb();
		if (reverbState.enabled) {
			enableReverb();
		} else if (reverbReady) {
			updateReverbGraph();
		}
		syncReverbSection();
	}

	function updateReverbSlider(input, value) {
		input.value = String(value);
		input.style.setProperty("--from", "0%");
		input.style.setProperty("--to", `${value}%`);
	}

	function reverbPresetIndex() {
		return reverbPresets.findIndex(
			(preset) => preset.name === reverbState.preset,
		);
	}

	function setReverbPreset(index) {
		const preset = reverbPresets[index];
		if (!preset) return;
		reverbState.enabled = preset.enabled;
		reverbState.mix = preset.mix;
		reverbState.size = preset.size;
		reverbState.preset = preset.name;
		applyReverbState();
	}

	function syncReverbSection() {
		if (!reverbUi?.section.isConnected) return;
		const {
			mixInput,
			sizeInput,
			mixValue,
			sizeValue,
			presetButtons,
			onClass,
			mode,
		} = reverbUi;
		updateReverbSlider(mixInput, reverbState.mix);
		updateReverbSlider(sizeInput, reverbState.size);
		mixValue.textContent = `${reverbState.mix}%`;
		sizeValue.textContent = `${reverbState.size}%`;
		mixInput.setAttribute("aria-valuetext", `${reverbState.mix}%`);
		sizeInput.setAttribute("aria-valuetext", `${reverbState.size}%`);

		const active = reverbPresetIndex();
		presetButtons.forEach((button, index) => {
			if (onClass) button.classList.toggle(onClass, index === active);
			button.setAttribute("aria-pressed", String(index === active));
		});
		if (mode) {
			mode.innerHTML =
				reverbState.preset === "Ajuste"
					? "Ajuste"
					: `Ajuste <strong>${reverbState.preset}</strong>`;
		}
	}

	function wireReverb(section) {
		const bandsWrap = section.querySelector('[class*="bands_"]');
		if (bandsWrap) {
			bandsWrap.style.gridTemplateColumns = "repeat(2, minmax(0, 1fr))";
			bandsWrap.style.maxWidth = "360px";
			bandsWrap.style.width = "100%";
			bandsWrap.style.margin = "0 auto";
		}
		const bandNodes = bandsWrap ? [...bandsWrap.children] : [];
		const bands = bandNodes.filter((band) =>
			band.querySelector('input[type="range"]'),
		);
		const mixBand = bands[0];
		const sizeBand = bands[1];
		if (!mixBand || !sizeBand) return;
		for (const node of bandNodes) {
			if (!bands.includes(node)) node.remove();
		}
		for (const band of bands.slice(2)) band.remove();

		const mixInput = mixBand.querySelector('input[type="range"]');
		const sizeInput = sizeBand.querySelector('input[type="range"]');
		const mixValue = mixBand.querySelector('[class*="bandValue_"]');
		const sizeValue = sizeBand.querySelector('[class*="bandValue_"]');
		const mixLabel = mixBand.querySelector('[class*="bandLabel_"]');
		const sizeLabel = sizeBand.querySelector('[class*="bandLabel_"]');
		if (mixLabel) mixLabel.textContent = "Mix";
		if (sizeLabel) sizeLabel.textContent = "Tamanho";
		for (const zero of section.querySelectorAll('[class*="zero_"]'))
			zero.remove();
		if (!mixInput || !sizeInput || !mixValue || !sizeValue) return;

		const presetButtons = [
			...section.querySelectorAll('button[class*="preset_"]'),
		];
		const onClass = presetButtons
			.map((button) =>
				[...button.classList].find((name) => name.startsWith("presetOn_")),
			)
			.find(Boolean);
		presetButtons.forEach((button, index) => {
			button.textContent = reverbPresets[index]?.name || "";
			button.setAttribute("aria-pressed", "false");
			button.addEventListener("click", () => setReverbPreset(index));
		});

		const reset = section.querySelector(
			'button[class*="reset_"]:not([class*="preset_"])',
		);
		if (reset) {
			reset.disabled = false;
			const label = reset.querySelector("span");
			if (label) label.textContent = "Zerar";
			reset.addEventListener("click", () => {
				reverbState.enabled = false;
				reverbState.mix = 0;
				reverbState.size = 0;
				reverbState.preset = "Desligado";
				applyReverbState();
			});
		}

		mixInput.min = "0";
		mixInput.max = "100";
		mixInput.step = "1";
		mixInput.setAttribute("aria-label", "Mix do reverb");
		sizeInput.min = "0";
		sizeInput.max = "100";
		sizeInput.step = "1";
		sizeInput.setAttribute("aria-label", "Tamanho do reverb");

		mixInput.addEventListener("input", () => {
			reverbState.mix = Number(mixInput.value);
			reverbState.enabled = reverbState.mix > 0;
			reverbState.preset = "Ajuste";
			applyReverbState();
		});
		sizeInput.addEventListener("input", () => {
			reverbState.size = Number(sizeInput.value);
			if (!reverbState.enabled && reverbState.mix === 0) {
				reverbState.mix = 30;
				reverbState.enabled = true;
			}
			reverbState.preset = "Ajuste";
			applyReverbState();
		});

		const mode = section.querySelector('[class*="eqMode_"]');
		reverbUi = {
			section,
			mixInput,
			sizeInput,
			mixValue,
			sizeValue,
			presetButtons,
			onClass,
			mode,
		};
		syncReverbSection();
	}

	function ensureReverbSection() {
		if (!location.pathname.startsWith("/configuracoes/player")) return;
		if (reverbUi?.section.isConnected) {
			syncReverbSection();
			return;
		}
		if (document.querySelector("[data-hf-reverb]")) return;

		const heading = [...document.querySelectorAll("h2")].find((node) =>
			node.textContent.trim().startsWith("Equalizador"),
		);
		const equalizer = heading?.closest("section");
		if (!equalizer?.parentElement) return;

		const section = equalizer.cloneNode(true);
		section.dataset.hfReverb = "true";
		const title = section.querySelector("h2");
		if (title) title.textContent = "Reverb";
		const note = section.querySelector('[class*="sectionText_"]');
		if (note)
			note.textContent =
				"Adiciona ambiência à transmissão. O efeito fica só no seu navegador.";
		for (const plus of section.querySelectorAll('[class*="plusTag_"]'))
			plus.remove();

		const iconUse = section.querySelector(
			'[class*="sectionHead"] svg use, [class*="badge_"] svg use',
		);
		if (iconUse) {
			const href =
				iconUse.getAttribute("href") ||
				iconUse.getAttribute("xlink:href") ||
				"";
			const sprite = href.split("#")[0];
			if (sprite) {
				iconUse.setAttribute("href", `${sprite}#i-mix`);
				iconUse.setAttribute("xlink:href", `${sprite}#i-mix`);
			}
		}
		const tip = section.querySelector('[class*="tip_"] span');
		if (tip) {
			tip.textContent =
				"O reverb é aplicado só no seu navegador. Aumente o mix aos poucos para não embolar a voz e os instrumentos.";
		}

		equalizer.parentElement.insertBefore(section, equalizer.nextSibling);
		wireReverb(section);

		if (!reverbSupported()) {
			for (const control of section.querySelectorAll("button, input"))
				control.disabled = true;
			const mode = section.querySelector('[class*="eqMode_"]');
			if (mode)
				mode.innerHTML = "<strong>Indisponível neste navegador</strong>";
		}
	}

	function mountUI() {
		if (ui || document.getElementById("hf-ultra-root")) return;

		const host = document.createElement("div");
		host.id = "hf-ultra-root";
		(document.body || document.documentElement).appendChild(host);
		const root = host.attachShadow({ mode: "open" });

		root.innerHTML = `
      <style>
        :host {
          all: initial;
          position: fixed;
          right: 16px;
          bottom: 16px;
          width: 0;
          height: 0;
          z-index: 2147483647;
          display: block;
          color-scheme: dark;
        }
        * { box-sizing: border-box; }
        button { font: inherit; }
        .compact {
          position: absolute;
          right: 0;
          bottom: 0;
          width: 48px;
          height: 48px;
          display: flex;
          align-items: center;
          justify-content: flex-end;
          gap: 8px;
          padding: 0 12px;
          overflow: hidden;
          white-space: nowrap;
          border: 1px solid #2b2b2b;
          border-radius: 14px;
          background: #181818;
          box-shadow: 0 12px 30px rgba(0, 0, 0, 0.45);
          cursor: pointer;
          transition:
            width 180ms cubic-bezier(0.2, 0, 0, 1),
            opacity 160ms cubic-bezier(0.2, 0, 0, 1),
            transform 160ms cubic-bezier(0.2, 0, 0, 1);
        }
        .compact:hover,
        .compact:focus-visible { width: 140px; }
        .compact .logo { flex: none; width: 24px; height: 24px; }
        .compact-rate {
          font-size: 12px;
          font-weight: 600;
          color: #f5f5f5;
          opacity: 0;
          transition: opacity 140ms cubic-bezier(0.2, 0, 0, 1);
        }
        .compact:hover .compact-rate,
        .compact:focus-visible .compact-rate { opacity: 1; }
        .compact:focus-visible { outline: 2px solid #ff4a17; outline-offset: 2px; }
        .panel {
          position: absolute;
          right: 0;
          bottom: 0;
          width: min(264px, calc(100vw - 32px));
          color: #f5f5f5;
          font-family: Montserrat, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
          background: #181818;
          border: 1px solid #2b2b2b;
          border-radius: 16px;
          box-shadow: 0 18px 44px rgba(0, 0, 0, 0.46);
          overflow: hidden;
          user-select: none;
          transform-origin: bottom right;
          transition:
            opacity 180ms cubic-bezier(0.2, 0, 0, 1),
            transform 180ms cubic-bezier(0.2, 0, 0, 1);
        }
        :host([data-compact="1"]) .compact { opacity: 1; transform: scale(1); pointer-events: auto; }
        :host([data-compact="1"]) .panel {
          opacity: 0;
          transform: translateY(14px) scale(0.94);
          pointer-events: none;
        }
        :host([data-compact="0"]) .compact { opacity: 0; transform: scale(0.92); pointer-events: none; }
        :host([data-compact="0"]) .panel { opacity: 1; transform: scale(1); pointer-events: auto; }
        .head {
          width: 100%;
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 12px;
          border: 0;
          background: transparent;
          color: inherit;
          text-align: left;
          cursor: pointer;
        }
        .head:focus-visible,
        .q:focus-visible {
          outline: 2px solid #ff4a17;
          outline-offset: 2px;
        }
        .logo {
          display: block;
          width: 24px;
          height: 24px;
          flex: none;
          border-radius: 6px;
          object-fit: cover;
          outline: 1px solid rgba(255, 255, 255, 0.08);
          outline-offset: -1px;
        }
        .brand {
          min-width: 0;
          flex: 1;
        }
        .brand strong {
          display: block;
          font-size: 12px;
          font-weight: 700;
          line-height: 1.2;
          letter-spacing: 0;
        }
        .brand span {
          display: block;
          margin-top: 2px;
          color: #8f8f8f;
          font-size: 10px;
          font-weight: 500;
          line-height: 1.2;
        }
        .rate {
          color: #cfcfcf;
          font-size: 10.5px;
          font-weight: 600;
          font-variant-numeric: tabular-nums;
          white-space: nowrap;
        }
        .chev {
          display: block;
          width: 12px;
          height: 12px;
          flex: none;
          color: #8f8f8f;
          transition: transform 150ms cubic-bezier(0.2, 0, 0, 1);
        }
        .body { padding: 0 12px 12px; }
        .row {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 8px;
        }
        .q {
          min-width: 0;
          padding: 10px 10px 9px;
          border: 1px solid #2b2b2b;
          border-radius: 12px;
          background: #1e1e1e;
          color: #f5f5f5;
          text-align: left;
          cursor: pointer;
          transition:
            background-color 150ms cubic-bezier(0.2, 0, 0, 1),
            border-color 150ms cubic-bezier(0.2, 0, 0, 1),
            transform 150ms cubic-bezier(0.2, 0, 0, 1);
        }
        .q:hover {
          background: #242424;
          border-color: #3a3a3a;
        }
        .q:active { transform: scale(0.96); }
        .q[aria-pressed="true"] {
          background: #d63a06;
          border-color: #d63a06;
          color: #fff;
        }
        .q[aria-pressed="true"]:hover {
          background: #c93405;
          border-color: #c93405;
        }
        .q-name {
          display: block;
          font-size: 11px;
          font-weight: 700;
          line-height: 1.2;
        }
        .q-rate {
          display: block;
          margin-top: 3px;
          color: #a8a8a8;
          font-size: 10px;
          font-weight: 500;
          font-variant-numeric: tabular-nums;
          line-height: 1.2;
        }
        .q[aria-pressed="true"] .q-rate { color: #fff; }
        .status {
          min-height: 16px;
          margin-top: 12px;
          color: #a3a3a3;
          font-size: 10.5px;
          font-variant-numeric: tabular-nums;
          line-height: 1.4;
        }
        .hint {
          margin-top: 6px;
          color: #8f8f8f;
          font-size: 9.5px;
          line-height: 1.4;
        }
        .hint kbd {
          color: #a3a3a3;
          font: inherit;
        }
        @media (max-width: 640px) {
          :host {
            right: 10px;
            bottom: 10px;
          }
          .panel { width: min(264px, calc(100vw - 20px)); }
        }
        @media (prefers-reduced-motion: reduce) {
          *, *::before, *::after { transition: none !important; }
        }
      </style>
      <button class="compact" type="button" aria-label="Abrir controles de qualidade" aria-controls="hf-ultra-panel" aria-expanded="false">
        <span class="compact-rate">320 kbps</span>
        <img class="logo" src="https://hunter.fm/images/icon-logo-default.png" alt="" width="24" height="24">
      </button>
      <div class="panel" id="hf-ultra-panel">
        <button class="head" type="button" aria-expanded="true" aria-controls="hf-ultra-body">
          <img class="logo" src="https://hunter.fm/images/icon-logo-default.png" alt="" width="24" height="24">
          <span class="brand">
            <strong>Hunter.FM</strong>
            <span>Qualidade do áudio</span>
          </span>
          <span class="rate">320 kbps</span>
          <svg class="chev" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        <div class="body" id="hf-ultra-body">
          <div class="row" role="group" aria-label="Qualidade do áudio">
            <button class="q" type="button" data-q="0" aria-pressed="false">
              <span class="q-name">Baixa</span>
              <span class="q-rate">32 kbps</span>
            </button>
            <button class="q" type="button" data-q="1" aria-pressed="false">
              <span class="q-name">Média</span>
              <span class="q-rate">64 kbps</span>
            </button>
            <button class="q" type="button" data-q="2" aria-pressed="false">
              <span class="q-name">Alta</span>
              <span class="q-rate">192 kbps</span>
            </button>
            <button class="q" type="button" data-q="3" aria-pressed="false">
              <span class="q-name">Ultra</span>
              <span class="q-rate">320 kbps</span>
            </button>
          </div>
          <div class="status" role="status" aria-live="polite">Aguardando o player…</div>
          <div class="hint">A qualidade fica fixa no nível escolhido. <kbd>Alt+U</kbd> alterna.</div>
        </div>
      </div>
    `;

		const panel = root.querySelector(".panel");
		const compact = root.querySelector(".compact");
		const compactRate = root.querySelector(".compact-rate");
		const head = root.querySelector(".head");
		const rate = root.querySelector(".rate");
		const status = root.querySelector(".status");
		const buttons = [...root.querySelectorAll(".q")];
		let compactTimer = null;

		const scheduleCompact = () => {
			clearTimeout(compactTimer);
			if (collapsed) return;
			compactTimer = setTimeout(() => setCompact(true), 6000);
		};

		const setCompact = (next) => {
			collapsed = next;
			host.dataset.compact = next ? "1" : "0";
			panel.inert = next;
			compact.tabIndex = next ? 0 : -1;
			compact.setAttribute("aria-expanded", String(!next));
			head.setAttribute("aria-expanded", String(!next));
			writeLS(OPEN_KEY, next ? "0" : "1");
			clearTimeout(compactTimer);
			if (!next) scheduleCompact();
		};

		compact.addEventListener("click", () => setCompact(false));
		head.addEventListener("click", () => setCompact(true));

		for (const button of buttons) {
			button.addEventListener("click", () =>
				applyQuality(Number(button.dataset.q)),
			);
		}

		panel.addEventListener("pointerdown", scheduleCompact);
		panel.addEventListener("pointermove", scheduleCompact);
		panel.addEventListener("focusin", scheduleCompact);

		document.addEventListener(
			"pointerdown",
			(event) => {
				if (collapsed) return;
				if (event.composedPath().includes(host)) return;
				setCompact(true);
			},
			true,
		);

		window.addEventListener("keydown", (event) => {
			if (event.key === "Escape" && !collapsed) setCompact(true);
		});

		setCompact(collapsed);
		ui = { panel, compact, compactRate, rate, status, buttons };
	}

	function cycleQuality() {
		const order = [3, 2, 1, 0];
		const index = order.indexOf(pref);
		applyQuality(order[(index + 1) % order.length]);
	}

	window.addEventListener(
		"keydown",
		(event) => {
			if (
				event.altKey &&
				!event.ctrlKey &&
				!event.metaKey &&
				(event.key === "u" || event.key === "U")
			) {
				event.preventDefault();
				cycleQuality();
			}
		},
		true,
	);

	document.addEventListener("DOMContentLoaded", ensureReverbSection, {
		once: true,
	});

	if (typeof window.onNuxtReady === "function") {
		window.onNuxtReady(waitForApp);
	}
	waitForApp();
	setInterval(() => {
		injectSiteStyle();
		ensureReverbSection();
		holdQuality();
		updateUI();
	}, 1000);
})();
