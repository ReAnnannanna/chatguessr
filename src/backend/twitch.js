import { EventEmitter } from "events";
import { StaticAuthProvider } from "@twurple/auth";
import { ChatClient } from "@twurple/chat";

class TwitchBackend extends EventEmitter {
	/** @type {ChatClient} */
	#client;

	#closing = false;

	/** @type {string} */
	botUsername;
	/** @type {string} */
	channelName;

	/**
	 * @param {object} options
	 * @param {string} options.botUsername
	 * @param {string} options.channelName
	 * @param {string} options.whisperToken
	 */
	constructor(options) {
		super();

		this.botUsername = options.botUsername;
		this.channelName = options.channelName;

		this.#client = new ChatClient({
			authProvider: new StaticAuthProvider(process.env.TWITCH_CLIENT_ID, options.whisperToken),
			channels: [this.channelName],
		});

		this.#client.onConnect(() => {
			this.emit("connected");
		});

		this.#client.onDisconnect(() => {
			this.emit("disconnected", this.#closing);
		});

		this.#client.onWhisper((_username, message, { userInfo }) => {
			if (self) return;
			this.emit("guess", userInfo, message);
		});

		this.#client.onMessage((_channel, _username, message, { userInfo }) => {
			if (self) return;
			this.emit("message", userInfo, message);
		});
	}

	async connect() {
		await this.#client.connect();
	}

	async close() {
		this.#closing = true;
		await this.#client.quit();
	}

	isConnected() {
		return this.#client.isConnected;
	}

	/**
	 * @param {string} message
	 * @param {{ system?: boolean }} [options]
	 */
	async sendMessage(message, options = {}) {
		if (options.system) {
			await this.#client.action(this.channelName, message);
		} else {
			await this.#client.say(this.channelName, message);
		}
	}
}

export default TwitchBackend;
