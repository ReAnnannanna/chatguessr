"use strict";

const { ipcMain } = require("electron");
const Game = require("./Classes/Game");
const GameHelper = require("./utils/GameHelper");
const Settings = require("./utils/Settings");
const TwitchClient = require("./Classes/tmi");
const flags = require("./utils/flags");
const legacyStoreFacade = require("./utils/legacyStoreFacade");
const store = require("./utils/sharedStore");
const createSettingsWindow = require("./Windows/settings/SettingsWindow");

import { io } from "socket.io-client";
const socket = io(process.env.SOCKET_SERVER_URL);

const settings = Settings.read();

/** @typedef {import('./types').Guess} Guess */
/** @typedef {import('./utils/Database')} Database */
/** @typedef {import('./Windows/MainWindow')} MainWindow */
/** @typedef {import('electron').BrowserWindow} BrowserWindow */

class GameHandler {
	/** @type {Database} */
	#db;

	/**
	 * @type {MainWindow}
	 */
	#win;

	/**
	 * @type {BrowserWindow|undefined}
	 */
	#settingsWindow;

	/**
	 * @type {TwitchClient}
	 */
	#twitch;

	/**
	 * @type {Game}
	 */
	#game;

	/**
	 * @param {Database} db
	 * @param {MainWindow} win
	 */
	constructor(db, win) {
		this.#db = db;
		this.#win = win;
		this.#twitch = undefined;
		this.#game = new Game(db, settings);
		this.#initTmi();
		this.ioInit();
		this.init();
	}

	openGuesses() {
		this.#game.openGuesses();
		this.#win.webContents.send("switch-on");
		this.#twitch.action("Guesses are open...");
	}

	closeGuesses() {
		this.#game.closeGuesses();
		this.#win.webContents.send("switch-off");
		this.#twitch.action("Guesses are closed.");
	}

	nextRound() {
		if (this.#game.seed.state === "finished") {
			this.#processTotalScores();
		} else {
			this.#win.webContents.send("next-round", this.#game.isMultiGuess, this.#game.getLocation());
			this.#twitch.action(`🌎 Round ${this.#game.round} has started`);
			this.openGuesses();
		}
	}

	async #processTotalScores() {
		const totalScores = this.#game.getTotalScores();
		const locations = this.#game.getLocations();
		const link = await GameHelper.makeLink(settings.channelName, this.#game.mapName, this.#game.mode, locations, totalScores);
		this.#win.webContents.send("show-final-results", totalScores);
		await this.#twitch.action(
			`🌎 Game finished. Congrats ${flags.getEmoji(totalScores[0].flag)} ${totalScores[0].username} 🏆! ${link != undefined ? `Game summary: ${link}` : ""}`
		);
	}

	/**
	 * @param {{ lat: number, lng: number }} location
	 * @param {Guess[]} scores
	 */
	#showResults(location, scores) {
		const round = this.#game.seed.state === "finished" ? this.#game.round : this.#game.round - 1;
		this.#win.webContents.send("show-round-results", round, location, scores);
		this.#twitch.action(`🌎 Round ${round} has finished. Congrats ${flags.getEmoji(scores[0].flag)} ${scores[0].username} !`);
	}

	init() {
		// Browser Listening
		this.#win.webContents.on("did-navigate-in-page", (e, url) => {
			if (GameHelper.isGameURL(url)) {
				this.#game
					.start(url, settings.isMultiGuess)
					.then(() => {
						const guesses = this.#game.isMultiGuess ? this.#game.getMultiGuesses() : this.#game.getRoundScores();
						this.#win.webContents.send("game-started", this.#game.isMultiGuess, guesses, this.#game.getLocation());

						if (guesses.length > 0) {
							this.#twitch.action(`🌎 Round ${this.#game.round} has resumed`);
						} else if (this.#game.round === 1) {
							this.#twitch.action(`🌎 A new seed of ${this.#game.mapName} has started`);
						} else {
							this.#twitch.action(`🌎 Round ${this.#game.round} has started`);
						}

						this.openGuesses();
					})
					.catch((error) => {
						console.error(error);
					});
			} else {
				this.#game.outGame();
				this.#win.webContents.send("game-quitted");
			}
		});

		this.#win.webContents.on("did-frame-finish-load", () => {
			if (!this.#game.isInGame) return;
			this.#win.webContents.send("refreshed-in-game", settings.noCompass);
			// Checks and update seed when the this.game has refreshed
			// update the current location if it was skipped
			// if the streamer has guessed returns scores
			this.#game.refreshSeed().then((scores) => {
				if (scores) {
					this.#showResults(scores.location, scores.scores);
				}
			});

			this.#win.webContents.executeJavaScript(`
				window.nextRoundBtn = document.querySelector('[data-qa="close-round-result"]');
				if (window.nextRoundBtn) {
					nextRoundBtn.addEventListener("click", () => {
						nextRoundBtn.setAttribute('disabled', 'disabled');
						chatguessrApi.startNextRound();
					});
				}
			`);
		});

		ipcMain.on("next-round-click", () => {
			this.nextRound();
		});

		ipcMain.on("open-guesses", () => {
			this.openGuesses();
		});

		ipcMain.on("close-guesses", () => {
			this.closeGuesses();
		});

		ipcMain.on("game-form", (e, isMultiGuess, noCar, noCompass) => {
			this.#win.webContents.send("game-settings-change", noCompass);
			this.#settingsWindow?.hide();

			if (settings.noCar != noCar) this.#win.reload();

			settings.setGameSettings(isMultiGuess, noCar, noCompass);
		});

		ipcMain.on("twitch-commands-form", (e, commands) => {
			this.#settingsWindow?.hide();
			settings.setTwitchCommands(commands);
		});

		ipcMain.on("twitch-settings-form", (e, channelName, botUsername, token) => {
			settings.setTwitchSettings(channelName, botUsername, token);
			this.#initTmi();
		});

		ipcMain.on("closeSettings", () => {
			this.closeSettingsWindow();
		});

		ipcMain.on("openSettings", () => {
			this.openSettingsWindow();
		});

		ipcMain.on("clearStats", () => {
			store.delete("users"); // from pre-sqlite chatguessr versions
			store.delete("lastRoundPlayers"); // from even older versions
			this.#twitch.action("All stats cleared 🗑️");
		});
	}

	async #initTmi() {
		if (this.#twitch && this.#twitch.client.readyState() === "OPEN") {
			this.#twitch.client.disconnect();
		}
		if (!settings.channelName) {
			return;
		}

		this.#twitch = new TwitchClient(settings.channelName, settings.botUsername, settings.token);

		this.#tmiListening();

		try {
			await this.#twitch.client.connect();
		} catch (error) {
			if (this.#settingsWindow) {
				this.#settingsWindow.webContents.send("twitch-error", error);
			}
			console.error(error);
		}
	}

	/**
	 *
	 * @param {string} from
	 * @param {import("tmi.js").ChatUserstate} userstate
	 * @param {string} message
	 * @param {boolean} self
	 */
	async #handleGuess(from, userstate, message, self) {
		if (self || !message.startsWith("!g") || !this.#game.guessesOpen) return;

		const location = GameHelper.parseCoordinates(message.replace(/^!g\s+/, ""));

		if (!location) return;

		try {
			const guess = await this.#game.handleUserGuess(userstate, location);

			if (!this.#game.isMultiGuess) {
				this.#win.webContents.send("render-guess", guess);
				if (settings.showHasGuessed) {
					await this.#twitch.say(`${flags.getEmoji(guess.flag)} ${userstate["display-name"]} guessed`);
				}
			} else {
				const guesses = this.#game.getMultiGuesses();
				this.#win.webContents.send("render-multiguess", guesses);
				if (!guess.modified) {
					if (settings.showHasGuessed) {
						await this.#twitch.say(`${flags.getEmoji(guess.flag)} ${userstate["display-name"]} guessed`);
					}
				} else {
					await this.#twitch.say(`${flags.getEmoji(guess.flag)} ${userstate["display-name"]} guess changed`);
				}
			}
		} catch (err) {
			if (err.code === "alreadyGuessed") {
				await this.#twitch.say(`${userstate["display-name"]} you already guessed`);
			} else if (err.code === "pastedPreviousGuess") {
				await this.#twitch.say(`${userstate["display-name"]} you pasted your previous guess :)`);
			} else {
				console.error(err);
			}
		}
	}

	/**
	 *
	 * @param {string} channel
	 * @param {import("tmi.js").ChatUserstate} userstate
	 * @param {string} message
	 * @param {boolean} self
	 */
	async #handleMessage(channel, userstate, message, self) {
		if (self || !message.startsWith("!")) return;
		message = message.toLowerCase();

		const userId = userstate.badges?.broadcaster === "1" ? "BROADCASTER" : userstate["user-id"];

		if (message === settings.userGetStatsCmd) {
			const userInfo = legacyStoreFacade.getUserStats(this.#db, userId, userstate.username);
			if (!userInfo) {
				await this.#twitch.say(`${userstate["display-name"]} you've never guessed yet.`);
			} else {
				await this.#twitch.say(`
					${flags.getEmoji(userInfo.flag)} ${userInfo.username} : Current streak: ${userInfo.streak}.
					Best streak: ${userInfo.bestStreak}.
					Correct countries: ${userInfo.correctGuesses}/${userInfo.nbGuesses}${
					userInfo.nbGuesses > 0 ? ` (${((userInfo.correctGuesses / userInfo.nbGuesses) * 100).toFixed(2)}%).` : "."
				}
					Avg. score: ${Math.round(userInfo.meanScore)}.
					Victories: ${userInfo.victories}.
					Perfects: ${userInfo.perfects}.
				`);
			}
			return;
		}

		if (message === settings.cgCmd && settings.cgCmd !== "") {
			await this.#twitch.say(settings.cgMsg);
			return;
		}

		if (message === "!best") {
			const { streak, victories, perfects } = legacyStoreFacade.getGlobalStats(this.#db);
			if (!streak && !victories && !perfects) {
				await this.#twitch.say("No stats available.");
			} else {
				let msg = "";
				if (streak) {
					msg += `Streak: ${streak.streak} (${streak.username}). `;
				}
				if (victories) {
					msg += `Victories: ${victories.victories} (${victories.username}). `;
				}
				if (perfects) {
					msg += `Perfects: ${perfects.perfects} (${perfects.username}). `;
				}
				await this.#twitch.say(`Channels best: ${msg}`);
			}
			return;
		}

		if (message.startsWith("!flag")) {
			const countryReq = message.substr(message.indexOf(" ") + 1);
			const { dbUser } = legacyStoreFacade.getOrMigrateUser(this.#db, userId, userstate.username, userstate["display-name"]);

			let newFlag;
			if (countryReq === "none") {
				newFlag = null;
			} else if (countryReq === "random") {
				newFlag = flags.randomCountryFlag();
			} else {
				newFlag = flags.selectFlag(countryReq);
				if (!newFlag) {
					await this.#twitch.say(`${userstate["display-name"]} no flag found`);
					return;
				}
			}

			this.#db.setUserFlag(dbUser.id, newFlag);

			if (countryReq === "none") {
				await this.#twitch.say(`${userstate["display-name"]} flag removed`);
			} else if (countryReq === "random") {
				await this.#twitch.say(`${userstate["display-name"]} got ${flags.getEmoji(newFlag)}`);
			}
			return;
		}

		if (message === settings.userClearStatsCmd) {
			// @ts-ignore
			store.delete(`users.${userstate.username}`);

			const dbUser = this.#db.getUser(userId);
			if (dbUser) {
				this.#db.resetUserStats(dbUser.id);
				await this.#twitch.say(`${flags.getEmoji(dbUser.flag)} ${userstate["display-name"]} 🗑️ stats cleared !`);
			} else {
				await this.#twitch.say(`${userstate["display-name"]} you've never guessed yet.`);
			}

			return;
		}

		// streamer commands
		if (userstate.badges?.broadcaster !== "1") {
			return;
		}

		if (message.startsWith(settings.setStreakCmd)) {
			const msgArr = message.split(" ");
			if (msgArr.length != 3) {
				await this.#twitch.action(`Valid command: ${settings.setStreakCmd} user 42`);
				return;
			}

			const newStreak = parseInt(msgArr[2]);
			if (!Number.isInteger(newStreak)) {
				await this.#twitch.action(`Invalid number.`);
				return;
			}
			if (msgArr[1].charAt(0) === "@") msgArr[1] = msgArr[1].substring(1);

			const username = msgArr[1];
			await this.#twitch.action(`cannot set streak for ${username}: functionality currently not supported`);
		}
		// else if (message.startsWith("!spamguess")) {
		// 	const max = parseInt(message.split(" ")[1] ?? "50", 10);
		// 	for (let i = 0; i < max; i += 1) {
		// 		const lat = Math.random() * 180 - 90;
		// 		const lng = Math.random() * 360 - 180;
		// 		await this.#handleGuess(
		// 			`fake_${i}`,
		// 			{
		// 				"user-id": `123450${i}`,
		// 				username: `fake_${i}`,
		// 				"display-name": `fake_${i}`,
		// 				color: `#${Math.random().toString(16).slice(2, 8).padStart(6, "0")}`,
		// 			},
		// 			`!g ${lat},${lng}`,
		// 			false
		// 		);
		// 	}
		// }
	}

	ioInit() {
		socket.on("connection", () => {
			console.log("Connected to socket !");
		});

		socket.on("guess", async (userData, guess) => {
			const self = userData.username == settings.channelName;
			await this.#handleGuess(null, userData, guess, self);
		});
	}

	#tmiListening() {
		this.#twitch.client.on("connected", () => {
			socket.emit("join", settings.botUsername);

			if (this.#settingsWindow) {
				this.#settingsWindow.webContents.send("twitch-connected", settings.botUsername);
			}
			this.#twitch.action("is now connected");
		});
		this.#twitch.client.on("disconnected", () => {
			if (this.#settingsWindow) {
				this.#settingsWindow.webContents.send("twitch-disconnected");
			}
		});

		this.#twitch.client.on("whisper", (from, userstate, message, self) => {
			this.#handleGuess(from, userstate, message, self).catch((error) => {
				console.error(error);
			});
		});

		this.#twitch.client.on("message", (channel, userstate, message, self) => {
			this.#handleMessage(channel, userstate, message, self).catch((error) => {
				console.error(error);
			});
		});
	}

	openSettingsWindow() {
		// Initialise the window if it doesn't exist,
		// especially important in non-windows systems where Chatguessr may not be able
		// to prevent the window from being completely closed.
		this.#settingsWindow ??= createSettingsWindow(this.#win).on('closed', () => {
			this.#settingsWindow = undefined;
		});

		this.#settingsWindow.webContents.send("render-settings", settings, this.#twitch?.client ? this.#twitch.client.readyState() : "");
		this.#settingsWindow.show();
	}

	closeSettingsWindow() {
		this.#settingsWindow?.close();
	}
}

module.exports = GameHandler;
