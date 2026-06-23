import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STATE_KEY = Symbol.for("pi.stripStainlessHeadersFetchState");
const VERSION = 4;
const STAINLESS_PREFIX = "x-stainless-";

type StripStainlessState = {
	version: number;
	fetch: typeof fetch;
	strippedRequests: number;
	strippedHeaders: number;
	installs: number;
	lastInstallReason: string;
	lastInstallActive: boolean;
};

type GlobalWithState = typeof globalThis & {
	[STATE_KEY]?: StripStainlessState;
};

function isStainlessHeader(name: string): boolean {
	return name.toLowerCase().startsWith(STAINLESS_PREFIX);
}

function hasStainlessHeaders(headers: Headers): boolean {
	for (const [name] of headers) {
		if (isStainlessHeader(name)) return true;
	}
	return false;
}

function stripStainlessHeaders(headers: Headers): { headers: Headers; removed: string[] } {
	const next = new Headers(headers);
	const removed: string[] = [];

	// Snapshot keys first. Deleting while iterating Headers directly can skip entries.
	for (const name of [...next.keys()]) {
		if (isStainlessHeader(name)) {
			next.delete(name);
			removed.push(name);
		}
	}

	return { headers: next, removed };
}

function installFetchWrapper(reason: string): StripStainlessState {
	const globalState = globalThis as GlobalWithState;
	const existing = globalState[STATE_KEY];
	if (existing?.version === VERSION && globalThis.fetch === existing.fetch) {
		existing.lastInstallReason = reason;
		existing.lastInstallActive = true;
		return existing;
	}

	const previousFetch = globalThis.fetch.bind(globalThis);
	const state: StripStainlessState = {
		version: VERSION,
		fetch: previousFetch,
		strippedRequests: existing?.strippedRequests ?? 0,
		strippedHeaders: existing?.strippedHeaders ?? 0,
		installs: (existing?.installs ?? 0) + 1,
		lastInstallReason: reason,
		lastInstallActive: false,
	};

	const wrappedFetch: typeof fetch = async (input, init) => {
		const inputHasStainless =
			typeof Request !== "undefined" && input instanceof Request && hasStainlessHeaders(input.headers);
		const initHasStainless = init?.headers ? hasStainlessHeaders(new Headers(init.headers)) : false;

		if (!inputHasStainless && !initHasStainless) {
			return previousFetch(input, init);
		}

		const request = new Request(input, init);
		const { headers, removed } = stripStainlessHeaders(request.headers);
		if (removed.length === 0) {
			return previousFetch(request);
		}

		state.strippedRequests += 1;
		state.strippedHeaders += removed.length;

		return previousFetch(new Request(request, { headers }));
	};

	state.fetch = wrappedFetch;
	globalThis.fetch = wrappedFetch;
	state.lastInstallActive = globalThis.fetch === wrappedFetch;
	globalState[STATE_KEY] = state;
	return state;
}

export default function (pi: ExtensionAPI) {
	installFetchWrapper("extension_load");

	// Reinstall close to model calls. Some runtimes/providers may replace global fetch after extension load.
	pi.on("session_start", () => {
		installFetchWrapper("session_start");
	});
	pi.on("before_agent_start", () => {
		installFetchWrapper("before_agent_start");
	});
	pi.on("context", () => {
		installFetchWrapper("context");
	});
	pi.on("before_provider_request", () => {
		installFetchWrapper("before_provider_request");
	});
}
